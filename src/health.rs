//! Health probing — is the service actually serving, or merely running?
//!
//! A port of `packages/daemon/src/env/services/health.ts`. Three probe kinds, exactly one per
//! service (`config check` enforces that; [`resolve`] still refuses rather than guesses).
//!
//! Two rules shape everything here:
//!
//! - **A failing probe is data, not an error.** [`ResolvedHealth::probe_once`] returns
//!   [`Probe::Unhealthy`] for every failure mode including timeouts, so a supervisor's poll loop
//!   cannot be silently killed by an error escaping out of it.
//! - **Templates are resolved once.** `http: http://127.0.0.1:${ports.web}/` is interpolated at
//!   [`resolve`] time, not per tick; re-rendering the same string every three seconds is waste,
//!   and a target that changes under a running loop is a bug nobody will find.

use std::collections::BTreeMap;
use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus, Stdio};
use std::time::Instant;

use camino::Utf8Path;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use serde::Serialize;

use crate::config::{Duration, HealthCheck};

/// Head-room on top of `start_period + retries * (interval + timeout)`.
///
/// The arithmetic bound assumes probes cost nothing but their timeout; process spawn, DNS and
/// scheduler jitter all cost a little more. A caller that waits exactly the arithmetic bound
/// would occasionally give up one probe early.
const SETTLE_SLACK: Duration = Duration::from_secs(1);

/// How often the `cmd` probe asks whether the child has exited.
const CHILD_POLL: std::time::Duration = std::time::Duration::from_millis(5);

/// How long the `cmd` probe waits for the stderr pipe to drain after the child is done.
///
/// Bounded on purpose: a command that leaves a background process holding the write end
/// (`cmd: check.sh &`) keeps the pipe open forever, and an unbounded read would hang the probe
/// long after the command it was probing had finished.
const STDERR_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

/// How long the `cmd` probe waits for a killed child to be reaped.
///
/// SIGKILL cannot be caught, so in practice this is over at once. It is bounded anyway because
/// `probe_once` promises not to outlast its timeout, and a blocking `wait` would break that
/// promise if the signal ever failed to land — a child that put itself in another process group,
/// for instance. Giving up leaves a zombie until the process exits, which is the cheaper failure.
const REAP_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/// Why a `health:` block could not be turned into something probeable.
///
/// Module-local rather than an [`crate::Error`] variant: these are config mistakes surfaced by
/// the linter, not failures of a command the user ran.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HealthError {
    #[error("a health check needs exactly one of http, tcp or cmd; none is set")]
    NoProbe,

    #[error("a health check needs exactly one of http, tcp or cmd; {0} are set")]
    MultipleProbes(String),

    #[error("health tcp {0:?} is not a port between 1 and 65535")]
    BadPort(String),

    #[error("health http {0:?} is not an http:// or https:// URL")]
    BadUrl(String),

    #[error("health cmd is empty")]
    EmptyCmd,
}

// ---------------------------------------------------------------------------------------
// The resolved check
// ---------------------------------------------------------------------------------------

/// What to probe, with every `${...}` already substituted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Target {
    Http { url: String },
    Tcp { port: u16 },
    Cmd { cmd: String },
}

/// The timing half of a check, separated from the target so the poll loop can be driven (and
/// tested) without a real socket or subprocess behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Timing {
    /// Wait between the end of one probe and the start of the next.
    pub interval: Duration,
    /// Cut a single probe off after this long.
    pub timeout: Duration,
    /// Consecutive counted failures before the verdict is unhealthy. `0` condemns on the first.
    pub retries: u32,
    /// Grace window after start during which failures do not count towards `retries`.
    pub start_period: Duration,
}

impl Timing {
    pub fn of(check: &HealthCheck) -> Timing {
        Timing {
            interval: check.interval,
            timeout: check.timeout,
            retries: check.retries,
            start_period: check.start_period,
        }
    }
}

/// A health check ready to run: an interpolated [`Target`] plus its [`Timing`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedHealth {
    pub target: Target,
    pub timing: Timing,
}

/// Applies `interpolate` to the one target that is set, exactly once.
///
/// The caller owns template substitution — this module has no idea what `${ports.web}` means and
/// should not learn. Whatever comes back is used verbatim.
pub fn resolve(check: &HealthCheck, interpolate: impl Fn(&str) -> String) -> Result<ResolvedHealth, HealthError> {
    let set: Vec<&str> = [("http", check.http.is_some()), ("tcp", check.tcp.is_some()), ("cmd", check.cmd.is_some())]
        .into_iter()
        .filter(|(_, present)| *present)
        .map(|(name, _)| name)
        .collect();
    if set.len() > 1 {
        return Err(HealthError::MultipleProbes(set.join(", ")));
    }

    // "none of them is set" falls out of the last arm of this chain rather than getting an early
    // return of its own: two spellings of one refusal is one more than can be kept in agreement.
    let target = if let Some(http) = &check.http {
        let url = interpolate(http);
        if !is_probeable_url(&url) {
            return Err(HealthError::BadUrl(url));
        }
        Target::Http { url }
    } else if let Some(tcp) = &check.tcp {
        let text = interpolate(&tcp.as_text());
        let port: u16 = text.trim().parse().map_err(|_| HealthError::BadPort(text.clone()))?;
        if port == 0 {
            return Err(HealthError::BadPort(text));
        }
        Target::Tcp { port }
    } else if let Some(cmd) = &check.cmd {
        let cmd = interpolate(cmd);
        if cmd.trim().is_empty() {
            return Err(HealthError::EmptyCmd);
        }
        Target::Cmd { cmd }
    } else {
        return Err(HealthError::NoProbe);
    };

    Ok(ResolvedHealth { target, timing: Timing::of(check) })
}

/// Rejects at resolve time what would otherwise fail identically on every tick for minutes.
fn is_probeable_url(url: &str) -> bool {
    let Ok(uri) = url.parse::<ureq::http::Uri>() else {
        return false;
    };
    matches!(uri.scheme_str(), Some("http" | "https")) && uri.host().is_some_and(|host| !host.is_empty())
}

// ---------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------

/// The result of one probe. Never an error: every failure mode is `Unhealthy` with a reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Probe {
    Healthy,
    Unhealthy { detail: String },
}

impl Probe {
    pub fn is_healthy(&self) -> bool {
        matches!(self, Probe::Healthy)
    }

    /// The failure reason, or `""` when healthy.
    pub fn detail(&self) -> &str {
        match self {
            Probe::Healthy => "",
            Probe::Unhealthy { detail } => detail,
        }
    }
}

/// What one probe means in the context of the ones before it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Status {
    Healthy,
    /// Failed, but inside `start_period`, so it did not count.
    Starting,
    /// Failed and counted, but the run of failures is still short of `retries`.
    Failing {
        failures: u32,
    },
    /// `retries` consecutive counted failures.
    Unhealthy {
        detail: String,
    },
}

/// The verdict of a whole [`ResolvedHealth::wait_until_healthy`] run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum Verdict {
    Healthy {
        after: Duration,
        probes: u32,
    },
    Unhealthy {
        detail: String,
        after: Duration,
        probes: u32,
    },
    /// The budget ran out while the service was still only *failing*. Distinct from `Unhealthy`:
    /// the service was never condemned, we simply stopped waiting, and the caller may keep it.
    TimedOut {
        detail: String,
        after: Duration,
        probes: u32,
    },
}

impl Verdict {
    pub fn is_healthy(&self) -> bool {
        matches!(self, Verdict::Healthy { .. })
    }

    pub fn probes(&self) -> u32 {
        match self {
            Verdict::Healthy { probes, .. } | Verdict::Unhealthy { probes, .. } | Verdict::TimedOut { probes, .. } => {
                *probes
            }
        }
    }

    pub fn after(&self) -> Duration {
        match self {
            Verdict::Healthy { after, .. } | Verdict::Unhealthy { after, .. } | Verdict::TimedOut { after, .. } => {
                *after
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// The failure counter
// ---------------------------------------------------------------------------------------

/// The consecutive-failure counter and its grace window, as a value you can step by hand.
///
/// Split out of the poll loop because a supervisor watching a long-running service needs the
/// same bookkeeping without the loop: it probes on its own schedule and asks what each result
/// means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tracker {
    retries: u32,
    start_period: Duration,
    failures: u32,
}

impl Tracker {
    pub fn new(timing: &Timing) -> Tracker {
        Tracker { retries: timing.retries, start_period: timing.start_period, failures: 0 }
    }

    /// Folds one probe in. `elapsed` is measured from the moment the service started.
    ///
    /// A success resets the run: `retries` counts *consecutive* failures, so a service that
    /// flaps between good and bad is never condemned by the total.
    pub fn record(&mut self, elapsed: Duration, probe: &Probe) -> Status {
        match probe {
            Probe::Healthy => {
                self.failures = 0;
                Status::Healthy
            }
            Probe::Unhealthy { detail } => {
                if elapsed < self.start_period {
                    return Status::Starting;
                }
                self.failures = self.failures.saturating_add(1);
                if self.failures >= self.retries {
                    Status::Unhealthy { detail: detail.clone() }
                } else {
                    Status::Failing { failures: self.failures }
                }
            }
        }
    }

    /// Length of the current run of counted failures.
    pub fn failures(&self) -> u32 {
        self.failures
    }
}

// ---------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------

/// The only two things the poll loop needs from time, so tests can supply both.
pub trait Clock {
    /// Monotonic milliseconds. Only differences between two readings are meaningful.
    fn now(&self) -> u64;
    fn sleep(&self, nap: Duration);
}

/// The real clock: [`Instant`] and [`std::thread::sleep`].
#[derive(Debug, Clone)]
pub struct SystemClock(Instant);

impl SystemClock {
    pub fn new() -> SystemClock {
        SystemClock(Instant::now())
    }
}

impl Default for SystemClock {
    fn default() -> SystemClock {
        SystemClock::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> u64 {
        u64::try_from(self.0.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn sleep(&self, nap: Duration) {
        std::thread::sleep(nap.as_std());
    }
}

// ---------------------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------------------

impl Timing {
    /// How long a caller should be willing to wait for this check to settle.
    ///
    /// `start_period + retries * (interval + timeout) + slack` — the worst case where every
    /// probe burns its whole timeout and every gap is a whole interval. Saturating throughout:
    /// an absurd `retries` in a config should produce a huge bound, not a panic.
    pub fn settle_bound(&self) -> Duration {
        let per_attempt = self.interval.as_millis().saturating_add(self.timeout.as_millis());
        let attempts = u64::from(self.retries).saturating_mul(per_attempt);
        Duration::from_millis(
            self.start_period.as_millis().saturating_add(attempts).saturating_add(SETTLE_SLACK.as_millis()),
        )
    }

    /// Runs `probe` until it succeeds, the failure run reaches `retries`, or the budget is spent.
    ///
    /// `deadline` of `None` means [`Timing::settle_bound`].
    pub fn poll<C: Clock>(&self, clock: &C, mut probe: impl FnMut() -> Probe, deadline: Option<Duration>) -> Verdict {
        let budget = deadline.unwrap_or_else(|| self.settle_bound());
        let start = clock.now();
        let mut tracker = Tracker::new(self);
        let mut probes: u32 = 0;
        let mut last_detail = String::new();

        loop {
            let outcome = probe();
            probes = probes.saturating_add(1);
            let elapsed = Duration::from_millis(clock.now().saturating_sub(start));
            if let Probe::Unhealthy { detail } = &outcome {
                last_detail.clone_from(detail);
            }
            match tracker.record(elapsed, &outcome) {
                Status::Healthy => return Verdict::Healthy { after: elapsed, probes },
                Status::Unhealthy { detail } => return Verdict::Unhealthy { detail, after: elapsed, probes },
                Status::Starting | Status::Failing { .. } => {}
            }
            if !self.nap(clock, start, budget) {
                let after = Duration::from_millis(clock.now().saturating_sub(start));
                return Verdict::TimedOut { detail: last_detail, after, probes };
            }
        }
    }

    /// Sleeps until the next probe is due. `false` once the budget is gone.
    ///
    /// A chain of one-shot sleeps, deliberately *not* a fixed-rate ticker. A ticker that fires
    /// every `interval` regardless of how long the last probe took will queue probes up behind a
    /// slow one and pile load onto the service that is already struggling — the exact moment you
    /// least want to. Waiting `interval` *after* each probe returns keeps at most one in flight.
    fn nap<C: Clock>(&self, clock: &C, start: u64, budget: Duration) -> bool {
        let remaining = budget.as_millis().saturating_sub(clock.now().saturating_sub(start));
        if remaining == 0 {
            return false;
        }
        // At least 1ms: `interval: 0ms` is legal config, and sleeping zero on a virtual clock
        // would spin forever without the budget ever advancing.
        let nap = self.interval.as_millis().max(1).min(remaining);
        clock.sleep(Duration::from_millis(nap));
        clock.now().saturating_sub(start) < budget.as_millis()
    }
}

impl ResolvedHealth {
    /// Runs one probe. Never blocks longer than `timing.timeout` plus process-spawn overhead.
    pub fn probe_once(&self, cwd: &Utf8Path, env: &BTreeMap<String, String>) -> Probe {
        match &self.target {
            Target::Http { url } => probe_http(url, self.timing.timeout),
            Target::Tcp { port } => probe_tcp(*port, self.timing.timeout),
            Target::Cmd { cmd } => probe_cmd(cmd, cwd, env, self.timing.timeout),
        }
    }

    /// Polls until healthy, condemned, or out of budget. `None` uses [`Self::settle_bound`].
    pub fn wait_until_healthy(
        &self,
        cwd: &Utf8Path,
        env: &BTreeMap<String, String>,
        deadline: Option<Duration>,
    ) -> Verdict {
        self.timing.poll(&SystemClock::new(), || self.probe_once(cwd, env), deadline)
    }

    pub fn settle_bound(&self) -> Duration {
        self.timing.settle_bound()
    }
}

// ---------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------

/// 2xx and 3xx are up.
///
/// A 3xx counts because a service behind a login wall answers `/` with a 302 to its identity
/// provider — it is serving, and demanding a 200 would mean it never comes up. A 1xx is not a
/// completed response, so it is not an answer either way and does not count as healthy.
fn status_is_healthy(status: u16) -> bool {
    (200..400).contains(&status)
}

fn probe_http(url: &str, timeout: Duration) -> Probe {
    let config = ureq::Agent::config_builder()
        // Do not chase the redirect. The 302 already told us the service is up, and following it
        // can hang against an identity provider on an unroutable or slow host — turning a healthy
        // service into a timeout.
        .max_redirects(0)
        // A 500 is a fact about the service, not a transport failure; we want the number.
        .http_status_as_error(false)
        .timeout_global(Some(timeout.as_std()))
        .build();
    match ureq::Agent::new_with_config(config).get(url).call() {
        Ok(response) => {
            let status = response.status().as_u16();
            if status_is_healthy(status) {
                Probe::Healthy
            } else {
                Probe::Unhealthy { detail: format!("HTTP {status}") }
            }
        }
        Err(err) => Probe::Unhealthy { detail: format!("GET {url}: {err}") },
    }
}

/// `127.0.0.1`, never `localhost`: on macOS `localhost` resolves to `::1` first, so a check
/// against an IPv4-bound service fails while the service is running perfectly.
fn probe_tcp(port: u16, timeout: Duration) -> Probe {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    // `connect_timeout` rejects a zero duration outright, which would report every probe as a
    // bad argument rather than as a connection failure.
    let budget = timeout.as_std().max(std::time::Duration::from_millis(1));
    match TcpStream::connect_timeout(&addr, budget) {
        Ok(_) => Probe::Healthy,
        Err(err) => Probe::Unhealthy { detail: format!("127.0.0.1:{port}: {err}") },
    }
}

/// The last non-blank line, which is where a CLI puts the message that matters.
fn last_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).rfind(|line| !line.is_empty()).map(str::to_owned)
}

fn describe(status: ExitStatus) -> String {
    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exit {code}"),
        (None, Some(signal)) => format!("killed by signal {signal}"),
        (None, None) => "exited abnormally".to_owned(),
    }
}

/// The argument `kill(2)` wants for "everything in this pid's group": the pid, negated.
///
/// `None` for anything that cannot be negated safely. Group `0` is the caller's *own* group, so
/// a pid of 0 — or one too large to fit in a `pid_t` — must not be turned into a signal.
fn group_of(pid: u32) -> Option<Pid> {
    match i32::try_from(pid) {
        Ok(pid) if pid > 0 => Some(Pid::from_raw(-pid)),
        _ => None,
    }
}

/// SIGKILLs the whole group, and says whether anything was signalled.
///
/// The group, not the process, is the point: `sh -c 'x & y'` leaves `x` running for as long as it
/// likes when only the shell is killed. `false` is the refusal from [`group_of`] — a pid with no
/// group this process may name — reported rather than swallowed, because the alternative to
/// naming it is a `kill(-0, …)` that takes the caller and everything sharing its terminal.
fn kill_group(pid: u32) -> bool {
    match group_of(pid) {
        Some(group) => signal::kill(group, Signal::SIGKILL).is_ok(),
        None => false,
    }
}

/// Collects an already-signalled child, giving up rather than blocking forever.
fn reap_briefly(child: &mut std::process::Child) {
    let deadline = Instant::now() + REAP_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        std::thread::sleep(CHILD_POLL.min(deadline - now));
    }
}

// Overrides the next `try_wait` for one test.
//
// A `waitpid` that fails means somebody else collected the child, and the only pid that could be
// collected behind this probe's back is one it never reveals. The branch it guards decides
// whether a probe that has lost track of its child still kills the group and still says what
// went wrong instead of blaming a timeout, so — like `proc`'s start-time reader — it is worth a
// thread-local.
#[cfg(test)]
thread_local! {
    static FORCED_WAIT_ERROR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn try_wait(child: &mut std::process::Child) -> std::io::Result<Option<ExitStatus>> {
    #[cfg(test)]
    {
        if FORCED_WAIT_ERROR.with(std::cell::Cell::take) {
            return Err(std::io::Error::from_raw_os_error(nix::errno::Errno::ECHILD as i32));
        }
    }
    child.try_wait()
}

fn probe_cmd(cmd: &str, cwd: &Utf8Path, env: &BTreeMap<String, String>, timeout: Duration) -> Probe {
    let spawned = Command::new("/bin/sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(cwd)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Its own process group, so the timeout path can kill everything the command started and
        // not just the shell that started it.
        .process_group(0)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(err) => return Probe::Unhealthy { detail: format!("/bin/sh -c {cmd:?}: {err}") },
    };
    let pid = child.id();

    // Drained on a thread: a command that fills the stderr pipe would otherwise block forever
    // while we sit in `try_wait`.
    let pipe = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        // Piped at spawn, so this is always `Some`; mapping through it rather than unwrapping
        // costs nothing and keeps a probe from panicking if that ever stops being true.
        let drained = pipe.map(|mut pipe| {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        });
        let _ = tx.send(drained.unwrap_or_default());
    });

    let deadline = Instant::now() + timeout.as_std().max(std::time::Duration::from_millis(1));
    let exited = loop {
        match try_wait(&mut child) {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(err) => {
                kill_group(pid);
                reap_briefly(&mut child);
                return Probe::Unhealthy { detail: format!("/bin/sh -c {cmd:?}: {err}") };
            }
        }
        let now = Instant::now();
        if now >= deadline {
            break None;
        }
        std::thread::sleep(CHILD_POLL.min(deadline - now));
    };

    let Some(status) = exited else {
        kill_group(pid);
        reap_briefly(&mut child);
        return Probe::Unhealthy { detail: format!("timed out after {timeout}") };
    };

    if status.success() {
        return Probe::Healthy;
    }
    let stderr = rx.recv_timeout(STDERR_GRACE).unwrap_or_default();
    let detail = last_line(&String::from_utf8_lossy(&stderr)).unwrap_or_else(|| describe(status));
    Probe::Unhealthy { detail }
}

// ---------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    use rstest::rstest;

    use super::*;
    use crate::config::TcpTarget;

    // -----------------------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------------------

    fn check(http: Option<&str>, tcp: Option<TcpTarget>, cmd: Option<&str>) -> HealthCheck {
        HealthCheck {
            http: http.map(str::to_owned),
            tcp,
            cmd: cmd.map(str::to_owned),
            interval: Duration::from_secs(3),
            timeout: Duration::from_secs(3),
            retries: 10,
            start_period: Duration::ZERO,
        }
    }

    fn timing(interval_ms: u64, timeout_ms: u64, retries: u32, start_ms: u64) -> Timing {
        Timing {
            interval: Duration::from_millis(interval_ms),
            timeout: Duration::from_millis(timeout_ms),
            retries,
            start_period: Duration::from_millis(start_ms),
        }
    }

    fn cwd() -> &'static Utf8Path {
        Utf8Path::new("/")
    }

    fn no_env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    /// The interpolation that changes nothing, shared by every `resolve` test that is not about
    /// interpolation — one function rather than a lambda each, so the tests below are asking the
    /// same question of the same code.
    fn verbatim(text: &str) -> String {
        text.to_owned()
    }

    fn unhealthy(detail: &str) -> Probe {
        Probe::Unhealthy { detail: detail.to_owned() }
    }

    /// A virtual clock: `sleep` advances time instead of spending it, so timing tests are exact
    /// and the whole suite stays in the millisecond range.
    #[derive(Debug, Default)]
    struct TestClock {
        millis: Cell<u64>,
        naps: std::cell::RefCell<Vec<u64>>,
    }

    impl TestClock {
        fn advance(&self, millis: u64) {
            self.millis.set(self.millis.get() + millis);
        }

        fn naps(&self) -> Vec<u64> {
            self.naps.borrow().clone()
        }
    }

    impl Clock for TestClock {
        fn now(&self) -> u64 {
            self.millis.get()
        }

        fn sleep(&self, nap: Duration) {
            self.naps.borrow_mut().push(nap.as_millis());
            self.advance(nap.as_millis());
        }
    }

    /// Serves `response` verbatim to every connection, after reading the request headers so the
    /// client is never writing into a socket nobody is draining.
    fn serve(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let Ok(peer) = stream.try_clone() else { continue };
                let mut reader = BufReader::new(peer);
                let mut line = String::new();
                // A read of nothing, or one that fails, means the client went away mid-request;
                // either way there is no more request to drain.
                while reader.read_line(&mut line).is_ok_and(|read| read > 0) {
                    if line == "\r\n" || line == "\n" {
                        break;
                    }
                    line.clear();
                }
                let mut stream = stream;
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        port
    }

    /// Accepts connections and answers none of them, holding each socket open.
    fn serve_silently() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().flatten() {
                held.push(stream);
            }
        });
        port
    }

    /// A port with nothing behind it.
    ///
    /// Deliberately *not* "bind port 0, read the number, drop it": another test binding an
    /// ephemeral port can claim that number in the gap, and the probe then connects happily to
    /// somebody else's listener. These low ports are outside the range the OS hands out, and each
    /// is confirmed to refuse before it is used.
    fn closed_port() -> u16 {
        let refused = |port: u16| {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(200)).is_err()
        };
        [1u16, 2, 3, 4, 6, 7].into_iter().find(|port| refused(*port)).expect("every low port answered")
    }

    fn http_check(url: &str, timeout_ms: u64) -> ResolvedHealth {
        ResolvedHealth { target: Target::Http { url: url.to_owned() }, timing: timing(10, timeout_ms, 1, 0) }
    }

    fn cmd_check(cmd: &str, timeout_ms: u64) -> ResolvedHealth {
        ResolvedHealth { target: Target::Cmd { cmd: cmd.to_owned() }, timing: timing(10, timeout_ms, 1, 0) }
    }

    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    // -----------------------------------------------------------------------------------
    // HTTP
    // -----------------------------------------------------------------------------------

    #[test]
    fn http_200_is_healthy() {
        let port = serve(OK);
        let health = http_check(&format!("http://127.0.0.1:{port}/"), 2000);
        assert_eq!(health.probe_once(cwd(), &no_env()), Probe::Healthy);
    }

    #[test]
    fn http_302_is_healthy_and_the_redirect_is_not_followed() {
        // TEST-NET-1: guaranteed unroutable. If the probe followed the Location it would sit
        // there until its timeout instead of returning the 302 it already has.
        let port = serve(
            "HTTP/1.1 302 Found\r\nLocation: http://192.0.2.1/login\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let health = http_check(&format!("http://127.0.0.1:{port}/"), 30_000);
        let began = Instant::now();
        let probe = health.probe_once(cwd(), &no_env());
        let took = began.elapsed();

        assert_eq!(probe, Probe::Healthy);
        // Far below the 30s timeout: proof it answered from the 302 rather than chasing it.
        assert!(took < std::time::Duration::from_secs(5), "took {took:?}, so the redirect was followed");
    }

    #[test]
    fn http_500_is_unhealthy_with_the_status_in_the_detail() {
        let port = serve("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let health = http_check(&format!("http://127.0.0.1:{port}/"), 2000);
        assert_eq!(health.probe_once(cwd(), &no_env()), unhealthy("HTTP 500"));
    }

    #[test]
    fn http_404_is_unhealthy_with_the_status_in_the_detail() {
        let port = serve("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let health = http_check(&format!("http://127.0.0.1:{port}/"), 2000);
        assert_eq!(health.probe_once(cwd(), &no_env()), unhealthy("HTTP 404"));
    }

    #[rstest]
    // 1xx is not a completed response, so it is not a healthy one.
    #[case(100, false)]
    #[case(199, false)]
    #[case(200, true)]
    #[case(204, true)]
    #[case(299, true)]
    // A login-wall redirect means the service is serving.
    #[case(300, true)]
    #[case(302, true)]
    #[case(399, true)]
    #[case(400, false)]
    #[case(404, false)]
    #[case(499, false)]
    #[case(500, false)]
    #[case(503, false)]
    fn the_healthy_status_range_is_200_to_399(#[case] status: u16, #[case] healthy: bool) {
        assert_eq!(status_is_healthy(status), healthy, "status {status}");
    }

    #[test]
    fn http_connection_refused_is_unhealthy_not_an_error() {
        let port = closed_port();
        let url = format!("http://127.0.0.1:{port}/");
        let probe = http_check(&url, 2000).probe_once(cwd(), &no_env());

        let Probe::Unhealthy { detail } = probe else { panic!("refused should be unhealthy, got {probe:?}") };
        assert!(detail.starts_with(&format!("GET {url}: ")), "detail was {detail:?}");
    }

    #[test]
    fn http_respects_its_timeout() {
        let port = serve_silently();
        let health = http_check(&format!("http://127.0.0.1:{port}/"), 200);
        let began = Instant::now();
        let probe = health.probe_once(cwd(), &no_env());
        let took = began.elapsed();

        assert!(!probe.is_healthy(), "a server that never answers is not healthy");
        // ureq applies no timeout unless told to, so any finite return at all is the point.
        assert!(took < std::time::Duration::from_secs(10), "took {took:?}");
        assert!(!probe.detail().is_empty());
    }

    // -----------------------------------------------------------------------------------
    // TCP
    // -----------------------------------------------------------------------------------

    #[test]
    fn tcp_is_healthy_when_something_is_listening() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let health = ResolvedHealth { target: Target::Tcp { port }, timing: timing(10, 1000, 1, 0) };
        assert_eq!(health.probe_once(cwd(), &no_env()), Probe::Healthy);
    }

    #[test]
    fn tcp_is_unhealthy_when_nothing_is() {
        let port = closed_port();
        let health = ResolvedHealth { target: Target::Tcp { port }, timing: timing(10, 1000, 1, 0) };
        let probe = health.probe_once(cwd(), &no_env());

        let Probe::Unhealthy { detail } = probe else { panic!("nothing listening should be unhealthy") };
        assert!(detail.starts_with(&format!("127.0.0.1:{port}: ")), "detail was {detail:?}");
    }

    #[test]
    fn a_zero_tcp_timeout_still_reports_a_connection_failure() {
        // `connect_timeout` rejects a zero duration; without the 1ms floor every probe would
        // report an invalid argument instead of the connection result.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let health = ResolvedHealth { target: Target::Tcp { port }, timing: timing(10, 0, 1, 0) };
        assert_eq!(health.probe_once(cwd(), &no_env()), Probe::Healthy);
    }

    // -----------------------------------------------------------------------------------
    // cmd
    // -----------------------------------------------------------------------------------

    #[test]
    fn cmd_exit_0_is_healthy() {
        assert_eq!(cmd_check("exit 0", 5000).probe_once(cwd(), &no_env()), Probe::Healthy);
    }

    #[test]
    fn cmd_nonzero_is_unhealthy_and_the_last_stderr_line_is_the_detail() {
        let health = cmd_check("echo first >&2; echo 'could not connect' >&2; exit 3", 5000);
        assert_eq!(health.probe_once(cwd(), &no_env()), unhealthy("could not connect"));
    }

    #[test]
    fn cmd_with_silent_failure_falls_back_to_the_exit_code() {
        assert_eq!(cmd_check("exit 7", 5000).probe_once(cwd(), &no_env()), unhealthy("exit 7"));
    }

    #[test]
    fn cmd_killed_by_a_signal_says_so() {
        // No stderr, and no exit code either — only a signal number.
        assert_eq!(cmd_check("kill -9 $$", 5000).probe_once(cwd(), &no_env()), unhealthy("killed by signal 9"));
    }

    #[test]
    fn a_status_that_is_neither_an_exit_nor_a_kill_still_reads_as_a_sentence() {
        // A stopped child reports no code and no signal. `probe_cmd` waits without WUNTRACED so
        // it never sees one, but `describe` is what a detail is built from and a `None, None` it
        // did not handle would be a panic in the middle of a poll loop.
        let stopped = ExitStatus::from_raw(0x137f);
        assert_eq!((stopped.code(), stopped.signal()), (None, None), "{stopped:?} is not a stop");
        assert_eq!(describe(stopped), "exited abnormally");
    }

    #[test]
    fn cmd_runs_in_the_given_cwd_with_the_given_env() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = Utf8Path::from_path(dir.path()).expect("utf8").to_owned();
        let mut env = BTreeMap::new();
        env.insert("CANOPY_HEALTH_PROBE".to_owned(), "yes".to_owned());

        let health = cmd_check("test \"$CANOPY_HEALTH_PROBE\" = yes && test -d \"$PWD\"", 5000);
        assert_eq!(health.probe_once(&dir, &env), Probe::Healthy);

        let wrong = cmd_check("test \"$CANOPY_HEALTH_PROBE\" = no", 5000);
        assert_eq!(wrong.probe_once(&dir, &env), unhealthy("exit 1"));
    }

    #[test]
    fn a_cmd_that_cannot_be_run_is_unhealthy_not_a_panic() {
        let health =
            ResolvedHealth { target: Target::Cmd { cmd: "exit 0".to_owned() }, timing: timing(10, 1000, 1, 0) };
        let probe = health.probe_once(Utf8Path::new("/no/such/directory/anywhere"), &no_env());
        assert!(!probe.is_healthy(), "a bad cwd should be unhealthy, got {probe:?}");
    }

    /// A sleep duration nothing else is using: this test binary's pid with a digit appended.
    /// Neither another test in this run nor an orphan from an earlier one can collide with it,
    /// which is what lets the tests below count processes by name and believe the answer.
    fn token(suffix: u8) -> String {
        format!("{}{suffix}", std::process::id())
    }

    /// Kills any `sleep <token>` left over from an interrupted earlier run, so the
    /// "the children really started" assertions below cannot be satisfied by a ghost.
    fn reap(token: &str) {
        let _ = Command::new("pkill").args(["-f", &format!("sleep {token}")]).status();
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    /// Every running process's command line, in one sweep. One sweep matters: `ps` can easily
    /// take longer than a probe's timeout, so two of them straddle the kill being asserted about.
    fn process_snapshot() -> String {
        let out = Command::new("ps").args(["-A", "-o", "command"]).output().expect("ps");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn count_in(snapshot: &str, needle: &str) -> usize {
        snapshot.lines().filter(|line| line.contains(needle)).count()
    }

    /// The first sweep that satisfies `ok`, or the last one taken before `limit_ms` runs out.
    ///
    /// A single `ps` sample is a coin flip on a loaded machine: it can take longer than the very
    /// timeout the test is racing. Polling makes the check about what happened, not about how
    /// busy the box was.
    fn snapshot_until(limit_ms: u64, ok: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + std::time::Duration::from_millis(limit_ms);
        loop {
            let snapshot = process_snapshot();
            if ok(&snapshot) || Instant::now() >= deadline {
                return snapshot;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// How many processes currently have `needle` on their command line.
    fn processes_matching(needle: &str) -> usize {
        count_in(&process_snapshot(), needle)
    }

    #[test]
    fn cmd_timeout_kills_the_whole_process_group() {
        // Two distinctive sleeps: one backgrounded, one in the foreground. Killing only the shell
        // would leave the backgrounded one orphaned and running for five minutes — the exact bug
        // process groups exist to prevent.
        let (bg, fg) = (token(1), token(2));
        let (bg, fg) = (bg.as_str(), fg.as_str());
        reap(bg);
        reap(fg);
        assert_eq!(processes_matching(bg), 0, "stale process from an earlier run");
        assert_eq!(processes_matching(fg), 0, "stale process from an earlier run");

        // The timeout is the ceiling on how long there is to observe the children, since it is
        // what kills them. 1500ms left barely 1200ms to see two processes appear, which a
        // loaded machine loses; the extra seconds here buy the observation real headroom and
        // cost only this one test.
        let health = cmd_check(&format!("sleep {bg} & sleep {fg}"), 6000);
        let probe = std::thread::spawn(move || health.probe_once(Utf8Path::new("/"), &BTreeMap::new()));

        // Mid-probe, from one sweep: both children must actually exist, or the assertions after
        // the timeout prove nothing at all.
        let running = snapshot_until(5000, |snap| count_in(snap, bg) >= 1 && count_in(snap, fg) >= 1);
        assert!(count_in(&running, bg) >= 1, "the backgrounded child never started");
        assert!(count_in(&running, fg) >= 1, "the foreground child never started");

        let probe = probe.join().expect("probe thread");
        assert_eq!(probe, unhealthy("timed out after 6s"));

        let after = snapshot_until(10_000, |snap| count_in(snap, bg) == 0 && count_in(snap, fg) == 0);
        assert_eq!(count_in(&after, bg), 0, "the backgrounded child survived the timeout");
        assert_eq!(count_in(&after, fg), 0, "the foreground child survived the timeout");
    }

    #[test]
    fn cmd_does_not_wait_for_a_background_child_holding_stderr() {
        // The command exits at once but leaves a process holding the stderr pipe open. An
        // unbounded read of that pipe would hang the probe for five minutes.
        let token = token(3);
        reap(&token);
        let health = cmd_check(&format!("sleep {token} & exit 4"), 5000);
        let began = Instant::now();
        let probe = health.probe_once(cwd(), &no_env());
        let took = began.elapsed();

        assert!(!probe.is_healthy());
        // Generous on purpose: the bug this guards against waits for a `sleep` measured in days,
        // so seconds of slack still prove it, and a tight bound only buys flakes.
        assert!(took < std::time::Duration::from_secs(10), "took {took:?}");
        reap(&token);
    }

    /// Makes the next `try_wait` inside `probe_cmd` fail, once. See [`FORCED_WAIT_ERROR`].
    fn force_wait_error() {
        FORCED_WAIT_ERROR.with(|armed| armed.set(true));
    }

    #[test]
    fn a_wait_that_fails_is_reported_as_itself_and_still_kills_the_child() {
        // Losing track of the child is not a slow service. Reporting it as a timeout would send
        // the user to look at something that was answering fine, and returning without the kill
        // would leave the command running for the whole minute it asked for.
        let token = token(6);
        let token = token.as_str();
        reap(token);
        assert_eq!(processes_matching(token), 0, "stale process from an earlier run");

        // A minute of timeout, so nothing but the wait failure can end this probe.
        let health = cmd_check(&format!("sleep {token}"), 60_000);
        force_wait_error();
        let began = Instant::now();
        let probe = health.probe_once(Utf8Path::new("/"), &no_env());
        let took = began.elapsed();

        assert!(!probe.is_healthy(), "{probe:?}");
        assert!(!probe.detail().contains("timed out"), "a lost child is not a timeout: {:?}", probe.detail());
        assert!(probe.detail().starts_with("/bin/sh -c "), "{:?} does not name the command", probe.detail());
        assert!(took < std::time::Duration::from_secs(10), "waited {took:?} on a wait that had already failed");
        // The child is the group leader and wears the token on its command line, so it is gone
        // only if the probe killed it on the way out.
        let after = snapshot_until(10_000, |snap| count_in(snap, token) == 0);
        reap(token);
        assert_eq!(count_in(&after, token), 0, "the child outlived the probe that lost it");
    }

    #[rstest]
    #[case("", None)]
    #[case("\n\n", None)]
    #[case("only", Some("only"))]
    #[case("one\ntwo", Some("two"))]
    // A trailing newline must not make the detail empty.
    #[case("one\ntwo\n", Some("two"))]
    #[case("one\n  spaced  \n", Some("spaced"))]
    #[case("one\ntwo\n\n\n", Some("two"))]
    fn the_detail_is_the_last_non_blank_stderr_line(#[case] text: &str, #[case] expected: Option<&str>) {
        assert_eq!(last_line(text).as_deref(), expected);
    }

    // -----------------------------------------------------------------------------------
    // resolve
    // -----------------------------------------------------------------------------------

    #[test]
    fn resolve_interpolates_each_target_exactly_once() {
        let calls = Cell::new(0usize);
        let counting = |text: &str| {
            calls.set(calls.get() + 1);
            text.replace("${ports.web}", "8100")
        };

        let resolved = resolve(&check(Some("http://127.0.0.1:${ports.web}/healthz"), None, None), counting).unwrap();
        assert_eq!(resolved.target, Target::Http { url: "http://127.0.0.1:8100/healthz".to_owned() });
        assert_eq!(calls.get(), 1, "http was interpolated {} times", calls.get());

        calls.set(0);
        let tcp = check(None, Some(TcpTarget::Template("${ports.web}".to_owned())), None);
        assert_eq!(resolve(&tcp, counting).unwrap().target, Target::Tcp { port: 8100 });
        assert_eq!(calls.get(), 1, "tcp was interpolated {} times", calls.get());

        calls.set(0);
        let cmd = check(None, None, Some("curl -sf localhost:${ports.web}"));
        assert_eq!(resolve(&cmd, counting).unwrap().target, Target::Cmd { cmd: "curl -sf localhost:8100".to_owned() });
        assert_eq!(calls.get(), 1, "cmd was interpolated {} times", calls.get());

        // Zero times for a check that is refused: rendering a template only pays off for a check
        // somebody is going to run, and this one names two probes and will never be run at all.
        calls.set(0);
        let both = check(Some("http://127.0.0.1:${ports.web}/"), Some(TcpTarget::Port(1)), None);
        assert!(resolve(&both, counting).is_err(), "two probes in one check must be refused");
        assert_eq!(calls.get(), 0, "a check that was refused had its templates rendered anyway");
    }

    #[test]
    fn resolve_carries_the_timings_through_unchanged() {
        let mut spec = check(None, Some(TcpTarget::Port(5432)), None);
        spec.interval = Duration::from_millis(250);
        spec.timeout = Duration::from_secs(7);
        spec.retries = 4;
        spec.start_period = Duration::from_secs(2);

        let resolved = resolve(&spec, verbatim).unwrap();
        assert_eq!(resolved.timing, timing(250, 7000, 4, 2000));
        assert_eq!(resolved.target, Target::Tcp { port: 5432 });
    }

    #[test]
    fn resolve_rejects_no_probe_and_more_than_one() {
        assert_eq!(resolve(&check(None, None, None), verbatim), Err(HealthError::NoProbe));

        let both = check(Some("http://127.0.0.1:1/"), Some(TcpTarget::Port(1)), None);
        assert_eq!(resolve(&both, verbatim), Err(HealthError::MultipleProbes("http, tcp".to_owned())));

        let all = check(Some("http://127.0.0.1:1/"), Some(TcpTarget::Port(1)), Some("true"));
        assert_eq!(resolve(&all, verbatim), Err(HealthError::MultipleProbes("http, tcp, cmd".to_owned())));

        let tcp_and_cmd = check(None, Some(TcpTarget::Port(1)), Some("true"));
        assert_eq!(resolve(&tcp_and_cmd, verbatim), Err(HealthError::MultipleProbes("tcp, cmd".to_owned())));
    }

    #[rstest]
    #[case("5432", Some(5432))]
    #[case("1", Some(1))]
    #[case("65535", Some(65535))]
    #[case(" 8080 ", Some(8080))]
    // Port 0 means "any free port" to bind(2) and nothing at all to connect(2).
    #[case("0", None)]
    #[case("65536", None)]
    #[case("-1", None)]
    #[case("", None)]
    #[case("web", None)]
    #[case("80.5", None)]
    #[case("${ports.web}", None)]
    fn resolve_validates_the_tcp_port(#[case] text: &str, #[case] expected: Option<u16>) {
        let spec = check(None, Some(TcpTarget::Template(text.to_owned())), None);
        match (resolve(&spec, verbatim), expected) {
            (Ok(resolved), Some(port)) => assert_eq!(resolved.target, Target::Tcp { port }),
            (Err(err), None) => assert_eq!(err, HealthError::BadPort(text.to_owned())),
            (got, _) => panic!("{text:?} resolved to {got:?}, expected {expected:?}"),
        }
    }

    #[rstest]
    #[case("http://127.0.0.1:8080/healthz", true)]
    #[case("http://127.0.0.1/", true)]
    #[case("https://example.test/health", true)]
    #[case("HTTP://127.0.0.1/", true)]
    // Not a scheme we can GET.
    #[case("ftp://127.0.0.1/", false)]
    #[case("tcp://127.0.0.1:80", false)]
    // No scheme at all, so ureq could not send it either.
    #[case("127.0.0.1:8080", false)]
    #[case("/healthz", false)]
    #[case("", false)]
    #[case("http://", false)]
    #[case("not a url", false)]
    fn resolve_validates_the_http_url(#[case] url: &str, #[case] ok: bool) {
        let resolved = resolve(&check(Some(url), None, None), verbatim);
        assert_eq!(resolved.is_ok(), ok, "{url:?} -> {resolved:?}");
        if !ok {
            assert_eq!(resolved.unwrap_err(), HealthError::BadUrl(url.to_owned()));
        }
    }

    #[rstest]
    #[case("", true)]
    #[case("   ", true)]
    #[case("\n\t", true)]
    #[case("pg_isready -q", false)]
    fn resolve_rejects_an_empty_cmd(#[case] cmd: &str, #[case] empty: bool) {
        let resolved = resolve(&check(None, None, Some(cmd)), verbatim);
        assert_eq!(resolved.is_err(), empty, "{cmd:?} -> {resolved:?}");
        if empty {
            assert_eq!(resolved.unwrap_err(), HealthError::EmptyCmd);
        }
    }

    #[test]
    fn resolve_reports_what_interpolation_produced_not_what_was_written() {
        // The template was fine; the value it expanded to was not. The error has to name the
        // expansion or the user is hunting for a port number that is not in their config.
        let spec = check(None, Some(TcpTarget::Template("${ports.web}".to_owned())), None);
        let err = resolve(&spec, |_| "not-a-port".to_owned()).unwrap_err();
        assert_eq!(err, HealthError::BadPort("not-a-port".to_owned()));
    }

    // -----------------------------------------------------------------------------------
    // Tracker
    // -----------------------------------------------------------------------------------

    #[test]
    fn retries_counts_consecutive_failures_and_a_success_resets_it() {
        let mut tracker = Tracker::new(&timing(10, 10, 3, 0));
        let fail = unhealthy("down");

        assert_eq!(tracker.record(Duration::from_millis(0), &fail), Status::Failing { failures: 1 });
        assert_eq!(tracker.failures(), 1);
        assert_eq!(tracker.record(Duration::from_millis(10), &fail), Status::Failing { failures: 2 });
        assert_eq!(tracker.failures(), 2);
        // One success wipes the run — two failures before it must not combine with the ones after.
        assert_eq!(tracker.record(Duration::from_millis(20), &Probe::Healthy), Status::Healthy);
        assert_eq!(tracker.failures(), 0);

        assert_eq!(tracker.record(Duration::from_millis(30), &fail), Status::Failing { failures: 1 });
        assert_eq!(tracker.record(Duration::from_millis(40), &fail), Status::Failing { failures: 2 });
        assert_eq!(tracker.record(Duration::from_millis(50), &fail), Status::Unhealthy { detail: "down".to_owned() });
    }

    #[test]
    fn the_detail_of_the_condemning_probe_is_the_one_reported() {
        let mut tracker = Tracker::new(&timing(10, 10, 2, 0));
        assert_eq!(tracker.record(Duration::ZERO, &unhealthy("first")), Status::Failing { failures: 1 });
        assert_eq!(tracker.record(Duration::ZERO, &unhealthy("last")), Status::Unhealthy { detail: "last".to_owned() });
    }

    #[rstest]
    // Inside the grace window, right up to but not including its end.
    #[case(0, Status::Starting)]
    #[case(499, Status::Starting)]
    // The boundary itself counts: the grace window is `[0, start_period)`.
    #[case(500, Status::Failing { failures: 1 })]
    #[case(501, Status::Failing { failures: 1 })]
    fn the_grace_window_ends_at_start_period(#[case] elapsed_ms: u64, #[case] expected: Status) {
        let mut tracker = Tracker::new(&timing(10, 10, 5, 500));
        assert_eq!(tracker.record(Duration::from_millis(elapsed_ms), &unhealthy("down")), expected);
    }

    #[test]
    fn a_failure_inside_the_grace_window_does_not_move_the_counter() {
        let mut tracker = Tracker::new(&timing(10, 10, 2, 500));
        tracker.record(Duration::from_millis(100), &unhealthy("down"));
        tracker.record(Duration::from_millis(200), &unhealthy("down"));
        assert_eq!(tracker.failures(), 0);
    }

    #[test]
    fn retries_zero_condemns_on_the_first_counted_failure() {
        let mut tracker = Tracker::new(&timing(10, 10, 0, 0));
        assert_eq!(tracker.record(Duration::ZERO, &unhealthy("x")), Status::Unhealthy { detail: "x".to_owned() });
    }

    #[test]
    fn retries_one_condemns_on_the_first_counted_failure_too() {
        let mut tracker = Tracker::new(&timing(10, 10, 1, 0));
        assert_eq!(tracker.record(Duration::ZERO, &unhealthy("x")), Status::Unhealthy { detail: "x".to_owned() });
    }

    // -----------------------------------------------------------------------------------
    // settle_bound
    // -----------------------------------------------------------------------------------

    #[test]
    fn settle_bound_accounts_for_start_period_retries_interval_and_timeout() {
        // 2s grace + 5 * (3s + 4s) + 1s slack.
        assert_eq!(timing(3000, 4000, 5, 2000).settle_bound(), Duration::from_millis(38_000));
    }

    #[rstest]
    // Each term has to move the bound, or it is not in the formula.
    #[case(timing(3000, 4000, 5, 2000), 38_000)]
    #[case(timing(4000, 4000, 5, 2000), 43_000)]
    #[case(timing(3000, 5000, 5, 2000), 43_000)]
    #[case(timing(3000, 4000, 6, 2000), 45_000)]
    #[case(timing(3000, 4000, 5, 3000), 39_000)]
    // Nothing but the slack is left when there is nothing to retry.
    #[case(timing(3000, 4000, 0, 0), 1_000)]
    fn every_term_moves_the_settle_bound(#[case] timing: Timing, #[case] expected_ms: u64) {
        assert_eq!(timing.settle_bound(), Duration::from_millis(expected_ms));
    }

    #[test]
    fn an_absurd_settle_bound_saturates_instead_of_overflowing() {
        let absurd = Timing {
            interval: Duration::from_millis(u64::MAX),
            timeout: Duration::from_millis(u64::MAX),
            retries: u32::MAX,
            start_period: Duration::from_millis(u64::MAX),
        };
        assert_eq!(absurd.settle_bound(), Duration::from_millis(u64::MAX));
    }

    // -----------------------------------------------------------------------------------
    // The poll loop
    // -----------------------------------------------------------------------------------

    /// A probe script: one outcome per call, each costing `cost` virtual milliseconds.
    fn scripted<'a>(clock: &'a TestClock, cost: u64, script: Vec<Probe>) -> impl FnMut() -> Probe + 'a {
        let mut script = script.into_iter();
        move || {
            clock.advance(cost);
            script.next().unwrap_or(Probe::Healthy)
        }
    }

    #[test]
    fn start_period_suppresses_early_failures() {
        let clock = TestClock::default();
        let script = vec![unhealthy("a"), unhealthy("b"), unhealthy("c"), Probe::Healthy];
        // retries is 2, so without the grace window the second failure would condemn it.
        let verdict = timing(100, 50, 2, 500).poll(&clock, scripted(&clock, 0, script), None);

        assert_eq!(verdict, Verdict::Healthy { after: Duration::from_millis(300), probes: 4 });
    }

    #[test]
    fn without_a_start_period_those_same_failures_condemn_the_service() {
        let clock = TestClock::default();
        let script = vec![unhealthy("a"), unhealthy("b"), unhealthy("c"), Probe::Healthy];
        let verdict = timing(100, 50, 2, 0).poll(&clock, scripted(&clock, 0, script), None);

        assert_eq!(
            verdict,
            Verdict::Unhealthy { detail: "b".to_owned(), after: Duration::from_millis(100), probes: 2 }
        );
    }

    #[test]
    fn polling_does_not_stack_when_a_probe_is_slower_than_the_interval() {
        let clock = TestClock::default();
        // Probes cost 500ms against a 100ms interval. A fixed-rate ticker would fire ten times in
        // the 1s window; a sleep chain gets through two.
        let script = vec![unhealthy("slow"); 50];
        let verdict =
            timing(100, 600, 1000, 0).poll(&clock, scripted(&clock, 500, script), Some(Duration::from_secs(1)));

        assert_eq!(verdict.probes(), 2);
        assert_eq!(
            verdict,
            Verdict::TimedOut { detail: "slow".to_owned(), after: Duration::from_millis(1100), probes: 2 }
        );
        // One nap of a whole interval, never more than one in flight.
        assert_eq!(clock.naps(), vec![100]);
    }

    #[test]
    fn a_fast_probe_gets_the_full_interval_between_attempts() {
        let clock = TestClock::default();
        let script = vec![unhealthy("x"); 10];
        let verdict =
            timing(100, 10, 1000, 0).poll(&clock, scripted(&clock, 0, script), Some(Duration::from_millis(350)));

        // t=0, 100, 200, 300, then the final 50ms nap exhausts the budget.
        assert_eq!(verdict.probes(), 4);
        assert_eq!(clock.naps(), vec![100, 100, 100, 50]);
        assert_eq!(verdict.after(), Duration::from_millis(350));
    }

    #[test]
    fn wait_until_healthy_uses_the_settle_bound_when_no_deadline_is_given() {
        let clock = TestClock::default();
        let timing = timing(100, 500, 3, 0);
        // 0 grace + 3 * (100 + 500) + 1s slack.
        assert_eq!(timing.settle_bound(), Duration::from_millis(2800));

        // Probes that overrun even their own timeout, so the budget — not the failure count —
        // is what ends the run, and the budget can only have come from `settle_bound`.
        let script = vec![unhealthy("x"); 50];
        let verdict = timing.poll(&clock, scripted(&clock, 2000, script), None);

        assert_eq!(
            verdict,
            Verdict::TimedOut { detail: "x".to_owned(), after: Duration::from_millis(4100), probes: 2 }
        );
    }

    #[test]
    fn wait_until_healthy_stops_at_an_explicit_deadline() {
        let clock = TestClock::default();
        let script = vec![unhealthy("x"); 100];
        let verdict =
            timing(100, 0, 1000, 0).poll(&clock, scripted(&clock, 0, script), Some(Duration::from_millis(250)));

        assert_eq!(verdict, Verdict::TimedOut { detail: "x".to_owned(), after: Duration::from_millis(250), probes: 3 });
    }

    #[test]
    fn a_probe_that_succeeds_immediately_costs_one_probe_and_no_sleep() {
        let clock = TestClock::default();
        let verdict = timing(100, 100, 3, 0).poll(&clock, scripted(&clock, 0, vec![Probe::Healthy]), None);

        assert_eq!(verdict, Verdict::Healthy { after: Duration::ZERO, probes: 1 });
        assert!(clock.naps().is_empty(), "slept before returning healthy: {:?}", clock.naps());
    }

    #[test]
    fn a_zero_deadline_returns_after_exactly_one_probe() {
        let clock = TestClock::default();
        let script = vec![unhealthy("x"); 10];
        let verdict = timing(100, 0, 1000, 0).poll(&clock, scripted(&clock, 0, script), Some(Duration::ZERO));

        assert_eq!(verdict, Verdict::TimedOut { detail: "x".to_owned(), after: Duration::ZERO, probes: 1 });
        assert!(clock.naps().is_empty());
    }

    #[test]
    fn a_zero_interval_still_makes_progress() {
        // `interval: 0ms` is legal. Without the 1ms floor the sleep chain would never advance the
        // clock and the loop would spin until the heat death of the universe.
        let clock = TestClock::default();
        let script = vec![unhealthy("x"); 100];
        let verdict = timing(0, 0, 1000, 0).poll(&clock, scripted(&clock, 0, script), Some(Duration::from_millis(3)));

        assert_eq!(verdict.after(), Duration::from_millis(3));
        assert_eq!(clock.naps(), vec![1, 1, 1]);
    }

    #[test]
    fn the_timed_out_detail_is_the_last_failure_seen() {
        let clock = TestClock::default();
        let script = vec![unhealthy("first"), unhealthy("second"), unhealthy("third")];
        let verdict =
            timing(100, 0, 1000, 0).poll(&clock, scripted(&clock, 0, script), Some(Duration::from_millis(200)));

        // Probes at t=0 and t=100; the nap after the second one spends the budget.
        assert_eq!(
            verdict,
            Verdict::TimedOut { detail: "second".to_owned(), after: Duration::from_millis(200), probes: 2 }
        );
    }

    // -----------------------------------------------------------------------------------
    // End to end
    // -----------------------------------------------------------------------------------

    #[test]
    fn wait_until_healthy_returns_within_its_budget_when_every_probe_hangs() {
        // Every probe blocks for five minutes and is cut off at its 120ms timeout. `retries` is
        // far too high to condemn the service, so only the deadline can end the run — and it has
        // to, promptly, with the real clock and a real subprocess.
        let health =
            ResolvedHealth { target: Target::Cmd { cmd: "sleep 300".to_owned() }, timing: timing(20, 120, 10_000, 0) };
        let budget = Duration::from_millis(500);

        let began = Instant::now();
        let verdict = health.wait_until_healthy(cwd(), &no_env(), Some(budget));
        let took = began.elapsed();

        assert!(matches!(verdict, Verdict::TimedOut { .. }), "expected a timeout verdict, got {verdict:?}");
        assert!(verdict.probes() >= 2, "only {} probes in 500ms of 140ms cycles", verdict.probes());
        // Without the budget this would run for five minutes, so seconds of slack still prove it.
        assert!(took < std::time::Duration::from_secs(10), "took {took:?}");
        assert_eq!(verdict.detail_for_test(), "timed out after 120ms");
    }

    #[test]
    fn wait_until_healthy_reaches_healthy_against_a_real_server() {
        let port = serve(OK);
        let health = ResolvedHealth {
            target: Target::Http { url: format!("http://127.0.0.1:{port}/") },
            timing: timing(10, 2000, 3, 0),
        };
        let verdict = health.wait_until_healthy(cwd(), &no_env(), Some(Duration::from_secs(5)));

        assert!(verdict.is_healthy(), "{verdict:?}");
        assert_eq!(verdict.probes(), 1);
    }

    #[test]
    fn wait_until_healthy_condemns_a_port_nobody_is_listening_on() {
        let port = closed_port();
        let health = ResolvedHealth { target: Target::Tcp { port }, timing: timing(5, 200, 2, 0) };
        let verdict = health.wait_until_healthy(cwd(), &no_env(), Some(Duration::from_secs(5)));

        let Verdict::Unhealthy { detail, probes, .. } = verdict else { panic!("expected unhealthy, got {verdict:?}") };
        assert_eq!(probes, 2);
        assert!(detail.starts_with(&format!("127.0.0.1:{port}: ")), "detail was {detail:?}");
    }

    #[test]
    fn resolved_settle_bound_delegates_to_its_timing() {
        let health = ResolvedHealth { target: Target::Tcp { port: 1 }, timing: timing(3000, 4000, 5, 2000) };
        assert_eq!(health.settle_bound(), health.timing.settle_bound());
        assert_eq!(health.settle_bound(), Duration::from_millis(38_000));
    }

    // -----------------------------------------------------------------------------------
    // Wire shapes
    // -----------------------------------------------------------------------------------

    #[test]
    fn the_json_shapes_are_what_the_envelope_promises() {
        let probe = serde_json::to_value(unhealthy("HTTP 500")).unwrap();
        assert_eq!(probe, serde_json::json!({ "status": "unhealthy", "detail": "HTTP 500" }));
        assert_eq!(serde_json::to_value(Probe::Healthy).unwrap(), serde_json::json!({ "status": "healthy" }));

        let verdict = Verdict::TimedOut { detail: "HTTP 500".to_owned(), after: Duration::from_secs(3), probes: 2 };
        assert_eq!(
            serde_json::to_value(verdict).unwrap(),
            serde_json::json!({ "verdict": "timed_out", "detail": "HTTP 500", "after": "3s", "probes": 2 })
        );

        let health = ResolvedHealth {
            target: Target::Http { url: "http://127.0.0.1:8100/".to_owned() },
            timing: timing(3000, 3000, 10, 0),
        };
        assert_eq!(
            serde_json::to_value(health).unwrap(),
            serde_json::json!({
                "target": { "kind": "http", "url": "http://127.0.0.1:8100/" },
                "timing": { "interval": "3s", "timeout": "3s", "retries": 10, "start_period": "0ms" },
            })
        );
    }

    #[test]
    fn the_system_clock_advances_and_actually_sleeps() {
        let clock = SystemClock::new();
        let before = clock.now();
        let began = Instant::now();
        clock.sleep(Duration::from_millis(60));
        let took = began.elapsed();

        assert!(took >= std::time::Duration::from_millis(45), "sleep returned after {took:?}");
        assert!(clock.now() >= before + 45, "the clock did not advance: {before} to {}", clock.now());
    }

    #[test]
    fn the_default_system_clock_starts_where_a_new_one_does() {
        // `Default` exists so an embedder can write `SystemClock::default()`; one that handed
        // back an epoch rather than a fresh `Instant` would make every `after` a wrong number.
        let clock = SystemClock::default();
        assert!(clock.now() < 1_000, "a fresh clock reads {}, not roughly zero", clock.now());
    }

    #[test]
    fn the_nap_says_when_the_budget_is_gone() {
        let clock = TestClock::default();
        let timing = timing(100, 0, 1, 0);

        // Budget to spare: a whole interval, and keep going.
        assert!(timing.nap(&clock, 0, Duration::from_millis(250)));
        assert_eq!(clock.now(), 100);
        // Less than an interval left: clamped to it, and that is the end.
        assert!(!timing.nap(&clock, 0, Duration::from_millis(150)));
        assert_eq!(clock.naps(), vec![100, 50]);
        // Nothing left: no sleep at all.
        assert!(!timing.nap(&clock, 0, Duration::from_millis(150)));
        assert_eq!(clock.naps(), vec![100, 50]);
    }

    #[rstest]
    #[case(1, Some(-1))]
    #[case(4242, Some(-4242))]
    // Group 0 is our own group: signalling it would kill the test runner and its shell.
    #[case(0, None)]
    // Larger than a pid_t, so there is no safe negation.
    #[case(2_147_483_648, None)]
    #[case(u32::MAX, None)]
    fn only_a_real_pid_becomes_a_signalable_group(#[case] pid: u32, #[case] expected: Option<i32>) {
        assert_eq!(group_of(pid), expected.map(Pid::from_raw));
    }

    #[test]
    fn reap_briefly_collects_a_dead_child_and_gives_up_on_a_live_one() {
        // `reap_briefly` is what stops a finished probe becoming a zombie, and what stops a
        // probe that backgrounded something from blocking forever. Both halves are timing, so
        // nothing else in the suite notices if either bound goes wrong.
        let mut dead = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");
        // Establish that it has finished before measuring, rather than sleeping a fixed guess:
        // on a loaded machine the child may not have been scheduled yet, and this would become
        // a test of process start-up time. Observing the exit without consuming it needs
        // WNOWAIT, which macOS offers on `waitid` but not `waitpid`, so collect it here and
        // rely on `Child` caching the status — `reap_briefly` must return at once either way.
        let settled = Instant::now();
        while dead.try_wait().expect("try_wait").is_none() {
            assert!(settled.elapsed() < std::time::Duration::from_secs(10), "the child never exited");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        let began = Instant::now();
        reap_briefly(&mut dead);
        assert!(began.elapsed() < REAP_GRACE, "waited {:?} on a child that had already finished", began.elapsed());
        assert!(dead.try_wait().expect("try_wait").is_some(), "the dead child was never collected");

        // A child the signal never reached: the wait is bounded and it is left alone.
        let token = token(5);
        reap(&token);
        let mut live = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("sleep {token}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("spawn");
        let began = Instant::now();
        reap_briefly(&mut live);
        let took = began.elapsed();
        assert!(took >= REAP_GRACE, "gave up after only {took:?}");
        assert!(took < REAP_GRACE * 8, "waited {took:?}, which is not bounded");
        assert!(live.try_wait().expect("try_wait").is_none(), "the live child should still be running");
        kill_group(live.id());
        reap_briefly(&mut live);
        reap(&token);
    }

    #[rstest]
    // Group 0 is this process's own: `kill(-0, SIGKILL)` would take the test runner, its shell,
    // and every other test running beside it.
    #[case(0)]
    // Too large to be a `pid_t`, so there is no group to name safely.
    #[case(u32::MAX)]
    fn a_pid_with_no_group_of_its_own_is_never_signalled(#[case] pid: u32) {
        assert!(!kill_group(pid), "it reported signalling a group it cannot name");
    }

    #[test]
    fn kill_group_takes_the_backgrounded_children_too() {
        let token = token(4);
        let token = token.as_str();
        reap(token);
        assert_eq!(processes_matching(token), 0, "stale process from an earlier run");
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("sleep {token} & sleep {token}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("spawn");
        let running = snapshot_until(10_000, |snap| count_in(snap, token) >= 2);
        assert!(count_in(&running, token) >= 2, "the children never started");

        assert!(kill_group(child.id()), "nothing was signalled at all");

        let after = snapshot_until(10_000, |snap| count_in(snap, token) == 0);
        let gone = count_in(&after, token) == 0;
        // Unconditional: a `pkill` that matches nothing costs a moment, and a survivor left behind
        // would trip the stale-process guard at the top of the next run of this test.
        reap(token);
        reap_briefly(&mut child);
        assert!(gone, "kill_group left the backgrounded child behind");
    }

    #[test]
    fn probe_accessors_report_both_sides() {
        assert!(Probe::Healthy.is_healthy());
        assert!(!unhealthy("x").is_healthy());
        assert_eq!(Probe::Healthy.detail(), "");
        assert_eq!(unhealthy("x").detail(), "x");
    }

    #[test]
    fn verdict_accessors_report_every_arm() {
        let healthy = Verdict::Healthy { after: Duration::from_millis(1), probes: 1 };
        let unhealthy = Verdict::Unhealthy { detail: "a".to_owned(), after: Duration::from_millis(2), probes: 2 };
        let timed_out = Verdict::TimedOut { detail: "b".to_owned(), after: Duration::from_millis(3), probes: 3 };

        assert!(healthy.is_healthy());
        assert!(!unhealthy.is_healthy());
        assert!(!timed_out.is_healthy());

        assert_eq!((healthy.probes(), unhealthy.probes(), timed_out.probes()), (1, 2, 3));
        assert_eq!(healthy.after(), Duration::from_millis(1));
        assert_eq!(unhealthy.after(), Duration::from_millis(2));
        assert_eq!(timed_out.after(), Duration::from_millis(3));
        // A healthy verdict has no reason to report, and the two failing ones report their own.
        assert_eq!(healthy.detail_for_test(), "");
        assert_eq!((unhealthy.detail_for_test(), timed_out.detail_for_test()), ("a", "b"));
    }

    #[test]
    fn the_health_errors_say_what_to_fix() {
        assert_eq!(
            HealthError::NoProbe.to_string(),
            "a health check needs exactly one of http, tcp or cmd; none is set"
        );
        assert_eq!(
            HealthError::MultipleProbes("http, tcp".to_owned()).to_string(),
            "a health check needs exactly one of http, tcp or cmd; http, tcp are set"
        );
        assert_eq!(
            HealthError::BadPort("web".to_owned()).to_string(),
            "health tcp \"web\" is not a port between 1 and 65535"
        );
        assert_eq!(
            HealthError::BadUrl("nope".to_owned()).to_string(),
            "health http \"nope\" is not an http:// or https:// URL"
        );
        assert_eq!(HealthError::EmptyCmd.to_string(), "health cmd is empty");
    }

    impl Verdict {
        /// The failure reason on any arm, for assertions.
        fn detail_for_test(&self) -> &str {
            match self {
                Verdict::Healthy { .. } => "",
                Verdict::Unhealthy { detail, .. } | Verdict::TimedOut { detail, .. } => detail,
            }
        }
    }
}
