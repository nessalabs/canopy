//! `canopywt run` — the foreground supervisor.
//!
//! [`crate::service::up`] starts services and returns; this blocks, keeps them alive, and stops
//! them cleanly when the caller says so. Restart policy and continuous polling live here and
//! nowhere else, on purpose: an agent or a Makefile wants fire-and-forget, a human at a terminal
//! or a CI job wants a process to babysit, and conflating the two is exactly what forces a
//! daemon into existence. `up` has no restart policy because nothing would be left running to
//! honour it.
//!
//! Four decisions carry the module:
//!
//! - **A failing health check is reported, never acted on.** Restarting an unhealthy service
//!   sounds obviously right and is the single most dangerous thing a supervisor can do: a check
//!   with a subtle mistake in it — a `localhost` that resolves to `::1` first on macOS while the
//!   service listens on IPv4 — never passes, so the supervisor kills a perfectly healthy service
//!   every few seconds forever and the user cannot tell why. Health answers "is it serving?",
//!   liveness answers "is it there?", and only the second one is allowed to kill anything.
//! - **The crash-loop budget.** Restart-with-backoff alone still means a command with a typo in
//!   it restarts every 30 seconds for the rest of the day, burning a core and a gigabyte of log.
//!   After [`Budget::restarts`] restarts inside [`Budget::window`] the service is `failed` and is
//!   left alone: a command that has failed five times in a minute is not going to succeed on the
//!   sixth, and the user needs to read the log, not watch it grow.
//! - **`run` reaps its children; `up` must not.** `run` is the parent of every service it starts,
//!   so a service that exits becomes a zombie until somebody calls `waitpid`. That call is also
//!   the *only* place an exit status can be read, which is what makes `restart: on-failure`
//!   possible at all — see [`observe_exit`]. `up` exits seconds after spawning, which reparents
//!   its children to init; init reaps them, and an `up` that waited would only be waiting for a
//!   service it is about to walk away from.
//! - **No signal handler in here.** `run` takes a `should_stop` flag and a [`Clock`]. A library
//!   that installed a `SIGINT` handler would steal it from every embedder, and tests of a
//!   supervisor that owned real signals and real time would be slow and flaky. The binary owns
//!   the handler; this owns what to do when it fires.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use camino::Utf8PathBuf;
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
use nix::unistd::Pid;
use serde::Serialize;

use crate::config::{Duration, RestartPolicy, ServiceSpec};
use crate::env::interpolate;
use crate::health::{self, Clock, ResolvedHealth, Tracker};
use crate::proc::{self, ProcessRecord, ProcessState};
use crate::service::{self, RunState, ServiceContext, ServiceError, ServiceStatus, record_path};

/// How often the loop looks at its services when the caller does not say.
///
/// A tenth of a second would notice a crash sooner and cost a `waitpid` per service per tick for
/// no benefit a human can perceive; a second would leave a Ctrl-C hanging long enough to press
/// it again.
pub const DEFAULT_POLL: Duration = Duration::from_millis(250);

/// The most a restart delay may be doubled.
///
/// Not a tuning knob: `1u64 << 64` is not an enormous number, it is a panic, and a service that
/// has been restarting for a very long time must not be the thing that finds that out.
const MAX_DOUBLINGS: u32 = u64::BITS - 1;

// ---------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------

/// Wait 1s, then 2s, 4s, 8s … up to 30s.
///
/// Exponential because the two failures worth distinguishing need opposite treatment: a port
/// held for a moment by the previous run wants a retry now, and a missing binary wants the
/// supervisor to get out of the way. Doubling serves the first and decays into the second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    pub base: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Backoff {
        Backoff { base: Duration::from_secs(1), max: Duration::from_secs(30) }
    }
}

/// At most `restarts` restarts inside `window`, then the service is failed for good.
///
/// Rolling rather than cumulative: five restarts over an afternoon is a flaky service worth
/// keeping alive, and five in a minute is a command that cannot start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub restarts: u32,
    pub window: Duration,
}

impl Default for Budget {
    fn default() -> Budget {
        Budget { restarts: 5, window: Duration::from_secs(60) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuperviseOptions {
    /// `false` is `--no-restart`: watch and report, but leave every exit alone. A master switch
    /// over the per-service policy, for the run where you want to see what dies.
    pub restart: bool,
    pub poll: Duration,
    pub backoff: Backoff,
    pub budget: Budget,
}

impl Default for SuperviseOptions {
    /// Restart per policy, poll at [`DEFAULT_POLL`], with the default backoff and budget.
    ///
    /// Not derived: a derived `restart: false` and `poll: 0ms` would be a supervisor that
    /// spins without supervising, which is the last thing a forgotten `..Default::default()`
    /// should produce.
    fn default() -> SuperviseOptions {
        SuperviseOptions { restart: true, poll: DEFAULT_POLL, backoff: Backoff::default(), budget: Budget::default() }
    }
}

// ---------------------------------------------------------------------------------------
// What a caller sees
// ---------------------------------------------------------------------------------------

/// How a service finished.
///
/// `Unknown` is not a failure to report it: it is what is left when the process was collected by
/// something other than our `waitpid` — most often [`crate::service::up`]'s own start grace,
/// which watches a freshly spawned process breathe and so reaps anything that dies in its first
/// fraction of a second.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "exit", rename_all = "snake_case")]
pub enum Exit {
    Code { code: i32 },
    Signal { signal: i32 },
    Unknown,
}

impl Exit {
    /// Everything except a clean `exit 0`.
    ///
    /// An unrecorded status counts as a failure. A service that vanished before anyone could
    /// read its status had, by definition, not settled, and the alternative — calling it a clean
    /// finish — means `restart: on-failure` silently never restarts the crash that matters most:
    /// the one that happens immediately, every time.
    pub fn is_failure(self) -> bool {
        !matches!(self, Exit::Code { code: 0 })
    }
}

impl fmt::Display for Exit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Exit::Code { code } => write!(f, "code {code}"),
            Exit::Signal { signal } => write!(f, "signal {signal}"),
            Exit::Unknown => f.write_str("an unrecorded status"),
        }
    }
}

/// A state change, as it happens.
///
/// Streamed through a callback rather than returned in a list because the whole point of `run`
/// is that somebody is watching: a restart the user learns about when the command finally exits
/// is a restart they could not have acted on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Started { name: String, pid: i32 },
    Healthy { name: String },
    Unhealthy { name: String, detail: String },
    Exited { name: String, status: Exit },
    Restarting { name: String, attempt: u32, delay_ms: u64 },
    GaveUp { name: String, restarts: u32 },
    Stopped { name: String },
}

impl fmt::Display for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Event::Started { name, pid } => write!(f, "{name} started, pid {pid}"),
            Event::Healthy { name } => write!(f, "{name} is healthy"),
            Event::Unhealthy { name, detail } => write!(f, "{name} is unhealthy: {detail}"),
            Event::Exited { name, status } => write!(f, "{name} exited with {status}"),
            Event::Restarting { name, attempt, delay_ms } => {
                write!(f, "{name} restarting in {delay_ms}ms, attempt {attempt}")
            }
            Event::GaveUp { name, restarts } => write!(f, "{name} gave up after {restarts} restarts"),
            Event::Stopped { name } => write!(f, "{name} stopped"),
        }
    }
}

/// What the whole run came to.
#[derive(Debug, Clone, Serialize)]
pub struct SuperviseOutcome {
    /// Every service in dependency order, as it stood once everything was stopped.
    pub services: Vec<ServiceStatus>,
    pub restarts: u32,
}

// ---------------------------------------------------------------------------------------
// The pure arithmetic
// ---------------------------------------------------------------------------------------

/// The delay before restart number `attempt` (1-based).
fn backoff_delay(attempt: u32, backoff: &Backoff) -> Duration {
    let doublings = attempt.saturating_sub(1).min(MAX_DOUBLINGS);
    let delay = backoff.base.as_millis().saturating_mul(1u64 << doublings);
    Duration::from_millis(delay.min(backoff.max.as_millis()))
}

/// Whether a policy restarts *this* exit.
fn restarts_on(policy: RestartPolicy, exit: Exit) -> bool {
    match policy {
        RestartPolicy::Never => false,
        RestartPolicy::OnFailure => exit.is_failure(),
        RestartPolicy::Always => true,
    }
}

/// One service's restart history: the backoff's position and the crash-loop budget's window.
#[derive(Debug, Clone, Default)]
struct Restarts {
    /// Consecutive restarts, which is what the delay doubles on.
    attempts: u32,
    /// Every restart this run, for the outcome.
    total: u32,
    /// When each recent restart was scheduled.
    window: Vec<u64>,
}

impl Restarts {
    /// Books a restart and says how long to wait, or `None` when the budget is spent.
    ///
    /// `uptime` is how long the incarnation that just died had been running. A service that
    /// outlived the longest delay we would ever impose has demonstrably *started*, so whatever
    /// killed it is a new problem and gets the short delay again — without that, one bad morning
    /// leaves a service on a 30-second leash for the rest of the day.
    fn schedule(&mut self, now: u64, uptime: Duration, opts: &SuperviseOptions) -> Option<Duration> {
        self.window.retain(|at| now.saturating_sub(*at) < opts.budget.window.as_millis());
        if self.window.len() as u32 >= opts.budget.restarts {
            return None;
        }
        if uptime >= opts.backoff.max {
            self.attempts = 0;
        }
        self.window.push(now);
        self.attempts = self.attempts.saturating_add(1);
        self.total = self.total.saturating_add(1);
        Some(backoff_delay(self.attempts, &opts.backoff))
    }
}

// ---------------------------------------------------------------------------------------
// Watching a process
// ---------------------------------------------------------------------------------------

/// The pid we may `waitpid` for, which is to say a positive one.
///
/// `waitpid(0)` means "any child in my process group" and `waitpid(-1)` means "any child at
/// all". Either would collect — and silently discard — the exit status of a process this
/// supervisor knows nothing about, which for an embedder is somebody else's child.
fn child(pid: i32) -> Option<Pid> {
    (pid > 0).then(|| Pid::from_raw(pid))
}

/// Whether the process behind `record` has finished, and how.
///
/// `waitpid` comes first, and that ordering is the whole function. It is the only way to read an
/// exit *status*, which is what `restart: on-failure` is made of, and it collects the zombie in
/// the same call — [`crate::proc::state`] also reaps, but throws the status away, so asking it
/// first would leave every exit `Unknown`.
///
/// The fallback is for a service `run` did not spawn: one an earlier `up` left running and this
/// process has adopted. It is nobody's child here, `waitpid` says `ECHILD`, and the kernel can
/// still say whether it is alive — just not how it ended.
fn observe_exit(record: &ProcessRecord) -> Option<Exit> {
    if let Some(pid) = child(record.pid) {
        match waitpid(pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(_, code)) => return Some(Exit::Code { code }),
            Ok(WaitStatus::Signaled(_, signal, _)) => return Some(Exit::Signal { signal: signal as i32 }),
            Ok(WaitStatus::StillAlive) => return None,
            Ok(_) | Err(_) => {}
        }
    }
    match proc::state(record) {
        ProcessState::Running { .. } => None,
        // Gone, or wearing a pid that belongs to somebody else now. Either way it is not running
        // and we never saw it finish.
        ProcessState::Exited | ProcessState::Stale => Some(Exit::Unknown),
    }
}

// ---------------------------------------------------------------------------------------
// Per-service state
// ---------------------------------------------------------------------------------------

/// Where one service is between two polls.
#[derive(Debug)]
enum Phase {
    /// Not supervised: an unsupported runtime, `autostart: false`, or a record we cannot read.
    Idle,
    Running {
        record: ProcessRecord,
        since: u64,
    },
    /// Exited, waiting out the backoff.
    Waiting {
        due: u64,
    },
    /// Exited and staying that way — the policy says so, or the restart itself failed.
    Exited,
    /// The crash-loop budget is spent. Terminal, and reported as `failed`.
    GaveUp,
}

/// A service's health check and how far its own poll loop has got.
#[derive(Debug)]
struct Check {
    resolved: ResolvedHealth,
    tracker: Tracker,
    probed_at: Option<u64>,
    /// What was last *reported*, so a check that keeps failing says so once rather than every
    /// interval for an hour.
    healthy: Option<bool>,
}

#[derive(Debug)]
struct Supervised<'a> {
    name: String,
    spec: &'a ServiceSpec,
    cwd: Utf8PathBuf,
    env: BTreeMap<String, String>,
    check: Option<Check>,
    phase: Phase,
    restarts: Restarts,
    /// The last status anything reported for this service, kept for the outcome.
    last: ServiceStatus,
}

impl<'a> Supervised<'a> {
    fn new(spec: &'a ServiceSpec, ctx: &ServiceContext<'_>, last: ServiceStatus) -> Supervised<'a> {
        // A check that cannot be resolved is a config error, and `up` has already refused to
        // start any service it spawned with one. Reaching this with an error in hand means an
        // adopted service whose check does not resolve — and the supervisor's job is to keep the
        // process alive, which a broken check must never be allowed to interfere with.
        let check = spec
            .health
            .as_ref()
            .and_then(|check| health::resolve(check, |text| interpolate(text, ctx.facts, ctx.env)).ok())
            .map(|resolved| Check {
                tracker: Tracker::new(&resolved.timing),
                resolved,
                probed_at: None,
                healthy: None,
            });
        Supervised {
            name: last.name.clone(),
            spec,
            cwd: service_cwd(spec, ctx),
            env: service_env(spec, ctx),
            check,
            phase: Phase::Idle,
            restarts: Restarts::default(),
            last,
        }
    }

    /// Takes the status a restart's `up` returned and becomes it.
    fn attach(
        &mut self,
        status: ServiceStatus,
        ctx: &ServiceContext<'_>,
        opts: &SuperviseOptions,
        now: u64,
        on_event: &mut dyn FnMut(Event),
    ) {
        self.last = status;
        self.adopt(ctx, opts, now, on_event);
    }

    /// Becomes whatever the last status says this service now is.
    fn adopt(&mut self, ctx: &ServiceContext<'_>, opts: &SuperviseOptions, now: u64, on_event: &mut dyn FnMut(Event)) {
        self.phase = match self.last.state {
            RunState::Running | RunState::Starting | RunState::Unhealthy => {
                match proc::read_record(&record_path(ctx.state, &self.name)) {
                    Ok(record) => {
                        if let Some(check) = &mut self.check {
                            // A fresh incarnation gets a fresh failure count and a fresh grace
                            // period: `start_period` is measured from *this* start, and a run of
                            // failures the last process accumulated says nothing about this one.
                            check.tracker = Tracker::new(&check.resolved.timing);
                            check.probed_at = None;
                            check.healthy = None;
                        }
                        on_event(Event::Started { name: self.name.clone(), pid: record.pid });
                        Phase::Running { record, since: now }
                    }
                    // `up` says it is running and the record that proves which process that is
                    // will not read. Supervising it would mean signalling a pid on trust.
                    Err(_) => Phase::Idle,
                }
            }
            // It did not survive its start grace, so `up` already collected it and the status it
            // went out with is gone. A spawn that failed outright is the same shape of problem.
            RunState::Exited | RunState::Failed => {
                on_event(Event::Exited { name: self.name.clone(), status: Exit::Unknown });
                self.decide(Exit::Unknown, now, Duration::ZERO, opts, on_event)
            }
            RunState::Stopped | RunState::Unsupported => Phase::Idle,
        };
    }

    /// What happens after an exit.
    fn decide(
        &mut self,
        exit: Exit,
        now: u64,
        uptime: Duration,
        opts: &SuperviseOptions,
        on_event: &mut dyn FnMut(Event),
    ) -> Phase {
        if !opts.restart || !restarts_on(self.spec.restart, exit) {
            return Phase::Exited;
        }
        match self.restarts.schedule(now, uptime, opts) {
            None => {
                on_event(Event::GaveUp { name: self.name.clone(), restarts: self.restarts.total });
                Phase::GaveUp
            }
            Some(delay) => {
                on_event(Event::Restarting {
                    name: self.name.clone(),
                    attempt: self.restarts.attempts,
                    delay_ms: delay.as_millis(),
                });
                Phase::Waiting { due: now.saturating_add(delay.as_millis()) }
            }
        }
    }

    /// Starts the service again, through the same `up` that started it the first time.
    fn start(
        &mut self,
        services: &BTreeMap<String, ServiceSpec>,
        ctx: &ServiceContext<'_>,
        opts: &SuperviseOptions,
        now: u64,
        on_event: &mut dyn FnMut(Event),
    ) {
        let only = BTreeSet::from([self.name.clone()]);
        match service::up(services, Some(&only), ctx, false) {
            Ok(statuses) => {
                if let Some(status) = statuses.into_iter().next() {
                    self.attach(status, ctx, opts, now, on_event);
                }
            }
            // A restart we cannot even attempt — state that will not write — is a failed
            // service, not a failed run: `run` still owes the caller a clean shutdown of
            // everything else it started.
            Err(error) => {
                on_event(Event::GaveUp { name: self.name.clone(), restarts: self.restarts.total });
                self.last.state = RunState::Failed;
                self.last.detail = Some(error.to_string());
                self.phase = Phase::Exited;
            }
        }
    }

    /// One poll: notice an exit, act on it, then ask the health check how it is doing.
    fn tick(
        &mut self,
        services: &BTreeMap<String, ServiceSpec>,
        ctx: &ServiceContext<'_>,
        opts: &SuperviseOptions,
        now: u64,
        on_event: &mut dyn FnMut(Event),
    ) {
        let gone = match &self.phase {
            Phase::Running { record, since } => observe_exit(record).map(|exit| (exit, *since)),
            _ => None,
        };
        if let Some((exit, since)) = gone {
            on_event(Event::Exited { name: self.name.clone(), status: exit });
            let uptime = Duration::from_millis(now.saturating_sub(since));
            self.phase = self.decide(exit, now, uptime, opts, on_event);
        }
        if let Phase::Waiting { due } = self.phase
            && now >= due
        {
            self.start(services, ctx, opts, now, on_event);
        }
        if let Phase::Running { since, .. } = self.phase {
            self.probe(now, since, on_event);
        }
    }

    /// Runs the health check if it is due, and reports a change of verdict.
    ///
    /// Reports. Nothing here can restart anything, and that is the module's load-bearing
    /// decision — see the module docs.
    fn probe(&mut self, now: u64, since: u64, on_event: &mut dyn FnMut(Event)) {
        let Some(check) = &mut self.check else {
            return;
        };
        let interval = check.resolved.timing.interval.as_millis();
        if check.probed_at.is_some_and(|at| now.saturating_sub(at) < interval) {
            return;
        }
        check.probed_at = Some(now);
        let probe = check.resolved.probe_once(&self.cwd, &self.env);
        // Measured from this incarnation's start, which is what makes `start_period` mean what
        // the config says it means.
        let elapsed = Duration::from_millis(now.saturating_sub(since));
        match check.tracker.record(elapsed, &probe) {
            health::Status::Healthy if check.healthy != Some(true) => {
                check.healthy = Some(true);
                on_event(Event::Healthy { name: self.name.clone() });
            }
            health::Status::Unhealthy { detail } if check.healthy != Some(false) => {
                check.healthy = Some(false);
                on_event(Event::Unhealthy { name: self.name.clone(), detail });
            }
            // Still inside the grace period, or a run of failures too short to condemn it. The
            // service has not changed its mind about anything yet.
            _ => {}
        }
    }

    /// The row this service ends the run with.
    fn report(self, stopped: Option<ServiceStatus>, opts: &SuperviseOptions) -> ServiceStatus {
        if matches!(self.phase, Phase::Idle) {
            return self.last;
        }
        let mut status = stopped.unwrap_or(self.last);
        if matches!(self.phase, Phase::GaveUp) {
            // `down` would call this one `stopped`, which is true and useless. The reason it is
            // not running is the only thing worth printing.
            status.state = RunState::Failed;
            status.detail = Some(format!("gave up after {} restarts in {}", self.restarts.total, opts.budget.window));
        }
        status
    }
}

// ---------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------

/// Starts services, keeps them alive, and stops them when `should_stop` says so.
///
/// Returns once every service has been stopped in reverse dependency order — dependents first,
/// so a database outlives the things talking to it. `should_stop` is read once per poll, and the
/// binary sets it from a `SIGINT`/`SIGTERM` handler; a library that installed one itself would
/// take the signal away from whatever embedded it.
///
/// `clock` is injected for the same reason: every interval in here is measured in it, so a test
/// drives an hour of backoff in a millisecond and asserts on exact numbers rather than on
/// whatever the machine happened to be doing.
pub fn run(
    services: &BTreeMap<String, ServiceSpec>,
    only: Option<&BTreeSet<String>>,
    ctx: &ServiceContext<'_>,
    opts: &SuperviseOptions,
    clock: &impl Clock,
    should_stop: &dyn Fn() -> bool,
    on_event: &mut dyn FnMut(Event),
) -> Result<SuperviseOutcome, ServiceError> {
    // `up` is the one that validates: an unknown `--only` name and a `depends_on` cycle both
    // come back from here, before anything has been started.
    let started = service::up(services, only, ctx, false)?;
    let now = clock.now();
    let mut watch: Vec<Supervised<'_>> = Vec::with_capacity(started.len());
    for status in started {
        let spec = &services[status.name.as_str()];
        let mut service = Supervised::new(spec, ctx, status);
        service.adopt(ctx, opts, now, on_event);
        watch.push(service);
    }

    while !should_stop() {
        let now = clock.now();
        for service in &mut watch {
            service.tick(services, ctx, opts, now, on_event);
        }
        clock.sleep(opts.poll);
    }

    finish(watch, services, only, ctx, opts, on_event)
}

/// Stops everything and assembles the outcome.
fn finish(
    watch: Vec<Supervised<'_>>,
    services: &BTreeMap<String, ServiceSpec>,
    only: Option<&BTreeSet<String>>,
    ctx: &ServiceContext<'_>,
    opts: &SuperviseOptions,
    on_event: &mut dyn FnMut(Event),
) -> Result<SuperviseOutcome, ServiceError> {
    let idle: BTreeSet<String> =
        watch.iter().filter(|s| matches!(s.phase, Phase::Idle)).map(|s| s.name.clone()).collect();
    // `down` stops in reverse dependency order and reports in the order it stopped things, so
    // the events go out in the order they actually happened.
    let stopped = service::down(services, only, ctx)?;
    for status in &stopped {
        if !idle.contains(&status.name) {
            on_event(Event::Stopped { name: status.name.clone() });
        }
    }

    let mut by_name: BTreeMap<String, ServiceStatus> =
        stopped.into_iter().map(|status| (status.name.clone(), status)).collect();
    let mut restarts = 0u32;
    let mut out = Vec::with_capacity(watch.len());
    for service in watch {
        restarts = restarts.saturating_add(service.restarts.total);
        let stopped = by_name.remove(&service.name);
        out.push(service.report(stopped, opts));
    }
    Ok(SuperviseOutcome { services: out, restarts })
}

// ---------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------

/// Where a health `cmd:` runs, which is wherever the service itself runs.
fn service_cwd(spec: &ServiceSpec, ctx: &ServiceContext<'_>) -> Utf8PathBuf {
    match &spec.cwd {
        Some(cwd) => ctx.worktree.join(cwd),
        None => ctx.worktree.to_owned(),
    }
}

/// The environment a health `cmd:` sees: the worktree's table with the service's own `env:` on
/// top, so a check written as `curl localhost:$PORT` reads the same `PORT` the service was given.
fn service_env(spec: &ServiceSpec, ctx: &ServiceContext<'_>) -> BTreeMap<String, String> {
    let mut env = ctx.env.to_map();
    for (key, value) in &spec.env {
        env.insert(key.clone(), interpolate(value, ctx.facts, ctx.env));
    }
    env
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::fs;
    use std::process::Command;
    use std::time::Instant as TestInstant;

    use camino::Utf8PathBuf;
    use rstest::rstest;
    use tempfile::TempDir;

    use super::*;
    use crate::config::CanopyConfig;
    use crate::env::{self, EnvTable, Facts};

    // -----------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------

    /// A ceiling on how long a test waits for something the OS does on its own schedule.
    const PATIENCE: std::time::Duration = std::time::Duration::from_secs(10);

    /// The hard ceiling on how many polls any one run is allowed.
    ///
    /// A bug that stops the loop making progress has to fail a test rather than stall the suite,
    /// and a count is the right ceiling for that where a stopwatch is not: it does not move when
    /// the machine is busy, so it cannot turn a slow build into a failing test.
    const MAX_POLLS: u32 = 600;

    /// How long a stop condition waits for the event it is about before giving up.
    ///
    /// Wall-clock, unlike the poll ceiling, because what it waits for is a real process starting
    /// or dying and that takes the time it takes however the virtual clock is set. Generous
    /// enough that a busy machine does not fail a passing test, short enough that a mutant which
    /// stops the event ever arriving fails in seconds — and reached before [`MAX_POLLS`], so the
    /// test fails on the assertion it is about rather than on running out of polls.
    const GIVE_UP: std::time::Duration = std::time::Duration::from_secs(8);

    /// What one virtual poll costs in real time.
    ///
    /// The clock below is virtual, so the backoff and budget arithmetic is exact and a test can
    /// assert on the millisecond. The services are real processes that need wall-clock time to
    /// start and to die, so each poll also spends a few real milliseconds letting them. The two
    /// scales are deliberately unrelated: a test picks `poll` for the arithmetic it wants and a
    /// poll count for how long it is willing to wait.
    const TICK: std::time::Duration = std::time::Duration::from_millis(5);

    /// A virtual clock with a real heartbeat. See [`TICK`].
    #[derive(Debug)]
    struct TestClock {
        millis: Cell<u64>,
    }

    impl TestClock {
        fn new() -> TestClock {
            TestClock { millis: Cell::new(0) }
        }
    }

    impl Clock for TestClock {
        fn now(&self) -> u64 {
            self.millis.get()
        }

        fn sleep(&self, nap: Duration) {
            self.millis.set(self.millis.get().saturating_add(nap.as_millis()));
            std::thread::sleep(TICK);
        }
    }

    /// A worktree and a state directory in a temp dir, plus the environment a service would see.
    struct Harness {
        _dir: TempDir,
        worktree: Utf8PathBuf,
        state: Utf8PathBuf,
        ports: BTreeMap<String, u16>,
        env: EnvTable,
    }

    impl Harness {
        fn new() -> Harness {
            let dir = TempDir::new().expect("temp dir");
            let root = Utf8PathBuf::from_path_buf(dir.path().to_path_buf()).expect("utf-8 temp dir");
            let worktree = root.join("wt");
            let state = root.join("state");
            fs::create_dir_all(worktree.join("sub")).expect("worktree");
            let ports = BTreeMap::new();
            let table = {
                let facts = Facts {
                    worktree_name: "wt",
                    worktree_path: &worktree,
                    branch: "feature/x",
                    project: "proj",
                    project_path: &worktree,
                    ports: &ports,
                };
                env::resolve(&CanopyConfig::empty(), &facts, &BTreeMap::new())
            };
            Harness { _dir: dir, worktree, state, ports, env: table }
        }

        fn facts(&self) -> Facts<'_> {
            Facts {
                worktree_name: "wt",
                worktree_path: &self.worktree,
                branch: "feature/x",
                project: "proj",
                project_path: &self.worktree,
                ports: &self.ports,
            }
        }

        fn ctx<'a>(&'a self, facts: &'a Facts<'a>) -> ServiceContext<'a> {
            ServiceContext { worktree: &self.worktree, state: &self.state, env: &self.env, facts }
        }

        fn record(&self, name: &str) -> ProcessRecord {
            proc::read_record(&record_path(&self.state, name)).expect("record")
        }

        /// Tells an [`on_cue`] service to exit.
        fn cue(&self) {
            fs::write(self.worktree.join("die"), "").expect("cue");
        }
    }

    fn specs(yaml: &str) -> BTreeMap<String, ServiceSpec> {
        serde_saphyr::from_str(yaml).expect("test services parse")
    }

    /// A service that stays up until the test tells it to go, then exits with `code`.
    ///
    /// Long-lived on purpose. `up` watches a freshly spawned process for
    /// [`crate::service::ALIVE_GRACE`] and collects anything that dies inside that window, taking
    /// the exit status with it — so a test *about* exit statuses has to outlive the grace, and
    /// one that raced a `sleep` against it would be flaky by construction.
    fn on_cue(code: i32, restart: &str) -> BTreeMap<String, ServiceSpec> {
        specs(&format!("\nweb:\n  run: \"until [ -f die ]; do sleep 0.05; done; exit {code}\"\n  restart: {restart}\n"))
    }

    /// A service that is gone before `up` stops watching, so its status is never recorded.
    fn instantly(code: i32, restart: &str) -> BTreeMap<String, ServiceSpec> {
        specs(&format!("\nweb:\n  run: \"exit {code}\"\n  restart: {restart}\n"))
    }

    fn options(poll_ms: u64) -> SuperviseOptions {
        SuperviseOptions { poll: Duration::from_millis(poll_ms), ..SuperviseOptions::default() }
    }

    /// One run of the supervisor, with every event stamped with the clock it happened on.
    struct Session {
        outcome: SuperviseOutcome,
        events: Vec<(u64, Event)>,
    }

    impl Session {
        fn kinds(&self) -> Vec<Event> {
            self.events.iter().map(|(_, event)| event.clone()).collect()
        }

        fn count(&self, pick: fn(&Event) -> bool) -> usize {
            self.events.iter().filter(|(_, event)| pick(event)).count()
        }

        /// The services named by every matching event, in the order they were emitted.
        fn named(&self, pick: fn(&Event) -> bool) -> Vec<&str> {
            self.events.iter().filter(|(_, event)| pick(event)).map(|(_, event)| name_of(event)).collect()
        }
    }

    fn name_of(event: &Event) -> &str {
        match event {
            Event::Started { name, .. }
            | Event::Healthy { name }
            | Event::Unhealthy { name, .. }
            | Event::Exited { name, .. }
            | Event::Restarting { name, .. }
            | Event::GaveUp { name, .. }
            | Event::Stopped { name } => name,
        }
    }

    fn is_started(event: &Event) -> bool {
        matches!(event, Event::Started { .. })
    }

    fn is_healthy(event: &Event) -> bool {
        matches!(event, Event::Healthy { .. })
    }

    fn is_unhealthy(event: &Event) -> bool {
        matches!(event, Event::Unhealthy { .. })
    }

    fn is_exited(event: &Event) -> bool {
        matches!(event, Event::Exited { .. })
    }

    fn is_restarting(event: &Event) -> bool {
        matches!(event, Event::Restarting { .. })
    }

    fn is_gave_up(event: &Event) -> bool {
        matches!(event, Event::GaveUp { .. })
    }

    fn is_stopped(event: &Event) -> bool {
        matches!(event, Event::Stopped { .. })
    }

    /// Stops after exactly `n` polls.
    fn polls(n: u32) -> impl Fn(&[(u64, Event)], u32) -> bool {
        move |_, count| count > n
    }

    /// Stops `grace` polls after `pick` first matched — long enough to prove nothing follows it —
    /// or after [`GIVE_UP`] if it never matches at all.
    fn settles(pick: fn(&Event) -> bool, grace: u32) -> impl Fn(&[(u64, Event)], u32) -> bool {
        let seen: Cell<Option<u32>> = Cell::new(None);
        let deadline = TestInstant::now() + GIVE_UP;
        move |events, count| {
            if seen.get().is_none() && events.iter().any(|(_, event)| pick(event)) {
                seen.set(Some(count));
            }
            TestInstant::now() >= deadline || seen.get().is_some_and(|at| count >= at.saturating_add(grace))
        }
    }

    /// Runs the supervisor over `services` until `stop` says the point is made.
    ///
    /// `react` runs *before* the event is recorded, which is how a test arranges the world at a
    /// known moment — telling a service to exit the instant it is reported healthy, say, rather
    /// than hoping a sleep lands in the right place.
    fn supervise(
        harness: &Harness,
        services: &BTreeMap<String, ServiceSpec>,
        opts: &SuperviseOptions,
        mut react: impl FnMut(&Event),
        stop: impl Fn(&[(u64, Event)], u32) -> bool,
    ) -> Session {
        let clock = TestClock::new();
        let events: RefCell<Vec<(u64, Event)>> = RefCell::new(Vec::new());
        let polls = Cell::new(0u32);
        let should_stop = || {
            polls.set(polls.get().saturating_add(1));
            polls.get() > MAX_POLLS || stop(&events.borrow(), polls.get())
        };
        let mut on_event = |event: Event| {
            react(&event);
            events.borrow_mut().push((clock.now(), event));
        };
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let outcome = run(services, None, &ctx, opts, &clock, &should_stop, &mut on_event).expect("run");
        assert!(polls.get() <= MAX_POLLS, "the run hit its ceiling of {MAX_POLLS} polls, not its stop condition");
        Session { outcome, events: events.into_inner() }
    }

    /// Polls `condition` until it holds or [`PATIENCE`] runs out.
    fn eventually(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = TestInstant::now() + PATIENCE;
        while TestInstant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        condition()
    }

    /// Every pid currently in a process group, asked of the kernel rather than of the code under
    /// test.
    fn group_members(pgid: i32) -> Vec<i32> {
        let output = Command::new("ps").args(["-A", "-o", "pid=,pgid="]).output().expect("ps");
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid: i32 = fields.next()?.parse().ok()?;
                let group: i32 = fields.next()?.parse().ok()?;
                (group == pgid).then_some(pid)
            })
            .collect()
    }

    /// Which of `pids` are `<defunct>` — exited, and nobody collected them.
    ///
    /// Asked about named pids rather than about every child of this process: the suite runs its
    /// tests as threads in one process, so "our children" includes every other test's services
    /// and a count of them would be somebody else's timing.
    fn zombies_among(pids: &[i32]) -> Vec<i32> {
        let output = Command::new("ps").args(["-A", "-o", "pid=,stat="]).output().expect("ps");
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid: i32 = fields.next()?.parse().ok()?;
                let zombie = fields.next().is_some_and(|stat| stat.starts_with('Z'));
                (zombie && pids.contains(&pid)).then_some(pid)
            })
            .collect()
    }

    fn started_pid(session: &Session) -> i32 {
        session
            .events
            .iter()
            .find_map(|(_, event)| match event {
                Event::Started { pid, .. } => Some(*pid),
                _ => None,
            })
            .expect("a Started event")
    }

    // -----------------------------------------------------------------------------------
    // Restart policy
    // -----------------------------------------------------------------------------------

    #[test]
    fn restarts_a_service_that_exits_nonzero_under_on_failure() {
        let harness = Harness::new();
        let services = on_cue(7, "on-failure");
        let opts = SuperviseOptions {
            backoff: Backoff { base: Duration::from_millis(500), max: Duration::from_secs(30) },
            ..options(100)
        };

        let session = supervise(
            &harness,
            &services,
            &opts,
            |event| {
                if is_started(event) {
                    harness.cue();
                }
            },
            settles(is_restarting, 0),
        );

        let kinds = session.kinds();
        assert!(matches!(kinds[0], Event::Started { .. }), "{kinds:?}");
        // A real code, not `Unknown`: only our own `waitpid` can produce one, so this is also
        // the proof that `run` reaps what it starts.
        assert_eq!(kinds[1], Event::Exited { name: "web".to_owned(), status: Exit::Code { code: 7 } });
        assert_eq!(kinds[2], Event::Restarting { name: "web".to_owned(), attempt: 1, delay_ms: 500 });
        assert_eq!(session.outcome.restarts, 1);
        // This one outlived `up`'s start grace, so nothing but our own `waitpid` can have
        // collected it — and it did, or the pid would still be `<defunct>`.
        let pid = started_pid(&session);
        assert!(zombies_among(&[pid]).is_empty(), "pid {pid} was never collected");
    }

    #[test]
    fn does_not_restart_a_clean_exit_under_on_failure() {
        let harness = Harness::new();
        let services = on_cue(0, "on-failure");

        let session = supervise(
            &harness,
            &services,
            &options(100),
            |event| {
                if is_started(event) {
                    harness.cue();
                }
            },
            settles(is_exited, 30),
        );

        assert!(session.kinds().contains(&Event::Exited { name: "web".to_owned(), status: Exit::Code { code: 0 } }));
        assert_eq!(session.count(is_restarting), 0, "a service that finished is not a service that failed");
        assert_eq!(session.outcome.restarts, 0);
    }

    #[test]
    fn restarts_a_clean_exit_under_always() {
        let harness = Harness::new();
        let services = on_cue(0, "always");

        let session = supervise(
            &harness,
            &services,
            &options(100),
            |event| {
                if is_started(event) {
                    harness.cue();
                }
            },
            settles(is_restarting, 0),
        );

        let kinds = session.kinds();
        assert_eq!(kinds[1], Event::Exited { name: "web".to_owned(), status: Exit::Code { code: 0 } });
        assert_eq!(kinds[2], Event::Restarting { name: "web".to_owned(), attempt: 1, delay_ms: 1000 });
        assert_eq!(session.outcome.restarts, 1);
    }

    #[test]
    fn never_restarts_under_never() {
        let harness = Harness::new();
        let services = instantly(7, "never");

        let session = supervise(&harness, &services, &options(100), |_| {}, settles(is_exited, 30));

        assert_eq!(session.count(is_exited), 1);
        assert_eq!(session.count(is_restarting), 0);
        assert_eq!(session.count(is_gave_up), 0);
        assert_eq!(session.outcome.restarts, 0);
    }

    #[test]
    fn no_restart_overrides_every_policy() {
        let harness = Harness::new();
        let services = instantly(1, "always");
        let opts = SuperviseOptions { restart: false, ..options(100) };

        let session = supervise(&harness, &services, &opts, |_| {}, settles(is_exited, 30));

        assert_eq!(session.count(is_exited), 1);
        assert_eq!(session.count(is_restarting), 0, "--no-restart is a master switch over the policy");
    }

    #[rstest]
    #[case(RestartPolicy::Never, Exit::Code { code: 0 }, false)]
    #[case(RestartPolicy::Never, Exit::Code { code: 1 }, false)]
    #[case(RestartPolicy::Never, Exit::Unknown, false)]
    #[case(RestartPolicy::OnFailure, Exit::Code { code: 0 }, false)]
    #[case(RestartPolicy::OnFailure, Exit::Code { code: 1 }, true)]
    #[case(RestartPolicy::OnFailure, Exit::Signal { signal: 9 }, true)]
    #[case(RestartPolicy::OnFailure, Exit::Unknown, true)]
    #[case(RestartPolicy::Always, Exit::Code { code: 0 }, true)]
    #[case(RestartPolicy::Always, Exit::Signal { signal: 15 }, true)]
    #[case(RestartPolicy::Always, Exit::Unknown, true)]
    fn a_policy_decides_which_exits_come_back(#[case] policy: RestartPolicy, #[case] exit: Exit, #[case] expect: bool) {
        assert_eq!(restarts_on(policy, exit), expect);
    }

    // -----------------------------------------------------------------------------------
    // Backoff and budget
    // -----------------------------------------------------------------------------------

    #[rstest]
    #[case(0, 1_000)]
    #[case(1, 1_000)]
    #[case(2, 2_000)]
    #[case(3, 4_000)]
    #[case(4, 8_000)]
    #[case(5, 16_000)]
    #[case(6, 30_000)]
    #[case(7, 30_000)]
    // A long crash loop must stay at the cap. A shift instead of a saturating multiply would
    // wrap here and come back around to restarting instantly.
    #[case(100, 30_000)]
    #[case(u32::MAX, 30_000)]
    fn backoff_doubles_and_caps(#[case] attempt: u32, #[case] expect_ms: u64) {
        assert_eq!(backoff_delay(attempt, &Backoff::default()), Duration::from_millis(expect_ms));
    }

    #[test]
    fn a_base_above_the_cap_is_the_cap() {
        let backoff = Backoff { base: Duration::from_secs(5), max: Duration::from_secs(1) };
        assert_eq!(backoff_delay(1, &backoff), Duration::from_secs(1));
    }

    #[test]
    fn backoff_resets_after_a_service_stays_up() {
        let opts = SuperviseOptions {
            backoff: Backoff { base: Duration::from_secs(1), max: Duration::from_secs(4) },
            budget: Budget { restarts: 10, window: Duration::from_secs(600) },
            ..SuperviseOptions::default()
        };
        let mut restarts = Restarts::default();

        // Three crashes in a row climb to the cap.
        assert_eq!(restarts.schedule(0, Duration::ZERO, &opts), Some(Duration::from_secs(1)));
        assert_eq!(restarts.schedule(1_000, Duration::ZERO, &opts), Some(Duration::from_secs(2)));
        assert_eq!(restarts.schedule(3_000, Duration::ZERO, &opts), Some(Duration::from_secs(4)));
        // One that stayed up for just under the cap is the same crash loop continuing.
        assert_eq!(restarts.schedule(10_000, Duration::from_millis(3_999), &opts), Some(Duration::from_secs(4)));
        // One that outlived the cap had started, so its failure is a new problem.
        assert_eq!(restarts.schedule(20_000, Duration::from_secs(4), &opts), Some(Duration::from_secs(1)));
        assert_eq!(restarts.total, 5);
    }

    #[test]
    fn the_budget_is_a_rolling_window() {
        let opts = SuperviseOptions {
            backoff: Backoff { base: Duration::ZERO, max: Duration::ZERO },
            budget: Budget { restarts: 1, window: Duration::from_secs(1) },
            ..SuperviseOptions::default()
        };
        let mut restarts = Restarts::default();

        assert_eq!(restarts.schedule(0, Duration::ZERO, &opts), Some(Duration::ZERO));
        // A second restart inside the window is the crash loop the budget exists for.
        assert_eq!(restarts.schedule(999, Duration::ZERO, &opts), None);
        // Exactly a window later the first one has aged out, and the budget is whole again.
        assert_eq!(restarts.schedule(1_000, Duration::ZERO, &opts), Some(Duration::ZERO));
        assert_eq!(restarts.schedule(5_000, Duration::ZERO, &opts), Some(Duration::ZERO));
        assert_eq!(restarts.total, 3, "the refusal is not a restart");
    }

    #[test]
    fn gives_up_after_the_budget_and_says_so() {
        let harness = Harness::new();
        let services = instantly(1, "always");
        let opts = SuperviseOptions {
            backoff: Backoff { base: Duration::ZERO, max: Duration::ZERO },
            budget: Budget { restarts: 2, window: Duration::from_secs(600) },
            ..options(100)
        };

        let session = supervise(&harness, &services, &opts, |_| {}, settles(is_gave_up, 20));

        assert_eq!(session.kinds().last(), Some(&Event::Stopped { name: "web".to_owned() }));
        assert!(session.kinds().contains(&Event::GaveUp { name: "web".to_owned(), restarts: 2 }));
        assert_eq!(session.count(is_restarting), 2, "exactly the budget, no more");
        assert_eq!(session.count(is_exited), 3, "the original plus one per restart, then nothing");
        assert_eq!(session.outcome.restarts, 2);

        let web = &session.outcome.services[0];
        assert_eq!(web.state, RunState::Failed, "not `stopped`: it is not running because it failed");
        assert_eq!(web.detail.as_deref(), Some("gave up after 2 restarts in 10m"));
    }

    #[test]
    fn the_backoff_is_waited_out_before_the_next_start() {
        let harness = Harness::new();
        let services = instantly(1, "always");
        let opts = SuperviseOptions {
            backoff: Backoff { base: Duration::from_millis(500), max: Duration::from_millis(500) },
            budget: Budget { restarts: 5, window: Duration::from_secs(600) },
            ..options(100)
        };

        let deadline = TestInstant::now() + GIVE_UP;

        let session = supervise(
            &harness,
            &services,
            &opts,
            |_| {},
            |events, _| {
                TestInstant::now() >= deadline || events.iter().filter(|(_, event)| is_restarting(event)).count() >= 2
            },
        );

        let scheduled =
            session.events.iter().position(|(_, event)| is_restarting(event)).expect("a restart was scheduled");
        assert_eq!(
            session.events[scheduled].1,
            Event::Restarting { name: "web".to_owned(), attempt: 1, delay_ms: 500 }
        );
        // Virtual time only moves when the loop sleeps, so the next event is stamped with the
        // exact poll the restart happened on: the one the delay was up, neither earlier nor later.
        let (waited, next) = &session.events[scheduled + 1];
        assert_eq!(
            *waited,
            session.events[scheduled].0 + 500,
            "{next} at {waited}, not {}",
            session.events[scheduled].0 + 500
        );
    }

    // -----------------------------------------------------------------------------------
    // Health
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_health_failure_is_reported_but_never_restarts() {
        let harness = Harness::new();
        let services = specs(
            r#"
web:
  run: "sleep 30"
  restart: always
  health:
    cmd: "exit 1"
    interval: 0ms
    retries: 1
    start_period: 0ms
"#,
        );

        let session = supervise(&harness, &services, &options(100), |_| {}, settles(is_unhealthy, 20));

        assert_eq!(session.count(is_unhealthy), 1, "reported once, not once per interval");
        assert_eq!(session.count(is_exited), 0, "a failing check is not an exit");
        assert_eq!(session.count(is_restarting), 0, "a check with a mistake in it must not become a kill loop");
        assert_eq!(session.count(is_started), 1);
        assert_eq!(session.outcome.restarts, 0);
        // `down` adds a detail when the process had already gone. None of them means the service
        // was alive right up to the shutdown that stopped it.
        assert_eq!(session.outcome.services[0].state, RunState::Stopped);
        assert_eq!(session.outcome.services[0].detail, None);
    }

    /// Each service's check keeps its own schedule, which is only visible in how often the probe
    /// actually runs — so the probe writes a line and the test counts them.
    #[rstest]
    #[case("100ms", 10)]
    #[case("200ms", 5)]
    fn a_health_check_runs_once_per_interval(#[case] interval: &str, #[case] expect: usize) {
        let harness = Harness::new();
        let services = specs(&format!(
            "\nweb:\n  run: \"sleep 30\"\n  health:\n    cmd: \"echo probed >> probes\"\n    interval: {interval}\n    retries: 3\n"
        ));

        supervise(&harness, &services, &options(100), |_| {}, polls(10));

        let probes = fs::read_to_string(harness.worktree.join("probes")).unwrap_or_default();
        assert_eq!(probes.lines().count(), expect, "ten polls of 100ms at an interval of {interval}");
    }

    #[test]
    fn a_health_check_runs_where_the_service_does() {
        let harness = Harness::new();
        fs::write(harness.worktree.join("sub").join("here"), "").expect("marker");
        let services = specs(
            r#"
api:
  run: "sleep 30"
  cwd: sub
  env:
    TOKEN: opensesame
  health:
    cmd: '[ "$TOKEN" = opensesame ] && [ -f here ]'
    interval: 0ms
    retries: 1
"#,
        );

        let session = supervise(&harness, &services, &options(100), |_| {}, settles(is_healthy, 2));

        // The marker is only findable from the service's own `cwd`, and `$TOKEN` only exists in
        // the service's own `env`. A check that ran anywhere else would fail both.
        assert_eq!(session.count(is_healthy), 1, "{:?}", session.kinds());
        assert_eq!(session.count(is_unhealthy), 0);
    }

    // -----------------------------------------------------------------------------------
    // Shutdown
    // -----------------------------------------------------------------------------------

    #[test]
    fn shutdown_stops_every_service_in_reverse_dependency_order() {
        let harness = Harness::new();
        let services = specs(
            r#"
api:
  run: "sleep 30"
  depends_on: [db]
db:
  run: "sleep 30"
web:
  run: "sleep 30"
  depends_on: [api]
"#,
        );

        let session = supervise(&harness, &services, &options(100), |_| {}, polls(2));

        assert_eq!(session.named(is_started), ["db", "api", "web"]);
        // Reverse, so the database outlives the things talking to it and nothing spends its last
        // second logging connection errors.
        assert_eq!(session.named(is_stopped), ["web", "api", "db"]);
        for status in &session.outcome.services {
            assert_eq!(status.state, RunState::Stopped, "{}", status.name);
        }
    }

    #[test]
    fn shutdown_leaves_no_orphan_process_group() {
        let harness = Harness::new();
        // The bug process groups exist to prevent: killing only the shell leaves the background
        // `sleep` holding whatever it holds, for a minute, invisibly.
        let services = specs("\nweb:\n  run: \"sleep 60 & sleep 60\"\n");
        let members = RefCell::new(Vec::new());

        let session = supervise(
            &harness,
            &services,
            &options(100),
            |event| {
                if let Event::Started { pid, .. } = event {
                    *members.borrow_mut() = group_members(*pid);
                }
            },
            polls(2),
        );

        let pid = started_pid(&session);
        assert!(members.borrow().len() >= 2, "the group never filled out: {:?}", members.borrow());
        assert!(eventually(|| group_members(pid).is_empty()), "group {pid} still holds {:?}", group_members(pid));
    }

    #[test]
    fn run_reaps_restarted_children_so_no_zombies_accumulate() {
        let harness = Harness::new();
        let services = instantly(0, "always");
        let opts = SuperviseOptions {
            backoff: Backoff { base: Duration::ZERO, max: Duration::ZERO },
            budget: Budget { restarts: 100, window: Duration::from_secs(600) },
            ..options(100)
        };

        let spawned = RefCell::new(Vec::new());
        let deadline = TestInstant::now() + GIVE_UP;

        let session = supervise(
            &harness,
            &services,
            &opts,
            |event| {
                if is_exited(event) {
                    // The record still names the process that just died; the next start is what
                    // overwrites it.
                    spawned.borrow_mut().push(harness.record("web").pid);
                }
            },
            |events, _| {
                TestInstant::now() >= deadline || events.iter().filter(|(_, event)| is_restarting(event)).count() >= 20
            },
        );

        assert_eq!(session.outcome.restarts, 20);
        let spawned = spawned.into_inner();
        let distinct: BTreeSet<i32> = spawned.iter().copied().collect();
        assert_eq!(distinct.len(), 20, "every restart is a new process: {spawned:?}");
        // A supervisor that never waited on its children would be sitting on twenty `<defunct>`
        // entries by now, and on a real session, on thousands.
        assert!(eventually(|| zombies_among(&spawned).is_empty()), "uncollected: {:?}", zombies_among(&spawned));
    }

    // -----------------------------------------------------------------------------------
    // Adoption, ordering and refusals
    // -----------------------------------------------------------------------------------

    #[test]
    fn run_takes_over_a_service_that_up_already_started() {
        let harness = Harness::new();
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");
        let (pid, before) = {
            let facts = harness.facts();
            let ctx = harness.ctx(&facts);
            let started = service::up(&services, None, &ctx, false).expect("up");
            (started[0].pid.expect("a pid"), harness.record("web"))
        };
        let adopted = RefCell::new(String::new());

        let session = supervise(
            &harness,
            &services,
            &options(100),
            |event| {
                if is_started(event) {
                    adopted.borrow_mut().clone_from(&harness.record("web").launch_id);
                }
            },
            polls(3),
        );

        assert_eq!(session.count(is_started), 1);
        assert_eq!(started_pid(&session), pid, "a second spawn would have a different pid");
        // The launch id is fresh for every spawn, so an unchanged one is proof that nothing was
        // started a second time.
        assert_eq!(*adopted.borrow(), before.launch_id);
        assert!(eventually(|| group_members(pid).is_empty()), "the adopted service outlived the run");
    }

    #[test]
    fn events_are_emitted_in_order() {
        let harness = Harness::new();
        let services = specs(
            r#"
web:
  run: "until [ -f die ]; do sleep 0.05; done; exit 0"
  restart: never
  health:
    cmd: "true"
    interval: 0ms
    retries: 1
"#,
        );

        let session = supervise(
            &harness,
            &services,
            &options(100),
            |event| {
                if is_healthy(event) {
                    harness.cue();
                }
            },
            settles(is_exited, 5),
        );

        let kinds = session.kinds();
        assert_eq!(kinds.len(), 4, "{kinds:?}");
        assert!(matches!(kinds[0], Event::Started { .. }), "{kinds:?}");
        assert_eq!(kinds[1], Event::Healthy { name: "web".to_owned() });
        assert_eq!(kinds[2], Event::Exited { name: "web".to_owned(), status: Exit::Code { code: 0 } });
        assert_eq!(kinds[3], Event::Stopped { name: "web".to_owned() });
    }

    #[test]
    fn a_dependency_cycle_is_an_error() {
        let harness = Harness::new();
        let services =
            specs("\na:\n  run: \"sleep 30\"\n  depends_on: [b]\nb:\n  run: \"sleep 30\"\n  depends_on: [a]\n");
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let clock = TestClock::new();

        let error = run(&services, None, &ctx, &SuperviseOptions::default(), &clock, &|| true, &mut |_| {})
            .expect_err("a cycle is not a startable set of services");

        assert!(matches!(error, ServiceError::Order(_)), "{error:?}");
        assert!(error.to_string().contains("depends_on cycle"), "{error}");
        assert!(!record_path(&harness.state, "a").exists(), "nothing is started before the plan is checked");
    }

    // -----------------------------------------------------------------------------------
    // Small pieces
    // -----------------------------------------------------------------------------------

    // Every one of these is a wildcard to `waitpid`: 0 is "any child in my process group" and
    // -1 is "any child at all". Either would collect, and throw away, the exit status of a
    // process this supervisor knows nothing about.
    #[rstest]
    #[case(0)]
    #[case(-1)]
    #[case(-4321)]
    fn a_nonsense_pid_is_never_waited_for(#[case] pid: i32) {
        assert_eq!(child(pid), None);
    }

    #[test]
    fn a_real_pid_is_waited_for() {
        assert_eq!(child(4321), Some(Pid::from_raw(4321)));
    }

    #[test]
    fn a_process_we_did_not_start_is_still_seen_to_be_gone() {
        // Never our child, so `waitpid` can say nothing about it — but the kernel can still say
        // it is not running, which is what an adopted service needs.
        let record = ProcessRecord {
            pid: 1,
            pgid: 1,
            start_time: Some("not when init started".to_owned()),
            launch_id: "id".to_owned(),
            command: "init".to_owned(),
            cwd: Utf8PathBuf::from("/"),
            log: Utf8PathBuf::from("/dev/null"),
            started_at: 0,
        };
        assert_eq!(observe_exit(&record), Some(Exit::Unknown));
    }

    #[test]
    fn the_defaults_are_the_documented_ones() {
        let opts = SuperviseOptions::default();
        assert!(opts.restart);
        assert_eq!(opts.poll, DEFAULT_POLL);
        assert_eq!(opts.backoff, Backoff { base: Duration::from_secs(1), max: Duration::from_secs(30) });
        assert_eq!(opts.budget, Budget { restarts: 5, window: Duration::from_secs(60) });
    }

    #[test]
    fn every_event_reads_as_a_line_of_output() {
        let events = [
            Event::Started { name: "web".to_owned(), pid: 42 },
            Event::Healthy { name: "web".to_owned() },
            Event::Unhealthy { name: "web".to_owned(), detail: "connection refused".to_owned() },
            Event::Exited { name: "web".to_owned(), status: Exit::Code { code: 3 } },
            Event::Exited { name: "web".to_owned(), status: Exit::Signal { signal: 9 } },
            Event::Exited { name: "web".to_owned(), status: Exit::Unknown },
            Event::Restarting { name: "web".to_owned(), attempt: 2, delay_ms: 2000 },
            Event::GaveUp { name: "web".to_owned(), restarts: 5 },
            Event::Stopped { name: "web".to_owned() },
        ];
        let lines: Vec<String> = events.iter().map(Event::to_string).collect();
        assert_eq!(
            lines,
            [
                "web started, pid 42",
                "web is healthy",
                "web is unhealthy: connection refused",
                "web exited with code 3",
                "web exited with signal 9",
                "web exited with an unrecorded status",
                "web restarting in 2000ms, attempt 2",
                "web gave up after 5 restarts",
                "web stopped",
            ]
        );
    }
}
