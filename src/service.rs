//! Bringing a worktree's services up and down, with nothing running in between.
//!
//! `canopywt up` spawns a dev server and exits; the dev server keeps serving. There is no
//! daemon, no supervisor thread and no handle held anywhere, so every question asked later —
//! *is it running? on what pid? is it serving?* — has to be answered from two files and the
//! kernel:
//!
//! ```text
//! <state>/services/<name>.json   the ProcessRecord from proc::spawn
//! <state>/logs/<name>.log        stdout+stderr, appended
//! ```
//!
//! Three rules follow from that, and they are the whole module:
//!
//! - **The record is a claim, never an answer.** A pid on disk is a number somebody else may be
//!   wearing by now. Every path that reports or signals goes through [`crate::proc::state`],
//!   which re-reads the process's start time and compares it with the one recorded at spawn.
//!   That is also why a second `up` is harmless: the file, not our own memory, decides whether a
//!   service is already running.
//! - **A spawn is not a start.** `fork` succeeding says nothing about a command with a typo in
//!   it. [`ALIVE_GRACE`] is the fraction of a second `up` spends watching the process breathe
//!   before it dares call it running — reporting `running` for something that has already exited
//!   sends the user off to debug the wrong half of their stack.
//! - **Only `runtime: host` works here.** `docker` and `compose` are reported
//!   [`RunState::Unsupported`], loudly. Silently skipping them would leave a user staring at a
//!   green `up` and a database that was never started.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read as _, Seek as _, SeekFrom};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use camino::{Utf8Path, Utf8PathBuf};
use serde::Serialize;

use crate::config::{Duration, Runtime, ServiceSpec, service_ports, start_order};
use crate::env::{EnvTable, Facts, interpolate};
use crate::error::ErrorCode;
use crate::health::{self, HealthError, ResolvedHealth, Verdict};
use crate::proc::{self, ProcError, ProcessRecord, ProcessState, SpawnRequest, StopOutcome};

/// How long [`up`] watches a freshly spawned process before it will call it running.
///
/// Long enough for `/bin/sh` to fail to find a binary, short enough that starting six services
/// still feels instant. It is a floor on how *late* a start can be, not a promise about the
/// service: a command that dies after a second is reported running and caught by the next
/// [`status`].
pub const ALIVE_GRACE: Duration = Duration::from_millis(750);

/// How often the grace window re-checks the process. Each check costs a `ps`, so this is coarse
/// on purpose — the value being measured is "a fraction of a second", not a deadline.
const SETTLE_POLL: Duration = Duration::from_millis(50);

/// How often [`follow`] looks for new bytes, when the caller does not say.
pub const FOLLOW_POLL: Duration = Duration::from_millis(200);

/// Log lines quoted in the `detail` of a service that is not running.
const DETAIL_LINES: usize = 5;

/// The most a single [`follow`] poll will read, so a service that dumped a gigabyte overnight
/// does not become a gigabyte-sized allocation in a terminal.
const FOLLOW_CHUNK: u64 = 262_144;

const RECORDS_DIR: &str = "services";
const LOGS_DIR: &str = "logs";

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/// Why a service command could not be *carried out*.
///
/// Module-local, like [`crate::ports::PortError`], and deliberately narrow: a service that
/// exits, refuses to die or never becomes healthy is not one of these — those are outcomes with
/// a [`ServiceStatus`] to report them. These are the cases where the command itself could not
/// run: a config that does not describe a startable set of services, or state we cannot read or
/// write.
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    /// [`start_order`] found a `depends_on` cycle; the message names it.
    #[error("{0}")]
    Order(String),

    #[error("no service is called {0:?}")]
    Unknown(String),

    #[error("service {name:?} has no run: command")]
    NoCommand { name: String },

    #[error("service {name:?}: {source}")]
    Health {
        name: String,
        #[source]
        source: HealthError,
    },

    /// `up --wait` gave up on a service. Fatal to the call because the services after it depend
    /// on this one — see [`up`].
    #[error("service {name:?} did not become healthy: {detail}")]
    NeverHealthy { name: String, detail: String },

    #[error("{path}: {source}")]
    Io {
        path: Utf8PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("{name:?} has no log at {path}")]
    NoLog { name: String, path: Utf8PathBuf },

    #[error(transparent)]
    Proc(#[from] ProcError),
}

impl ServiceError {
    /// The stable code a caller branches on.
    pub fn code(&self) -> ErrorCode {
        match self {
            ServiceError::Order(_)
            | ServiceError::Unknown(_)
            | ServiceError::NoCommand { .. }
            | ServiceError::Health { .. } => ErrorCode::ConfigInvalid,
            ServiceError::NeverHealthy { .. } => ErrorCode::ServiceFailed,
            ServiceError::Io { .. } | ServiceError::NoLog { .. } => ErrorCode::Io,
            // The module below already chose a code for each of its own failures; flattening
            // them all to one here would throw that away.
            ServiceError::Proc(error) => error.code(),
        }
    }
}

impl From<ServiceError> for crate::error::Error {
    fn from(error: ServiceError) -> crate::error::Error {
        crate::error::Error::Module { code: error.code(), message: error.to_string() }
    }
}

// ---------------------------------------------------------------------------------------
// What a caller gets back
// ---------------------------------------------------------------------------------------

/// One word for a service, for a list where each row gets one.
///
/// Coarser than [`health::Status`] on purpose: this answers "what do I show next to the name?",
/// and the precise health reading is carried alongside it in [`ServiceStatus::health`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Not running, and nothing says it should be: never started, stopped, or `autostart: false`.
    Stopped,
    /// Alive, but not yet known to be serving.
    Starting,
    Running,
    /// Alive and its health check is failing.
    Unhealthy,
    /// We started it and it is gone. `detail` carries the end of its log.
    Exited,
    /// We could not start it, could not stop it, or cannot read its record.
    Failed,
    /// `runtime: docker` or `compose`. Reported rather than skipped.
    Unsupported,
}

/// Everything one service's row shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceStatus {
    pub name: String,
    pub state: RunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    /// Present only when the service declares a `health:` block *and* it was probed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<health::Status>,
    /// Named ports, per [`service_ports`] — declared if `ports:` is set, else inferred.
    pub ports: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<u64>,
    /// Why, in a sentence a human can act on: a crash's last log lines, a refused signal, the
    /// reason a runtime is unsupported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ServiceStatus {
    fn new(name: &str, spec: &ServiceSpec, state: RunState) -> ServiceStatus {
        ServiceStatus {
            name: name.to_owned(),
            state,
            pid: None,
            health: None,
            ports: service_ports(spec),
            uptime_ms: None,
            detail: None,
        }
    }

    fn detail(mut self, detail: impl Into<String>) -> ServiceStatus {
        self.detail = Some(detail.into());
        self
    }
}

/// Where a worktree's services live and what they run with.
///
/// The state directory is handed in rather than derived from a git dir: this module has no
/// opinion about where Canopy keeps its files, and a test — or an embedder with two worktrees
/// open — needs to say.
#[derive(Debug)]
pub struct ServiceContext<'a> {
    pub worktree: &'a Utf8Path,
    pub state: &'a Utf8Path,
    /// The worktree's resolved environment. Every service inherits it; a service's own `env:`
    /// goes on top.
    pub env: &'a EnvTable,
    /// The scope `${ports.web}` and friends resolve against.
    pub facts: &'a Facts<'a>,
}

/// The process record for one service.
pub fn record_path(state: &Utf8Path, name: &str) -> Utf8PathBuf {
    state.join(RECORDS_DIR).join(format!("{name}.json"))
}

/// The combined stdout/stderr log for one service.
pub fn log_path(state: &Utf8Path, name: &str) -> Utf8PathBuf {
    state.join(LOGS_DIR).join(format!("{name}.log"))
}

// ---------------------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------------------

/// Starts services in dependency order and returns without supervising them.
///
/// `only` restricts the set; `None` means every declared service. A service that is already
/// running is left alone and reports what is already there, so two `up`s racing each other end
/// with one dev server rather than two fighting over a port.
///
/// With `wait`, each health-checked service is polled until it is serving *before the next one
/// starts*, and a service that never becomes healthy fails the whole call. Its dependents are
/// deliberately not started: starting a client whose server never came up only produces a second,
/// more confusing failure, and the first one is the one worth reading. The services already
/// started are left running — they are what the user needs to look at.
pub fn up(
    services: &BTreeMap<String, ServiceSpec>,
    only: Option<&BTreeSet<String>>,
    ctx: &ServiceContext<'_>,
    wait: bool,
) -> Result<Vec<ServiceStatus>, ServiceError> {
    let order = plan(services, only)?;
    ensure_dirs(ctx.state)?;
    let mut out = Vec::with_capacity(order.len());
    for name in order {
        let spec = &services[name.as_str()];
        let named = only.is_some_and(|set| set.contains(&name));
        if should_skip(spec, named) {
            out.push(ServiceStatus::new(&name, spec, RunState::Stopped).detail("autostart is false"));
            continue;
        }
        out.push(start_one(&name, spec, ctx, wait)?);
    }
    Ok(out)
}

/// `autostart: false` means "declared, but not part of `up`". Naming it explicitly overrides
/// that — a service you start by hand is the entire point of the flag.
fn should_skip(spec: &ServiceSpec, named: bool) -> bool {
    !spec.autostart && !named
}

fn start_one(
    name: &str,
    spec: &ServiceSpec,
    ctx: &ServiceContext<'_>,
    wait: bool,
) -> Result<ServiceStatus, ServiceError> {
    if let Some(detail) = unsupported(spec) {
        return Ok(ServiceStatus::new(name, spec, RunState::Unsupported).detail(detail));
    }
    if let Some(record) = live_record(ctx.state, name) {
        return Ok(running_status(name, spec, ctx, &record, record.pid));
    }
    let Some(run) = &spec.run else {
        return Err(ServiceError::NoCommand { name: name.to_owned() });
    };
    // Resolved before the spawn, so a `health:` block that cannot be resolved is a config error
    // and not a process we started and then could not check.
    let health = match &spec.health {
        Some(check) => Some(resolve_health(name, check, ctx)?),
        None => None,
    };

    let command = interpolate(run, ctx.facts, ctx.env);
    let cwd = service_cwd(spec, ctx);
    let env = service_env(spec, ctx);
    let log = log_path(ctx.state, name);
    let record = match proc::spawn(&SpawnRequest { command: &command, cwd: &cwd, env: &env, log: &log }) {
        Ok(record) => record,
        Err(error) => return Ok(ServiceStatus::new(name, spec, RunState::Failed).detail(error.to_string())),
    };
    // Written before the grace window, not after: the process exists from here on, and a crash
    // in between would otherwise leave something running that nothing on disk points at.
    proc::write_record(&record_path(ctx.state, name), &record)?;

    if !matches!(settle(&record, ALIVE_GRACE), ProcessState::Running { .. }) {
        return Ok(exited_status(name, spec, ctx.state));
    }

    let mut status = ServiceStatus::new(name, spec, RunState::Running);
    status.pid = Some(record.pid);
    status.uptime_ms = uptime_ms(&record);
    match (wait, health) {
        (true, Some(resolved)) => {
            let verdict = resolved.wait_until_healthy(&cwd, &env, None);
            if !verdict.is_healthy() {
                return Err(ServiceError::NeverHealthy { name: name.to_owned(), detail: verdict_detail(&verdict) });
            }
            status.health = Some(health::Status::Healthy);
        }
        // Alive, declares a health check, and nobody asked us to wait for it: `starting` is the
        // honest word. The next `status` probes and says whether it got there.
        (false, Some(_)) => status.state = RunState::Starting,
        (_, None) => {}
    }
    Ok(status)
}

/// Watches a freshly spawned process for `grace`, returning the moment it dies.
///
/// A spawn only proves `fork` worked. `npm run dev` with a typo in it is a live pid for about
/// two milliseconds, and reporting that as `running` is the most expensive lie this tool could
/// tell: the user goes off to debug the client of a server that was never there. Waiting a
/// fraction of a second turns the overwhelmingly common failure — a command that fails
/// instantly — into an `exited` with the reason attached.
fn settle(record: &ProcessRecord, grace: Duration) -> ProcessState {
    let deadline = Instant::now() + grace.as_std();
    loop {
        match proc::state(record) {
            ProcessState::Running { pid } => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return ProcessState::Running { pid };
                }
                std::thread::sleep(SETTLE_POLL.as_std().min(remaining));
            }
            // Dead, or wearing a pid that is not ours: either way there is nothing to wait for.
            gone => return gone,
        }
    }
}

// ---------------------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------------------

/// Stops services in reverse dependency order and forgets them.
///
/// Reverse, so a database outlives the things that talk to it and nothing spends its last
/// second logging connection errors. A service with no record was never started, which is a
/// success — `down` is idempotent and running it twice is not an error.
pub fn down(
    services: &BTreeMap<String, ServiceSpec>,
    only: Option<&BTreeSet<String>>,
    ctx: &ServiceContext<'_>,
) -> Result<Vec<ServiceStatus>, ServiceError> {
    let mut order = plan(services, only)?;
    order.reverse();
    Ok(order.into_iter().map(|name| stop_one(&name, &services[name.as_str()], ctx)).collect())
}

fn stop_one(name: &str, spec: &ServiceSpec, ctx: &ServiceContext<'_>) -> ServiceStatus {
    if let Some(detail) = unsupported(spec) {
        return ServiceStatus::new(name, spec, RunState::Unsupported).detail(detail);
    }
    let path = record_path(ctx.state, name);
    if !path.exists() {
        return ServiceStatus::new(name, spec, RunState::Stopped);
    }
    let record = match proc::read_record(&path) {
        Ok(record) => record,
        // A record we cannot read is a process we cannot stop. Calling that "stopped" would
        // report success over a leaked service.
        Err(error) => return ServiceStatus::new(name, spec, RunState::Failed).detail(error.to_string()),
    };
    let outcome = proc::stop(&record, &spec.stop_signal, spec.stop_timeout);
    if let StopOutcome::Refused { reason } = outcome {
        // `proc::stop` would not signal a pid it could not prove is ours. The record stays: it
        // is the evidence, and deleting it would only hide that something leaked.
        return ServiceStatus::new(name, spec, RunState::Failed).detail(reason);
    }
    // Removed only now that the process is gone. The other order leaves a live process with
    // nothing on disk pointing at it — unkillable by us and invisible to the next `status`.
    let _ = fs::remove_file(&path);
    let status = ServiceStatus::new(name, spec, RunState::Stopped);
    match outcome {
        StopOutcome::Killed => status.detail(format!("it ignored {} and was killed", spec.stop_signal)),
        StopOutcome::NotRunning => status.detail("it had already exited"),
        StopOutcome::Terminated | StopOutcome::Refused { .. } => status,
    }
}

// ---------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------

/// Every declared service, as it is right now.
///
/// Nothing is believed from the record. Between two calls a process exits and its pid is handed
/// to somebody else, so the pid is probed and its start time re-read every single time — a
/// status that trusted the file would keep reporting a dead service as running forever.
pub fn status(
    services: &BTreeMap<String, ServiceSpec>,
    only: Option<&BTreeSet<String>>,
    ctx: &ServiceContext<'_>,
) -> Result<Vec<ServiceStatus>, ServiceError> {
    let order = plan(services, only)?;
    Ok(order.into_iter().map(|name| observe(&name, &services[name.as_str()], ctx)).collect())
}

fn observe(name: &str, spec: &ServiceSpec, ctx: &ServiceContext<'_>) -> ServiceStatus {
    if let Some(detail) = unsupported(spec) {
        return ServiceStatus::new(name, spec, RunState::Unsupported).detail(detail);
    }
    let path = record_path(ctx.state, name);
    if !path.exists() {
        return ServiceStatus::new(name, spec, RunState::Stopped);
    }
    let record = match proc::read_record(&path) {
        Ok(record) => record,
        Err(error) => return ServiceStatus::new(name, spec, RunState::Failed).detail(error.to_string()),
    };
    match proc::state(&record) {
        ProcessState::Running { pid } => running_status(name, spec, ctx, &record, pid),
        ProcessState::Exited => exited_status(name, spec, ctx.state),
        // The pid is alive and is not ours. Our service is as gone as if the pid were free; the
        // detail says so rather than letting a reader think the number means anything.
        ProcessState::Stale => {
            exited_status(name, spec, ctx.state).detail(format!("pid {} belongs to another process now", record.pid))
        }
    }
}

fn running_status(
    name: &str,
    spec: &ServiceSpec,
    ctx: &ServiceContext<'_>,
    record: &ProcessRecord,
    pid: i32,
) -> ServiceStatus {
    let mut status = ServiceStatus::new(name, spec, RunState::Running);
    status.pid = Some(pid);
    status.uptime_ms = uptime_ms(record);
    let Some(check) = &spec.health else {
        return status;
    };
    match health::resolve(check, |text| interpolate(text, ctx.facts, ctx.env)) {
        // The process is running; it is the check that is broken. Saying "unhealthy" would send
        // the user to look at a service that is fine.
        Err(error) => status.detail(error.to_string()),
        Ok(resolved) => {
            let probe = resolved.probe_once(&service_cwd(spec, ctx), &service_env(spec, ctx));
            // One probe has no run of failures to count, but it does have an age: `Tracker` is
            // what knows that a failure inside `start_period` means "still starting".
            let elapsed = Duration::from_millis(status.uptime_ms.unwrap_or_default());
            let observed = health::Tracker::new(&resolved.timing).record(elapsed, &probe);
            status.state = run_state_for(&observed);
            status.health = Some(observed);
            status
        }
    }
}

/// The one-word answer to "is it serving?".
///
/// `Failing` and `Unhealthy` both land on `Unhealthy` because to that question they are the same
/// answer: no. Whether the service has merely failed once or has failed enough times to be
/// condemned is in [`ServiceStatus::health`], for a caller that cares.
fn run_state_for(status: &health::Status) -> RunState {
    match status {
        health::Status::Healthy => RunState::Running,
        health::Status::Starting => RunState::Starting,
        health::Status::Failing { .. } | health::Status::Unhealthy { .. } => RunState::Unhealthy,
    }
}

/// A service that is gone, explaining itself with the end of its log.
///
/// "exited" on its own is the beginning of a debugging session; the reason is almost always in
/// the last few lines, and it costs one `tail` to put it where the user is already looking.
fn exited_status(name: &str, spec: &ServiceSpec, state: &Utf8Path) -> ServiceStatus {
    let status = ServiceStatus::new(name, spec, RunState::Exited);
    match log_excerpt(state, name) {
        Some(excerpt) => status.detail(excerpt),
        None => status,
    }
}

fn log_excerpt(state: &Utf8Path, name: &str) -> Option<String> {
    let lines = proc::tail(&log_path(state, name), DETAIL_LINES).ok()?;
    let text = lines.join("\n");
    // A service that said nothing on the way out gets no detail, rather than a detail that is
    // an empty string pretending to be an explanation.
    (!text.trim().is_empty()).then_some(text)
}

// ---------------------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------------------

/// The last `lines` lines of a service's log.
pub fn logs(state: &Utf8Path, name: &str, lines: usize) -> Result<Vec<String>, ServiceError> {
    let log = log_path(state, name);
    if !log.exists() {
        // Distinguished from an empty log on purpose: "no output yet" and "no such service" look
        // identical as an empty list, and one of them is a typo.
        return Err(ServiceError::NoLog { name: name.to_owned(), path: log });
    }
    Ok(proc::tail(&log, lines)?)
}

/// [`logs`], and then whatever is appended from now on, for as long as `keep_going` says so.
///
/// A poll, not `inotify` or `kqueue`: the file is on this machine, a dev server appends to it a
/// few times a second at most, and at [`FOLLOW_POLL`] the difference is invisible to the human
/// reading it — while a watcher would be a second platform-specific code path to keep working on
/// both macOS and Linux, for no gain the user can perceive.
///
/// `keep_going` is asked once per poll and again before each line, rather than `on_line`
/// returning a verdict: a log that has gone quiet delivers no lines at all, and a stop condition
/// that can only be expressed between two lines would never be consulted again. A caller's
/// Ctrl-C has to land on a silent service too.
///
/// Only whole lines are delivered. A `write` caught half-finished would otherwise be shown as
/// two lines, one of which never existed.
pub fn follow(
    state: &Utf8Path,
    name: &str,
    lines: usize,
    poll: Duration,
    on_line: &mut dyn FnMut(&str),
    keep_going: &dyn Fn() -> bool,
) -> Result<(), ServiceError> {
    let log = log_path(state, name);
    // Taken *before* the history, not after: a line appended in between is then shown twice
    // rather than not at all, and a duplicated line in a log is a nuisance where a missing one
    // is a bug report.
    let mut offset = file_len(&log);
    for line in logs(state, name, lines)? {
        if !keep_going() {
            return Ok(());
        }
        on_line(&line);
    }
    while keep_going() {
        let (fresh, next) = read_from(&log, offset)?;
        offset = next;
        for line in fresh {
            if !keep_going() {
                return Ok(());
            }
            on_line(&line);
        }
        std::thread::sleep(poll.as_std());
    }
    Ok(())
}

/// The log's current length, or `0` when there is no log yet.
fn file_len(path: &Utf8Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// Complete lines from `offset` on, and the offset to resume from.
fn read_from(log: &Utf8Path, offset: u64) -> Result<(Vec<String>, u64), ServiceError> {
    let io = |source: std::io::Error| ServiceError::Io { path: log.to_owned(), source };
    let mut file = File::open(log).map_err(io)?;
    let length = file.seek(SeekFrom::End(0)).map_err(io)?;
    // A log that got *shorter* was rotated or truncated under us. Resuming from the old offset
    // would seek past its end and read nothing, forever.
    let start = if length < offset { 0 } else { offset };
    let end = length.min(start.saturating_add(FOLLOW_CHUNK));
    file.seek(SeekFrom::Start(start)).map_err(io)?;
    let mut buffer = vec![0u8; (end - start) as usize];
    file.read_exact(&mut buffer).map_err(io)?;

    let mut consumed = 0usize;
    let mut out = Vec::new();
    // Split on bytes, not on the lossy string: a replacement character is three bytes where the
    // byte it replaced was one, and counting the wrong one would walk the offset off the file.
    for chunk in buffer.split_inclusive(|byte| *byte == b'\n') {
        if chunk.last() != Some(&b'\n') {
            break;
        }
        consumed += chunk.len();
        let text = String::from_utf8_lossy(&chunk[..chunk.len() - 1]);
        out.push(text.trim_end_matches('\r').to_owned());
    }
    Ok((out, start.saturating_add(consumed as u64)))
}

// ---------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------

/// The order to act in, with `only` checked against what is declared.
///
/// A `--only` name that matches nothing is an error rather than an empty run: silence would
/// report a clean, instant, completely successful `up` that started nothing at all, and the typo
/// would be found much later.
fn plan(
    services: &BTreeMap<String, ServiceSpec>,
    only: Option<&BTreeSet<String>>,
) -> Result<Vec<String>, ServiceError> {
    if let Some(set) = only {
        for name in set {
            if !services.contains_key(name) {
                return Err(ServiceError::Unknown(name.clone()));
            }
        }
    }
    start_order(services, only).map_err(ServiceError::Order)
}

fn ensure_dirs(state: &Utf8Path) -> Result<(), ServiceError> {
    for dir in [state.join(RECORDS_DIR), state.join(LOGS_DIR)] {
        fs::create_dir_all(&dir).map_err(|source| ServiceError::Io { path: dir.clone(), source })?;
    }
    Ok(())
}

/// The runtime a service would use, and why this module may refuse it.
///
/// `defaults.runtime` is not visible here — this module is handed services, not the whole
/// config — so an undeclared runtime is the built-in `host`. A caller that honours
/// `defaults.runtime` should set `runtime:` on the spec before calling in.
fn effective_runtime(spec: &ServiceSpec) -> Runtime {
    if spec.compose.is_some() {
        return Runtime::Compose;
    }
    spec.runtime.unwrap_or(Runtime::Host)
}

/// `Some(reason)` for a service this version cannot touch.
fn unsupported(spec: &ServiceSpec) -> Option<String> {
    let label = match effective_runtime(spec) {
        Runtime::Host => return None,
        Runtime::Docker => "docker",
        Runtime::Compose => "compose",
    };
    Some(format!("runtime {label} is not supported in this version — host services only"))
}

/// The record for `name`, but only while the process it names is still the one we started.
fn live_record(state: &Utf8Path, name: &str) -> Option<ProcessRecord> {
    let record = proc::read_record(&record_path(state, name)).ok()?;
    matches!(proc::state(&record), ProcessState::Running { .. }).then_some(record)
}

fn service_cwd(spec: &ServiceSpec, ctx: &ServiceContext<'_>) -> Utf8PathBuf {
    match &spec.cwd {
        Some(cwd) => ctx.worktree.join(cwd),
        None => ctx.worktree.to_owned(),
    }
}

/// The environment one service is spawned with: the worktree's table, then the service's own
/// `env:` on top, each value interpolated against the same scope the table came from — so a
/// service's `PORT: ${ports.web}` and the `run:` beside it cannot disagree about the number.
fn service_env(spec: &ServiceSpec, ctx: &ServiceContext<'_>) -> BTreeMap<String, String> {
    let mut env = ctx.env.to_map();
    for (key, value) in &spec.env {
        env.insert(key.clone(), interpolate(value, ctx.facts, ctx.env));
    }
    env
}

fn resolve_health(
    name: &str,
    check: &crate::config::HealthCheck,
    ctx: &ServiceContext<'_>,
) -> Result<ResolvedHealth, ServiceError> {
    health::resolve(check, |text| interpolate(text, ctx.facts, ctx.env))
        .map_err(|source| ServiceError::Health { name: name.to_owned(), source })
}

fn verdict_detail(verdict: &Verdict) -> String {
    match verdict {
        Verdict::Unhealthy { detail, .. } | Verdict::TimedOut { detail, .. } => detail.clone(),
        Verdict::Healthy { .. } => String::new(),
    }
}

/// How long ago the record was written, in milliseconds.
///
/// Second resolution, because that is all the record stores. It is a number a human reads beside
/// a service name, never an input to a decision — those all go through the kernel.
fn uptime_ms(record: &ProcessRecord) -> Option<u64> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(now.saturating_sub(record.started_at).saturating_mul(1000))
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::time::Instant as TestInstant;

    use rstest::rstest;
    use tempfile::TempDir;

    use super::*;
    use crate::config::CanopyConfig;
    use crate::env;

    // -----------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------

    /// How long a test waits for something the OS does on its own schedule. Generous, because it
    /// is only ever reached when a test is failing.
    const PATIENCE: std::time::Duration = std::time::Duration::from_secs(5);

    /// A ceiling on every `follow` test.
    ///
    /// `follow` is an endless loop by design, so a bug that stops it delivering lines would
    /// stall the suite instead of failing it. Each test's `on_line` stops once this passes, in
    /// whichever direction the bug points, and the assertion on what was collected is then what
    /// reports the failure.
    const FOLLOW_LIMIT: std::time::Duration = std::time::Duration::from_secs(2);

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
            Harness::with_ports(BTreeMap::new())
        }

        fn with_ports(ports: BTreeMap<String, u16>) -> Harness {
            let dir = TempDir::new().expect("temp dir");
            let root = Utf8PathBuf::from_path_buf(dir.path().to_path_buf()).expect("utf-8 temp dir");
            let worktree = root.join("wt");
            let state = root.join("state");
            fs::create_dir_all(&worktree).expect("worktree");
            let table = {
                let facts = Facts {
                    worktree_name: "wt",
                    worktree_path: &worktree,
                    branch: "feature/x",
                    project: "proj",
                    project_path: &worktree,
                    ports: &ports,
                };
                env::resolve(
                    &CanopyConfig::empty(),
                    &facts,
                    &BTreeMap::from([("GREETING".to_owned(), "hello".to_owned())]),
                )
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

        /// A file the service wrote into the worktree, or `""` when it has not appeared yet.
        fn wrote(&self, name: &str) -> String {
            fs::read_to_string(self.worktree.join(name)).unwrap_or_default()
        }

        fn record(&self, name: &str) -> ProcessRecord {
            proc::read_record(&record_path(&self.state, name)).expect("record")
        }

        fn put_record(&self, name: &str, record: &ProcessRecord) {
            proc::write_record(&record_path(&self.state, name), record).expect("write record");
        }

        fn has_record(&self, name: &str) -> bool {
            record_path(&self.state, name).exists()
        }
    }

    fn specs(yaml: &str) -> BTreeMap<String, ServiceSpec> {
        serde_saphyr::from_str(yaml).expect("test services parse")
    }

    fn chosen(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    fn names(statuses: &[ServiceStatus]) -> Vec<&str> {
        statuses.iter().map(|status| status.name.as_str()).collect()
    }

    fn find<'a>(statuses: &'a [ServiceStatus], name: &str) -> &'a ServiceStatus {
        statuses.iter().find(|status| status.name == name).expect("a status for that service")
    }

    /// Polls until `ready`, up to [`PATIENCE`]. Never a bare sleep: a fixed one is either flaky
    /// or slow, and usually both.
    fn wait_until(mut ready: impl FnMut() -> bool) -> bool {
        let deadline = TestInstant::now() + PATIENCE;
        while TestInstant::now() < deadline {
            if ready() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        ready()
    }

    fn pid_alive(pid: i32) -> bool {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    /// A pid that is certainly free: a child we started, waited for, and reaped.
    fn reaped_pid() -> i32 {
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().expect("spawn");
        let pid = child.id() as i32;
        child.wait().expect("wait");
        pid
    }

    // -----------------------------------------------------------------------------------
    // up
    // -----------------------------------------------------------------------------------

    #[test]
    fn up_starts_a_service_and_status_reports_it_running() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        let started = up(&services, None, &ctx, false).expect("up");
        assert_eq!(names(&started), ["web"]);
        assert_eq!(started[0].state, RunState::Running);
        assert_eq!(started[0].health, None, "no health block means nothing to report");
        let pid = started[0].pid.expect("a pid");
        assert!(pid > 0);
        assert!(pid_alive(pid));

        let now = status(&services, None, &ctx).expect("status");
        assert_eq!(now[0].state, RunState::Running);
        assert_eq!(now[0].pid, Some(pid));
        assert!(now[0].uptime_ms.is_some());

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn up_is_idempotent() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        let first = up(&services, None, &ctx, false).expect("up");
        let before = harness.record("web");

        let second = up(&services, None, &ctx, false).expect("up again");
        let after = harness.record("web");

        assert_eq!(second[0].pid, first[0].pid);
        assert_eq!(second[0].state, RunState::Running);
        // The launch id is fresh for every spawn, so an unchanged one is proof that the second
        // `up` started nothing — a race between two `up`s loses gracefully.
        assert_eq!(after.launch_id, before.launch_id);

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn up_restarts_a_service_whose_process_is_gone() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nonce:\n  run: \"exit 0\"\n");

        up(&services, None, &ctx, false).expect("up");
        let first = harness.record("once");
        up(&services, None, &ctx, false).expect("up again");
        let second = harness.record("once");

        assert_ne!(second.launch_id, first.launch_id, "a dead record is not a running service");
    }

    #[test]
    fn the_service_survives_the_process_that_started_it() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        // Well over the 64 KiB a pipe buffers. If anything in this crate were draining the
        // child's output — or worse, had handed it a pipe and walked away — the service would
        // block forever at the 64 KiB mark and never reach the flag.
        let services = specs(
            "
noisy:
  run: |
    i=0
    while [ $i -lt 2000 ]; do
      echo 0123456789012345678901234567890123456789012345678901234567890123456789
      i=$((i+1))
    done
    : > done.flag
    sleep 30
",
        );

        let started = up(&services, None, &ctx, false).expect("up");
        let pid = started[0].pid.expect("a pid");
        // Everything `up` handed back is gone; nothing supervises the service from here.
        drop(started);

        assert!(wait_until(|| harness.worktree.join("done.flag").exists()), "the service blocked on its output");
        assert!(pid_alive(pid), "the service died with the call that started it");
        assert!(file_len(&log_path(&harness.state, "noisy")) > 64 * 1024, "the log should hold all of it");

        let later = status(&services, None, &ctx).expect("status");
        assert_eq!(later[0].state, RunState::Running);
        assert_eq!(later[0].pid, Some(pid));

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn services_start_in_dependency_order() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        // Alphabetical order would be api, db, web — so an ordering that ignored depends_on
        // would produce a different file.
        let services = specs(
            "
api:
  depends_on: [db]
  run: |
    echo api >> order.txt
    sleep 30
db:
  run: |
    echo db >> order.txt
    sleep 30
web:
  depends_on: [api]
  run: |
    echo web >> order.txt
    sleep 30
",
        );

        let started = up(&services, None, &ctx, false).expect("up");
        assert_eq!(names(&started), ["db", "api", "web"]);
        assert!(wait_until(|| harness.wrote("order.txt").lines().count() == 3));
        assert_eq!(harness.wrote("order.txt"), "db\napi\nweb\n");

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn only_starts_the_named_services_and_their_order_still_holds() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
api:
  depends_on: [zed]
  run: |
    echo api >> order.txt
    sleep 30
web:
  run: |
    echo web >> order.txt
    sleep 30
zed:
  run: |
    echo zed >> order.txt
    sleep 30
",
        );

        let started = up(&services, Some(&chosen(&["api", "zed"])), &ctx, false).expect("up");
        assert_eq!(names(&started), ["zed", "api"]);
        assert!(!harness.has_record("web"), "web was not asked for");
        assert!(wait_until(|| harness.wrote("order.txt").lines().count() == 2));
        assert_eq!(harness.wrote("order.txt"), "zed\napi\n");

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn only_rejects_a_name_that_is_not_declared() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        let error = up(&services, Some(&chosen(&["wbe"])), &ctx, false).expect_err("a typo is not an empty run");
        assert!(matches!(error, ServiceError::Unknown(ref name) if name == "wbe"), "{error}");
        assert_eq!(error.code(), ErrorCode::ConfigInvalid);
        assert!(!harness.has_record("web"), "nothing starts when the selection is wrong");
    }

    #[test]
    fn autostart_false_is_skipped_unless_named() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
manual:
  autostart: false
  run: \"sleep 30\"
web:
  run: \"sleep 30\"
",
        );

        let started = up(&services, None, &ctx, false).expect("up");
        assert_eq!(find(&started, "manual").state, RunState::Stopped);
        assert_eq!(find(&started, "manual").detail.as_deref(), Some("autostart is false"));
        assert!(!harness.has_record("manual"), "skipped means nothing was registered");
        assert_eq!(find(&started, "web").state, RunState::Running);

        let named = up(&services, Some(&chosen(&["manual"])), &ctx, false).expect("up --only manual");
        assert_eq!(names(&named), ["manual"]);
        assert_eq!(named[0].state, RunState::Running);

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn a_command_that_fails_instantly_is_reported_exited_not_running() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nbroken:\n  run: \"exit 3\"\n");

        let started = up(&services, None, &ctx, false).expect("up");
        assert_eq!(started[0].state, RunState::Exited, "the grace period exists for exactly this");
        assert_eq!(started[0].pid, None);
        assert_eq!(started[0].detail, None, "it said nothing on the way out, so there is nothing to quote");
        assert!(harness.has_record("broken"), "the record is kept so status and logs can explain");
    }

    #[test]
    fn the_log_tail_of_a_crashed_service_explains_why() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
api:
  run: |
    echo \"Error: cannot find module 'left-pad'\" >&2
    exit 1
",
        );

        let started = up(&services, None, &ctx, false).expect("up");
        assert_eq!(started[0].state, RunState::Exited);
        let detail = started[0].detail.as_deref().expect("the reason");
        assert!(detail.contains("left-pad"), "{detail}");

        let reported = status(&services, None, &ctx).expect("status");
        assert!(reported[0].detail.as_deref().is_some_and(|text| text.contains("left-pad")));
        assert_eq!(logs(&harness.state, "api", 10).expect("logs"), ["Error: cannot find module 'left-pad'"]);
    }

    #[test]
    fn up_reports_a_command_that_cannot_be_spawned_as_failed() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  cwd: nowhere/at/all\n  run: \"sleep 30\"\n");

        let started = up(&services, None, &ctx, false).expect("one bad service is not a failed command");
        assert_eq!(started[0].state, RunState::Failed);
        assert!(started[0].detail.as_deref().is_some_and(|text| text.contains("could not start")));
        assert!(!harness.has_record("web"));
    }

    #[test]
    fn up_without_a_run_command_is_a_config_error() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  description: a service someone forgot to finish\n");

        let error = up(&services, None, &ctx, false).expect_err("nothing to run");
        assert!(matches!(error, ServiceError::NoCommand { ref name } if name == "web"), "{error}");
        assert_eq!(error.code(), ErrorCode::ConfigInvalid);
    }

    #[test]
    fn up_fails_when_the_state_directory_cannot_be_made() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        fs::create_dir_all(&harness.state).expect("state");
        fs::write(harness.state.join(RECORDS_DIR), "not a directory").expect("blocker");
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        let error = up(&services, None, &ctx, false).expect_err("nowhere to put the records");
        assert!(matches!(error, ServiceError::Io { .. }), "{error}");
        assert_eq!(error.code(), ErrorCode::Io);
    }

    #[test]
    fn services_run_in_their_declared_cwd() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        fs::create_dir_all(harness.worktree.join("apps/web")).expect("nested dir");
        let services = specs(
            "
web:
  cwd: apps/web
  run: |
    : > here.txt
    sleep 30
",
        );

        up(&services, None, &ctx, false).expect("up");
        assert!(wait_until(|| harness.worktree.join("apps/web/here.txt").exists()));
        assert!(!harness.worktree.join("here.txt").exists(), "it ran in the worktree root instead");

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn the_service_env_layers_over_the_worktree_env() {
        let harness = Harness::with_ports(BTreeMap::from([("web".to_owned(), 4123)]));
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
web:
  env:
    TARGET: \"port-${ports.web}\"
  run: |
    echo \"$GREETING $TARGET\" > env.txt
    sleep 30
",
        );

        up(&services, None, &ctx, false).expect("up");
        assert!(wait_until(|| !harness.wrote("env.txt").is_empty()));
        assert_eq!(harness.wrote("env.txt"), "hello port-4123\n");

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn run_and_health_targets_are_interpolated() {
        // The port the worktree was allocated, held open for the health check to find.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let harness = Harness::with_ports(BTreeMap::from([("web".to_owned(), port)]));
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
web:
  health:
    tcp: \"${ports.web}\"
    interval: 10ms
    timeout: 500ms
    retries: 2
  run: |
    echo ${ports.web} > port.txt
    sleep 30
",
        );

        let started = up(&services, None, &ctx, true).expect("up --wait");
        assert_eq!(started[0].state, RunState::Running);
        assert_eq!(started[0].health, Some(health::Status::Healthy), "the tcp target resolved to the real port");
        assert!(wait_until(|| !harness.wrote("port.txt").is_empty()));
        assert_eq!(harness.wrote("port.txt").trim(), port.to_string(), "the run command got the same number");

        down(&services, None, &ctx).expect("down");
        drop(listener);
    }

    #[test]
    fn up_with_wait_returns_when_the_service_is_healthy() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
web:
  health:
    cmd: \"test -f ready.flag\"
    interval: 10ms
    timeout: 1s
    retries: 20
  run: |
    : > ready.flag
    sleep 30
",
        );

        let started = up(&services, None, &ctx, true).expect("up --wait");
        assert_eq!(started[0].state, RunState::Running);
        assert_eq!(started[0].health, Some(health::Status::Healthy));

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn up_without_wait_reports_a_health_checked_service_as_starting() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
web:
  health:
    cmd: \"true\"
    interval: 10ms
    timeout: 1s
  run: \"sleep 30\"
",
        );

        let started = up(&services, None, &ctx, false).expect("up");
        // Alive, but nobody asked us to find out whether it is serving yet.
        assert_eq!(started[0].state, RunState::Starting);
        assert_eq!(started[0].health, None);
        assert!(started[0].pid.is_some());

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn up_with_wait_fails_when_health_never_passes_and_does_not_start_dependents() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
api:
  health:
    cmd: \"echo 'connection refused on 5432' >&2; exit 1\"
    interval: 10ms
    timeout: 500ms
    retries: 1
  run: \"sleep 30\"
web:
  depends_on: [api]
  run: \"sleep 30\"
",
        );

        let error = up(&services, None, &ctx, true).expect_err("api never came up");
        let ServiceError::NeverHealthy { ref name, ref detail } = error else { panic!("{error}") };
        assert_eq!(name, "api");
        // The probe's own words, not a generic "unhealthy" of ours. Which words depends on the
        // machine: a refused connection normally, a timeout when the box is loaded enough that
        // connecting to a closed port outlasts the probe budget. Both are the probe talking.
        assert!(
            detail.contains("5432") || detail.contains("timed out"),
            "the detail should carry the probe's own words: {detail}"
        );
        assert!(error.to_string().contains(detail.as_str()));
        assert_eq!(error.code(), ErrorCode::ServiceFailed);
        assert!(harness.has_record("api"), "it is left running so its logs can be read");
        assert!(!harness.has_record("web"), "a client of a server that never came up is not started");

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn up_refuses_a_health_block_it_cannot_resolve() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
web:
  health:
    http: \"http://127.0.0.1:1/\"
    tcp: 1
  run: \"sleep 30\"
",
        );

        let error = up(&services, None, &ctx, false).expect_err("two probes is not a check");
        assert!(matches!(error, ServiceError::Health { ref name, .. } if name == "web"), "{error}");
        assert_eq!(error.code(), ErrorCode::ConfigInvalid);
        assert!(!harness.has_record("web"), "resolved before the spawn, so nothing was started");
    }

    #[rstest]
    #[case("\ndb:\n  runtime: docker\n  run: \"sleep 30\"\n", "docker")]
    #[case("\ndb:\n  compose:\n    file: docker-compose.yml\n", "compose")]
    fn a_docker_runtime_service_is_reported_unsupported_not_silently_skipped(#[case] yaml: &str, #[case] label: &str) {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(yaml);

        for statuses in [
            up(&services, None, &ctx, false).expect("up"),
            status(&services, None, &ctx).expect("status"),
            down(&services, None, &ctx).expect("down"),
        ] {
            assert_eq!(statuses[0].state, RunState::Unsupported);
            let detail = statuses[0].detail.as_deref().expect("a reason");
            assert!(detail.contains(label) && detail.contains("not supported"), "{detail}");
        }
        assert!(!harness.has_record("db"));
    }

    // -----------------------------------------------------------------------------------
    // down
    // -----------------------------------------------------------------------------------

    #[test]
    fn down_stops_in_reverse_dependency_order() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
api:
  depends_on: [db]
  stop_timeout: 2s
  run: |
    trap 'echo api >> stop.txt; exit 0' TERM
    while :; do sleep 0.1; done
db:
  stop_timeout: 2s
  run: |
    trap 'echo db >> stop.txt; exit 0' TERM
    while :; do sleep 0.1; done
web:
  depends_on: [api]
  stop_timeout: 2s
  run: |
    trap 'echo web >> stop.txt; exit 0' TERM
    while :; do sleep 0.1; done
",
        );

        up(&services, None, &ctx, false).expect("up");
        let stopped = down(&services, None, &ctx).expect("down");

        assert_eq!(names(&stopped), ["web", "api", "db"]);
        assert!(stopped.iter().all(|status| status.state == RunState::Stopped));
        assert!(wait_until(|| harness.wrote("stop.txt").lines().count() == 3));
        assert_eq!(harness.wrote("stop.txt"), "web\napi\ndb\n");
    }

    #[test]
    fn down_kills_the_whole_process_group() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        // The shell forks two children and waits. Signalling only the shell would leave both
        // `sleep 60`s running — which, for a real dev server, is the watcher still holding the
        // port after `down` said it was gone.
        let services = specs(
            "
pair:
  run: |
    sleep 60 &
    echo $! >> pids.txt
    sleep 60 &
    echo $! >> pids.txt
    wait
",
        );

        up(&services, None, &ctx, false).expect("up");
        assert!(
            wait_until(|| harness.wrote("pids.txt").lines().count() == 2),
            "the children never announced themselves"
        );
        let children: Vec<i32> =
            harness.wrote("pids.txt").lines().map(|line| line.trim().parse().expect("a pid")).collect();
        assert!(children.iter().all(|pid| pid_alive(*pid)));

        down(&services, None, &ctx).expect("down");

        for pid in children {
            assert!(wait_until(|| !pid_alive(pid)), "grandchild {pid} outlived the group it belonged to");
        }
    }

    #[test]
    fn down_removes_the_record() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        up(&services, None, &ctx, false).expect("up");
        assert!(harness.has_record("web"));

        let stopped = down(&services, None, &ctx).expect("down");
        assert_eq!(stopped[0].state, RunState::Stopped);
        assert_eq!(stopped[0].detail, None, "a clean stop needs no explanation");
        assert!(!harness.has_record("web"));
    }

    #[test]
    fn down_on_a_stopped_service_is_not_an_error() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        let first = down(&services, None, &ctx).expect("down on nothing");
        assert_eq!(first[0].state, RunState::Stopped);
        assert_eq!(first[0].detail, None);

        up(&services, None, &ctx, false).expect("up");
        down(&services, None, &ctx).expect("down");
        let again = down(&services, None, &ctx).expect("down twice");
        assert_eq!(again[0].state, RunState::Stopped);
    }

    #[test]
    fn down_on_a_service_that_already_exited_clears_the_record() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nonce:\n  run: \"exit 0\"\n");

        up(&services, None, &ctx, false).expect("up");
        assert!(harness.has_record("once"));

        let stopped = down(&services, None, &ctx).expect("down");
        assert_eq!(stopped[0].state, RunState::Stopped);
        assert_eq!(stopped[0].detail.as_deref(), Some("it had already exited"));
        assert!(!harness.has_record("once"));
    }

    #[test]
    fn down_kills_a_service_that_ignores_the_stop_signal() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
stubborn:
  stop_timeout: 300ms
  run: |
    trap '' TERM
    while :; do sleep 0.1; done
",
        );

        up(&services, None, &ctx, false).expect("up");
        let pid = harness.record("stubborn").pid;

        let stopped = down(&services, None, &ctx).expect("down");
        assert_eq!(stopped[0].state, RunState::Stopped);
        assert!(stopped[0].detail.as_deref().is_some_and(|text| text.contains("was killed")), "{stopped:?}");
        assert!(wait_until(|| !pid_alive(pid)));
        assert!(!harness.has_record("stubborn"));
    }

    #[test]
    fn down_refuses_a_record_whose_pid_was_reused() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        up(&services, None, &ctx, false).expect("up");
        let real = harness.record("web");
        // The pid is alive, but it started at a different instant than we recorded: as far as
        // anything here can tell, it now belongs to somebody else's editor.
        harness.put_record(
            "web",
            &ProcessRecord { start_time: Some("Thu Jan 1 00:00:00 1970".to_owned()), ..real.clone() },
        );

        let stopped = down(&services, None, &ctx).expect("down");
        assert_eq!(stopped[0].state, RunState::Failed);
        assert!(stopped[0].detail.as_deref().is_some_and(|text| text.contains("reused")), "{stopped:?}");
        assert!(harness.has_record("web"), "the record is the evidence that something leaked");
        assert!(pid_alive(real.pid), "it must not be killed");

        harness.put_record("web", &real);
        down(&services, None, &ctx).expect("cleanup");
    }

    #[test]
    fn down_on_a_corrupt_record_is_a_failure_not_a_silent_success() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");
        fs::create_dir_all(harness.state.join(RECORDS_DIR)).expect("records dir");
        fs::write(record_path(&harness.state, "web"), "{ truncated").expect("corrupt record");

        let stopped = down(&services, None, &ctx).expect("down");
        assert_eq!(stopped[0].state, RunState::Failed, "a record we cannot read is a process we cannot stop");
        assert!(stopped[0].detail.as_deref().is_some_and(|text| text.contains("not a usable process record")));
        assert!(harness.has_record("web"));
    }

    // -----------------------------------------------------------------------------------
    // status
    // -----------------------------------------------------------------------------------

    #[test]
    fn status_reverifies_liveness_rather_than_trusting_the_record() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");
        fs::create_dir_all(harness.state.join(RECORDS_DIR)).expect("records dir");
        let pid = reaped_pid();
        harness.put_record(
            "web",
            &ProcessRecord {
                pid,
                pgid: pid,
                start_time: None,
                launch_id: "0".repeat(32),
                command: "sleep 30".to_owned(),
                cwd: harness.worktree.clone(),
                log: log_path(&harness.state, "web"),
                started_at: 0,
            },
        );

        let reported = status(&services, None, &ctx).expect("status");
        assert_eq!(reported[0].state, RunState::Exited, "the file said running; the kernel disagreed");
        assert_eq!(reported[0].pid, None);
        assert_eq!(reported[0].uptime_ms, None);
    }

    #[test]
    fn status_reports_a_reused_pid_as_exited() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        up(&services, None, &ctx, false).expect("up");
        let real = harness.record("web");
        harness.put_record(
            "web",
            &ProcessRecord { start_time: Some("Thu Jan 1 00:00:00 1970".to_owned()), ..real.clone() },
        );

        let reported = status(&services, None, &ctx).expect("status");
        assert_eq!(reported[0].state, RunState::Exited);
        assert_eq!(reported[0].pid, None);
        assert!(reported[0].detail.as_deref().is_some_and(|text| text.contains("belongs to another process")));

        harness.put_record("web", &real);
        down(&services, None, &ctx).expect("cleanup");
    }

    #[rstest]
    // Condemned on the first counted failure.
    #[case(1, "0s", RunState::Unhealthy, health::Status::Unhealthy { detail: String::new() })]
    // Failing, but not yet condemned — still not serving, so still the same one word.
    #[case(5, "0s", RunState::Unhealthy, health::Status::Failing { failures: 1 })]
    // Inside the start period, where failures do not count at all.
    #[case(1, "5m", RunState::Starting, health::Status::Starting)]
    fn status_reads_a_failing_probe_through_the_start_period(
        #[case] retries: u32,
        #[case] start_period: &str,
        #[case] expected: RunState,
        #[case] shape: health::Status,
    ) {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(&format!(
            "
web:
  health:
    cmd: \"false\"
    interval: 10ms
    timeout: 1s
    retries: {retries}
    start_period: {start_period}
  run: \"sleep 30\"
"
        ));

        up(&services, None, &ctx, false).expect("up");
        let reported = status(&services, None, &ctx).expect("status");

        assert_eq!(reported[0].state, expected);
        assert_eq!(
            std::mem::discriminant(reported[0].health.as_ref().expect("a reading")),
            std::mem::discriminant(&shape)
        );
        if let health::Status::Failing { failures } = shape {
            assert_eq!(reported[0].health, Some(health::Status::Failing { failures }));
        }

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn status_reports_a_healthy_service_as_running() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
web:
  health:
    cmd: \"true\"
    interval: 10ms
    timeout: 1s
  run: \"sleep 30\"
",
        );

        up(&services, None, &ctx, false).expect("up");
        let reported = status(&services, None, &ctx).expect("status");
        assert_eq!(reported[0].state, RunState::Running);
        assert_eq!(reported[0].health, Some(health::Status::Healthy));

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn status_surfaces_a_health_block_that_cannot_be_resolved() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let running = specs("\nweb:\n  run: \"sleep 30\"\n");
        // The same service, as a later edit to canopy.yaml left it.
        let edited = specs("\nweb:\n  health:\n    interval: 10ms\n  run: \"sleep 30\"\n");

        up(&running, None, &ctx, false).expect("up");
        let reported = status(&edited, None, &ctx).expect("status");

        assert_eq!(reported[0].state, RunState::Running, "the process is fine; it is the check that is broken");
        assert_eq!(reported[0].health, None);
        assert!(reported[0].detail.as_deref().is_some_and(|text| text.contains("exactly one of")), "{reported:?}");

        down(&running, None, &ctx).expect("down");
    }

    #[test]
    fn status_reports_uptime_from_the_record() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");

        up(&services, None, &ctx, false).expect("up");
        let record = harness.record("web");
        // Back-dated rather than slept through: the arithmetic is what is being tested.
        harness.put_record("web", &ProcessRecord { started_at: record.started_at - 5, ..record });

        let reported = status(&services, None, &ctx).expect("status");
        let uptime = reported[0].uptime_ms.expect("an uptime");
        assert!((5_000..60_000).contains(&uptime), "uptime was {uptime}ms");

        down(&services, None, &ctx).expect("down");
    }

    #[test]
    fn status_on_a_corrupt_record_is_failed() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs("\nweb:\n  run: \"sleep 30\"\n");
        fs::create_dir_all(harness.state.join(RECORDS_DIR)).expect("records dir");
        fs::write(record_path(&harness.state, "web"), "{ truncated").expect("corrupt record");

        let reported = status(&services, None, &ctx).expect("status");
        assert_eq!(reported[0].state, RunState::Failed);
        assert!(reported[0].detail.as_deref().is_some_and(|text| text.contains("not a usable process record")));
    }

    #[test]
    fn status_reports_declared_and_inferred_ports() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
api:
  ports: [api, admin]
  run: \"sleep 30\"
web:
  run: \"serve --port ${ports.web}\"
",
        );

        let reported = status(&services, None, &ctx).expect("status");
        assert_eq!(find(&reported, "api").ports, ["api", "admin"]);
        assert_eq!(find(&reported, "web").ports, ["web"]);
        assert!(reported.iter().all(|status| status.state == RunState::Stopped));
    }

    // -----------------------------------------------------------------------------------
    // logs
    // -----------------------------------------------------------------------------------

    #[test]
    fn logs_returns_the_tail() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
chatty:
  run: |
    echo one
    echo two
    echo three
    echo four
",
        );

        up(&services, None, &ctx, false).expect("up");
        assert_eq!(logs(&harness.state, "chatty", 2).expect("logs"), ["three", "four"]);
        assert_eq!(logs(&harness.state, "chatty", 99).expect("logs"), ["one", "two", "three", "four"]);
    }

    #[test]
    fn logs_for_a_service_with_no_log_is_an_error() {
        let harness = Harness::new();

        let error = logs(&harness.state, "web", 10).expect_err("there is no such log");
        assert!(matches!(error, ServiceError::NoLog { ref name, .. } if name == "web"), "{error}");
        assert_eq!(error.code(), ErrorCode::Io);
    }

    #[test]
    fn logs_follow_sees_new_lines() {
        let harness = Harness::new();
        let log = log_path(&harness.state, "web");
        fs::create_dir_all(log.parent().expect("logs dir")).expect("logs dir");
        fs::write(&log, "old-1\nold-2\n").expect("seed");

        let appender = log.clone();
        let writer = std::thread::spawn(move || {
            for index in 0..3 {
                std::thread::sleep(std::time::Duration::from_millis(20));
                let mut file = fs::OpenOptions::new().append(true).open(&appender).expect("append");
                writeln!(file, "new-{index}").expect("write");
            }
        });

        let stop_by = TestInstant::now() + FOLLOW_LIMIT;
        let seen: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
        follow(
            &harness.state,
            "web",
            1,
            Duration::from_millis(5),
            &mut |line| seen.borrow_mut().push(line.to_owned()),
            &|| seen.borrow().len() < 4 && TestInstant::now() < stop_by,
        )
        .expect("follow");
        writer.join().expect("writer");
        let seen = seen.into_inner();

        // Exact, not "contains": an offset that failed to advance would replay the file forever.
        assert_eq!(seen, ["old-2", "new-0", "new-1", "new-2"]);
    }

    #[test]
    fn logs_follow_recovers_when_the_log_is_truncated() {
        let harness = Harness::new();
        let log = log_path(&harness.state, "web");
        fs::create_dir_all(log.parent().expect("logs dir")).expect("logs dir");
        fs::write(&log, "before-1\nbefore-2\n").expect("seed");

        let rotated = log.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            fs::write(&rotated, "z\n").expect("truncate and replace");
        });

        let stop_by = TestInstant::now() + FOLLOW_LIMIT;
        let seen: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
        follow(
            &harness.state,
            "web",
            0,
            Duration::from_millis(5),
            &mut |line| seen.borrow_mut().push(line.to_owned()),
            &|| seen.borrow().is_empty() && TestInstant::now() < stop_by,
        )
        .expect("follow");
        writer.join().expect("writer");
        let seen = seen.into_inner();

        assert_eq!(seen, ["z"], "a shorter file means it was rotated, not that we are past its end");
    }

    #[test]
    fn logs_follow_stops_when_the_caller_says_so() {
        let harness = Harness::new();
        let log = log_path(&harness.state, "web");
        fs::create_dir_all(log.parent().expect("logs dir")).expect("logs dir");
        fs::write(&log, "one\ntwo\nthree\n").expect("seed");

        let stop_by = TestInstant::now() + FOLLOW_LIMIT;
        let seen: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
        follow(
            &harness.state,
            "web",
            10,
            Duration::from_millis(5),
            &mut |line| seen.borrow_mut().push(line.to_owned()),
            &|| seen.borrow().is_empty() && TestInstant::now() < stop_by,
        )
        .expect("follow");

        assert_eq!(seen.into_inner(), ["one"], "the history is delivered a line at a time and can be cut off");
    }

    // -----------------------------------------------------------------------------------
    // Ordering and errors
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_dependency_cycle_is_an_error() {
        let harness = Harness::new();
        let facts = harness.facts();
        let ctx = harness.ctx(&facts);
        let services = specs(
            "
api:
  depends_on: [web]
  run: \"sleep 30\"
web:
  depends_on: [api]
  run: \"sleep 30\"
",
        );

        for error in [
            up(&services, None, &ctx, false).expect_err("up"),
            down(&services, None, &ctx).expect_err("down"),
            status(&services, None, &ctx).expect_err("status"),
        ] {
            assert!(matches!(error, ServiceError::Order(_)), "{error}");
            assert!(error.to_string().contains("cycle"), "{error}");
            assert_eq!(error.code(), ErrorCode::ConfigInvalid);
        }
        assert!(!harness.has_record("api"), "nothing starts when the order cannot be worked out");
    }

    #[rstest]
    #[case(ServiceError::Order("depends_on cycle: a → a".to_owned()), ErrorCode::ConfigInvalid)]
    #[case(ServiceError::Unknown("nope".to_owned()), ErrorCode::ConfigInvalid)]
    #[case(ServiceError::NoCommand { name: "web".to_owned() }, ErrorCode::ConfigInvalid)]
    #[case(
        ServiceError::Health { name: "web".to_owned(), source: HealthError::NoProbe },
        ErrorCode::ConfigInvalid
    )]
    #[case(
        ServiceError::NeverHealthy { name: "web".to_owned(), detail: "refused".to_owned() },
        ErrorCode::ServiceFailed
    )]
    #[case(
        ServiceError::Io { path: Utf8PathBuf::from("/x"), source: std::io::Error::other("nope") },
        ErrorCode::Io
    )]
    #[case(ServiceError::NoLog { name: "web".to_owned(), path: Utf8PathBuf::from("/x") }, ErrorCode::Io)]
    // Delegated: `proc` already chose a code for each of its own failures.
    #[case(
        ServiceError::Proc(ProcError::Log { path: Utf8PathBuf::from("/x"), source: std::io::Error::other("nope") }),
        ErrorCode::ServiceFailed
    )]
    #[case(ServiceError::Proc(ProcError::Io(std::io::Error::other("nope"))), ErrorCode::Io)]
    fn every_error_carries_the_code_its_caller_branches_on(#[case] error: ServiceError, #[case] expected: ErrorCode) {
        assert_eq!(error.code(), expected);
        assert!(!error.to_string().is_empty());
        let lifted: crate::error::Error = error.into();
        assert_eq!(lifted.code(), expected, "the code survives being lifted to the crate error");
    }
}
