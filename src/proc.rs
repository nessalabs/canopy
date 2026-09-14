//! Starting a service process, and much later killing it, with nothing running in between.
//!
//! A port of `packages/daemon/src/env/services/runners/host.ts`, minus the daemon. The daemon
//! could hold a `Child` handle and a pair of pipes for the life of the service; `canopywt up`
//! exits seconds after it starts one. Everything that makes supervision work therefore has to
//! survive in a JSON file and a pid, and the two hard parts follow from that:
//!
//! - **Nothing may be pumping the child's output.** stdout and stderr go to an append-mode file
//!   descriptor, never a pipe. See [`spawn`] for why a pipe would deadlock the service.
//! - **A pid on disk is not proof of anything.** Pids are recycled. `kill(-pgid, SIGKILL)`
//!   against a recycled pid kills a stranger's whole process group — plausibly the editor the
//!   user is typing in. Every signalling path goes through [`identify`] first, which compares
//!   the process's start time with the one recorded at spawn and refuses when it cannot tell.
//!
//! The child gets its own process group, because `npm run dev` is a shell that forks a handful
//! of children and killing only the shell leaves them holding the port.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Seek, SeekFrom, Write as _};
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::str::FromStr as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use camino::{Utf8Path, Utf8PathBuf};
use nix::errno::Errno;
use nix::sys::signal::{self, Signal};
use nix::sys::wait::{WaitPidFlag, waitpid};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};

use crate::config::Duration;
use crate::error::ErrorCode;

/// The launch id is exported under this name so a child (or anything it spawns) can tell which
/// launch it belongs to — the one piece of identity that survives `exec`, unlike a pid.
pub const LAUNCH_ID_VAR: &str = "CANOPYWT_LAUNCH_ID";

/// How often a wait re-checks the pid. Short enough that `stop` returns as soon as the process
/// is gone, long enough that a 30s timeout is not 30s of spinning.
const POLL: std::time::Duration = std::time::Duration::from_millis(10);

/// How long [`stop`] waits for `SIGKILL` to take effect before returning.
///
/// `SIGKILL` cannot be caught, so this is not a grace period — it exists so `stop` does not
/// return while the pid is still visible to whatever runs next.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// How much of a log file [`tail`] reads at a time, walking backwards from the end.
const TAIL_CHUNK: usize = 8 * 1024;

/// Bytes of randomness in a launch id, hex-encoded to 32 characters.
const LAUNCH_ID_BYTES: usize = 16;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/// Module-local, like [`crate::ports::PortError`]: the crate's `Error` publishes a stable code
/// per *user-visible* failure, and these are the internals of one command rather than new kinds
/// of failure. [`ProcError::code`] maps them onto codes that already exist.
#[derive(Debug, thiserror::Error)]
pub enum ProcError {
    #[error("could not start {command:?}: {source}")]
    Spawn { command: String, source: std::io::Error },

    #[error("could not open the log {path}: {source}")]
    Log { path: Utf8PathBuf, source: std::io::Error },

    /// The file exists and is not a process record. Never silently recovered: a record we cannot
    /// read is a process we cannot stop, and pretending it is absent leaks the process.
    #[error("{path} is not a usable process record: {detail}")]
    Corrupt { path: Utf8PathBuf, detail: String },

    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl ProcError {
    /// The stable code a caller branches on.
    pub fn code(&self) -> ErrorCode {
        match self {
            ProcError::Spawn { .. } | ProcError::Log { .. } => ErrorCode::ServiceFailed,
            ProcError::Corrupt { .. } | ProcError::Io(_) => ErrorCode::Io,
        }
    }
}

// ---------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------

/// Everything needed to start one process. Borrowed throughout: the caller owns the config this
/// came from and nothing here outlives the call.
#[derive(Debug, Clone)]
pub struct SpawnRequest<'a> {
    /// Run by `/bin/sh -c`, so `cd x && npm start` and `a | b` work as written.
    pub command: &'a str,
    pub cwd: &'a Utf8Path,
    /// Overlaid on the environment this process inherited, the way a shell's `FOO=1 cmd` is.
    pub env: &'a BTreeMap<String, String>,
    /// stdout and stderr, appended to. Created if missing, along with its directory.
    pub log: &'a Utf8Path,
}

/// What we know about a process we started, and all we will have when we come back to it from a
/// different process minutes or days later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessRecord {
    pub pid: i32,
    /// Equal to `pid`: the child is made a group leader at spawn. Kept as its own field because
    /// the *group* is what gets signalled, and a reader of this file should not have to know
    /// they are the same number to understand what `kill(-pgid)` will hit.
    pub pgid: i32,
    /// The process's start time as the OS reports it, or `None` when it could not be read.
    ///
    /// Opaque: it is compared with a later reading of the same process, never parsed. `None`
    /// means "nothing recorded", and only happens when the process was already gone before we
    /// could look — see [`identify`] for what each case means for signalling.
    pub start_time: Option<String>,
    /// Random per launch, and exported to the child as `CANOPYWT_LAUNCH_ID`.
    pub launch_id: String,
    pub command: String,
    pub cwd: Utf8PathBuf,
    pub log: Utf8PathBuf,
    /// Wall-clock seconds since the epoch, for display. Never used to decide anything: it is our
    /// clock, not the kernel's, and it says nothing about whether the pid is still ours.
    pub started_at: u64,
}

/// Always re-derived from the live process. A record says what we started; only the OS knows
/// what is running now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProcessState {
    Running {
        pid: i32,
    },
    /// The process we started has finished, and nothing else answers to its pid.
    Exited,
    /// The pid is alive but is not (or cannot be shown to be) the process we started. Nothing
    /// will be signalled while a record is in this state.
    Stale,
}

/// What [`stop`] did. `Refused` is a success in the sense that matters: the tool declined to
/// signal something it could not prove was ours.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StopOutcome {
    NotRunning,
    /// It exited after the stop signal, within the timeout.
    Terminated,
    /// It ignored the stop signal and was killed.
    Killed,
    Refused {
        reason: String,
    },
}

// ---------------------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------------------

/// Starts the command and hands back everything needed to find it again.
///
/// **stdout and stderr are redirected to a file, never to a pipe.** This is the decision that
/// makes a daemonless supervisor possible. A pipe has a 64 KiB kernel buffer and needs a reader:
/// with the parent gone there is nobody to drain it, so the first `console.log` past 64 KiB
/// blocks the service forever — alive, listening on nothing, with no error anywhere. A file
/// descriptor has no such backpressure, so there is nothing to pump and the parent is free to
/// exit the moment this function returns. It is also why `Stdio::piped()` must never appear in
/// this module, however convenient capturing the first few lines would be.
///
/// The child is made a process group leader ([`CommandExt::process_group`]) so that
/// [`stop`] can signal everything it starts and not just the shell.
pub fn spawn(request: &SpawnRequest<'_>) -> Result<ProcessRecord, ProcError> {
    let launch_id = launch_id()?;
    if let Some(parent) = request.log.parent() {
        fs::create_dir_all(parent).map_err(|source| ProcError::Log { path: request.log.to_owned(), source })?;
    }
    // Opened twice rather than cloned: `dup` fails only when the process is out of descriptors,
    // an error nothing here could do anything about, and two appending descriptors write to the
    // end of the file exactly as one shared one does.
    let out = open_log(request.log)?;
    let err = open_log(request.log)?;

    let child = Command::new("/bin/sh")
        .arg("-c")
        .arg(request.command)
        .current_dir(request.cwd)
        .envs(request.env)
        .env(LAUNCH_ID_VAR, &launch_id)
        // Nothing is typing at it: a service that reads stdin should see EOF, not inherit the
        // terminal and stop the user's shell with SIGTTIN.
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .process_group(0)
        .spawn()
        .map_err(|source| ProcError::Spawn { command: request.command.to_owned(), source })?;

    // A pid always fits in i32 on unix.
    let pid = child.id() as i32;
    // The `Child` is dropped without being waited on, and deliberately: Rust does not kill a
    // child on drop, and waiting is the caller's whole problem — this process is about to exit.
    drop(child);

    Ok(ProcessRecord {
        pid,
        // `process_group(0)` makes the child a group leader, so its group id is its pid.
        pgid: pid,
        start_time: current_start_time(pid),
        launch_id,
        command: request.command.to_owned(),
        cwd: request.cwd.to_owned(),
        log: request.log.to_owned(),
        started_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_secs()).unwrap_or_default(),
    })
}

/// Append, so a restart adds to the history instead of erasing the reason for it.
fn open_log(path: &Utf8Path) -> Result<File, ProcError> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|source| ProcError::Log { path: path.to_owned(), source })
}

/// 32 hex characters from `/dev/urandom`.
///
/// Read rather than derived from the clock and the pid: those are exactly the two things that
/// repeat after a restart, and a launch id that collides is worse than none.
fn launch_id() -> Result<String, ProcError> {
    let mut bytes = [0u8; LAUNCH_ID_BYTES];
    File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes))?;
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(text, "{byte:02x}");
    }
    Ok(text)
}

// ---------------------------------------------------------------------------------------
// Identity — the check that stops us killing a stranger
// ---------------------------------------------------------------------------------------

/// The answer to "is the thing wearing this pid still the thing we started?".
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identity {
    /// Alive and ours. The only value that permits a signal.
    Ours,
    /// Nothing answers to the pid.
    Gone,
    /// Something answers to the pid and it is not demonstrably ours.
    NotOurs(String),
}

/// The single gate every signal goes through.
///
/// Ported from `isOurProcess` (`host.ts:87-94`), including the case that matters most:
///
/// > Unreadable start time with a recorded one: refuse to claim the pid rather than risk a
/// > stranger.
///
/// "I cannot tell" must not mean "go ahead". If `ps` is missing, or the process moved out of
/// view, the honest answer is that this pid might be anybody's — and the cost of being wrong is
/// `SIGKILL` to an unrelated process *group*, which is to say to somebody's editor and every
/// shell inside it. Refusing costs a leaked service that the user can see and kill by hand.
///
/// A record with no start time at all is a different case: nothing was ever recorded to compare
/// against (the process died before we could read it), so there is nothing to contradict, and we
/// treat a live pid as ours exactly as the daemon does.
///
/// This is also the only place that checks `pid` and `pgid` are positive, and everything below
/// relies on it: `kill(0, …)` means "my own process group" and `kill(-1, …)` means "every
/// process I own". A record that got its numbers from a truncated file must never reach a
/// `kill` with either.
fn identify(record: &ProcessRecord) -> Identity {
    if record.pid <= 0 || record.pgid <= 0 {
        return Identity::NotOurs(format!("pid {} / group {} is not something we can signal", record.pid, record.pgid));
    }
    if !alive(record.pid) {
        return Identity::Gone;
    }
    let Some(recorded) = record.start_time.as_deref() else {
        return Identity::Ours;
    };
    match current_start_time(record.pid) {
        None => Identity::NotOurs(format!("the start time of pid {} could not be read", record.pid)),
        Some(current) if current == recorded => Identity::Ours,
        Some(current) => Identity::NotOurs(format!(
            "pid {} started at {current:?}, not {recorded:?} — the pid has been reused",
            record.pid
        )),
    }
}

/// Whether anything answers to the pid.
///
/// Callers must have been through [`identify`]'s positivity check: signal 0 to pid 0 or -1 is
/// harmless, but the `waitpid` below is not — its argument has the same overloading.
fn alive(pid: i32) -> bool {
    reap(pid);
    match signal::kill(Pid::from_raw(pid), None) {
        Ok(()) => true,
        // EPERM: it exists, it is simply not ours to signal. Alive for our purposes.
        Err(errno) => errno == Errno::EPERM,
    }
}

/// Reaps the pid if it happens to be one of our own children.
///
/// Normally it is not: the process that started the service exited long ago and the service was
/// reparented to init, which reaps it. But in-process — a library embedder, or this module's own
/// tests — a child we spawned and never waited on lingers as a zombie, and a zombie answers
/// `kill(pid, 0)` with success. Without this, "has it exited?" would be permanently false for
/// exactly the processes we started.
fn reap(pid: i32) {
    let _ = waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG));
}

/// The process's start time, as an opaque string, or `None` when it cannot be read.
///
/// `ps -o lstart=` is the portable answer: macOS has no `/proc`, and Linux's
/// `/proc/<pid>/stat` start time is in clock ticks since boot, which needs the boot time and the
/// tick rate to become anything comparable. The string is never parsed — it is compared with a
/// later reading of the same field — so `LC_ALL` and `TZ` are pinned to keep two readings of one
/// process byte-identical across a timezone change or a DST boundary.
fn read_start_time(pid: i32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // `lstart` is column-padded; collapse the padding so equality is about the instant.
    let text = String::from_utf8_lossy(&output.stdout);
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() { None } else { Some(normalized) }
}

// Overrides `read_start_time` for one test.
//
// A test seam, because the case worth proving cannot be arranged for real: a *live* pid whose
// start time is unreadable needs `ps` to fail while the process keeps running. "Unreadable means
// refuse" is the rule this module exists for, so it is worth a thread-local.
#[cfg(test)]
thread_local! {
    static FORCED_START_TIME: std::cell::RefCell<Option<Option<String>>> =
        const { std::cell::RefCell::new(None) };
}

fn current_start_time(pid: i32) -> Option<String> {
    #[cfg(test)]
    {
        if let Some(forced) = FORCED_START_TIME.with(|cell| cell.borrow().clone()) {
            return forced;
        }
    }
    read_start_time(pid)
}

// ---------------------------------------------------------------------------------------
// State and stopping
// ---------------------------------------------------------------------------------------

/// What the record points at *now*.
///
/// Nothing is believed from the file: the pid is probed and its start time re-read every time,
/// because between two calls the process can exit and its pid can be handed to somebody else.
pub fn state(record: &ProcessRecord) -> ProcessState {
    match identify(record) {
        Identity::Ours => ProcessState::Running { pid: record.pid },
        Identity::Gone => ProcessState::Exited,
        Identity::NotOurs(_) => ProcessState::Stale,
    }
}

/// Stops the process group: `signal`, then `SIGKILL` if it is still there after `timeout`.
///
/// The signal goes to the *group*, not the pid, which is the only way `sh -c 'a & b'` — or any
/// dev server that forks a watcher — dies whole instead of leaving something holding the port.
/// That is also why the identity check above is not optional: a group kill against a recycled
/// pid takes out a stranger's entire session.
pub fn stop(record: &ProcessRecord, signal: &str, timeout: Duration) -> StopOutcome {
    // Checked before the state, so a typo in `stopSignal:` is reported as the configuration
    // mistake it is rather than being hidden by a process that happened to be dead already.
    let Some(stop_signal) = parse_signal(signal) else {
        return StopOutcome::Refused { reason: format!("{signal:?} is not a signal name") };
    };
    match identify(record) {
        Identity::Gone => return StopOutcome::NotRunning,
        Identity::NotOurs(reason) => return StopOutcome::Refused { reason },
        Identity::Ours => {}
    }

    kill_group(record, stop_signal);
    if wait_for_exit(record.pid, timeout) {
        return StopOutcome::Terminated;
    }
    kill_group(record, Signal::SIGKILL);
    wait_for_exit(record.pid, KILL_GRACE);
    StopOutcome::Killed
}

/// Accepts `SIGTERM`, `sigterm` and `TERM` alike: the name comes from `canopy.yaml`, where
/// Node's spelling (`SIGTERM`) and a shell's (`TERM`) are both things people write.
fn parse_signal(name: &str) -> Option<Signal> {
    let upper = name.trim().to_ascii_uppercase();
    let qualified = if upper.starts_with("SIG") { upper } else { format!("SIG{upper}") };
    Signal::from_str(&qualified).ok()
}

/// Signals the whole group, falling back to the bare pid when the group has gone.
///
/// The fallback is for a service that made its own group after we started it (anything that
/// calls `setsid`): the recorded group id is then empty, `kill` reports ESRCH, and the pid is
/// still the process we want. `pgid` is positive — [`identify`] is the gate that guarantees it,
/// and without it the negation below would turn a zeroed record into `kill(0, …)`, i.e. into
/// signalling ourselves and everything sharing our terminal.
fn kill_group(record: &ProcessRecord, sig: Signal) -> bool {
    if signal::kill(Pid::from_raw(-record.pgid), sig).is_ok() {
        return true;
    }
    signal::kill(Pid::from_raw(record.pid), sig).is_ok()
}

/// Polls until the pid is gone or the deadline passes. `true` when it exited.
///
/// The last poll lands on the deadline rather than before it: the final sleep is shortened to
/// whatever time is left, so a process that exits just inside its grace period is seen to have
/// exited instead of being escalated against a moment too early.
fn wait_for_exit(pid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout.as_std();
    loop {
        if !alive(pid) {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(POLL.min(remaining));
    }
}

// ---------------------------------------------------------------------------------------
// The record on disk
// ---------------------------------------------------------------------------------------

/// Distinguishes concurrent temp files, so two writers cannot pick the same name and read each
/// other's half-written bytes.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write, `fsync`, `rename`.
///
/// In that order, and to a temp file in the *same* directory so the rename is atomic. A record
/// truncated by a crash is worse than no record: it is a pid without the start time that makes
/// the pid safe to use.
pub fn write_record(path: &Utf8Path, record: &ProcessRecord) -> Result<(), ProcError> {
    // Nothing in a record can fail to serialize. The `?` keeps that an observation rather than
    // an invariant this function would panic on if a field ever grew one.
    let mut json = serde_json::to_vec_pretty(record).map_err(std::io::Error::from)?;
    json.push(b'\n');

    let name = path.file_name().unwrap_or("process.json");
    let serial = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_file_name(format!(".{name}.{}.{serial}.tmp", std::process::id()));

    if let Err(error) = write_and_sync(&temp, &json) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(ProcError::Io(error));
    }
    Ok(())
}

fn write_and_sync(temp: &Utf8Path, json: &[u8]) -> Result<(), ProcError> {
    let mut file = File::create(temp)?;
    file.write_all(json)?;
    // Without this the rename can land before the bytes do, and a power cut leaves a valid
    // filename pointing at an empty file.
    file.sync_all()?;
    Ok(())
}

pub fn read_record(path: &Utf8Path) -> Result<ProcessRecord, ProcError> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|error| ProcError::Corrupt { path: path.to_owned(), detail: error.to_string() })
}

// ---------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------

/// The last `lines` lines of a log, without reading the rest of it.
///
/// A service log is append-only and unbounded — a chatty dev server produces gigabytes over a
/// weekend — so this seeks to the end and walks backwards a chunk at a time, stopping as soon as
/// it has enough newlines. Line endings are normalized (a trailing `\r` is dropped) and a final
/// newline does not produce an empty last line.
pub fn tail(log: &Utf8Path, lines: usize) -> Result<Vec<String>, ProcError> {
    Ok(tail_read(log, lines)?.0)
}

/// [`tail`], plus how many bytes it had to read to answer.
///
/// The byte count exists for the test: "only reads the end" is invisible in the returned lines,
/// so without it nothing would notice this quietly becoming a whole-file read.
fn tail_read(log: &Utf8Path, lines: usize) -> Result<(Vec<String>, u64), ProcError> {
    if lines == 0 {
        return Ok((Vec::new(), 0));
    }
    let mut file = File::open(log)?;
    let length = file.seek(SeekFrom::End(0))?;
    if length == 0 {
        return Ok((Vec::new(), 0));
    }

    // A newline at the very end terminates the last line rather than starting an empty one.
    let mut last = [0u8; 1];
    file.seek(SeekFrom::Start(length - 1))?;
    file.read_exact(&mut last)?;
    let mut read = 1;
    let end = if last[0] == b'\n' { length - 1 } else { length };

    let mut buffer: Vec<u8> = Vec::new();
    let mut found = 0usize;
    let chunks = end.div_ceil(TAIL_CHUNK as u64);
    for index in (0..chunks).rev() {
        let start = index * TAIL_CHUNK as u64;
        let stop = (start + TAIL_CHUNK as u64).min(end);
        let mut chunk = vec![0u8; (stop - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut chunk)?;
        read += chunk.len() as u64;
        found += chunk.iter().filter(|&&byte| byte == b'\n').count();
        // Prepend: we are walking backwards, so each chunk goes in front of what we have.
        chunk.extend_from_slice(&buffer);
        buffer = chunk;
        if found >= lines {
            break;
        }
    }

    // Lossy, because a chunk boundary can fall inside a multi-byte character. The only affected
    // character is at the very front of the buffer, on a partial line that is then dropped —
    // unless we read from byte 0, where there is no partial line and no split character.
    let text = String::from_utf8_lossy(&buffer);
    let mut out: Vec<String> = text.split('\n').map(|line| line.trim_end_matches('\r').to_owned()).collect();
    let extra = out.len().saturating_sub(lines);
    out.drain(..extra);
    Ok((out, read))
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::time::Instant as TestInstant;

    use rstest::rstest;
    use tempfile::TempDir;

    use super::*;

    // -----------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------

    /// How long a test waits for something the OS does asynchronously (a process dying, output
    /// reaching a file). Generous, because it is only ever reached when a test is failing.
    const PATIENCE: std::time::Duration = std::time::Duration::from_secs(5);

    fn workspace() -> (TempDir, Utf8PathBuf) {
        let dir = TempDir::new().expect("temp dir");
        let path = Utf8PathBuf::from_path_buf(dir.path().to_path_buf()).expect("utf8 temp dir");
        (dir, path)
    }

    /// Spawns into `dir/log.txt` with no extra environment.
    ///
    /// The long-lived children below sleep for a minute rather than an hour: a test binary that
    /// is killed outright (a mutation run's timeout, a `^C`) never gets to run its cleanup, and a
    /// leaked `sleep` that tidies itself up in a minute is a much better neighbour on a machine
    /// that is also running everybody else's tests.
    fn start(dir: &Utf8Path, command: &str) -> ProcessRecord {
        let env = BTreeMap::new();
        spawn(&SpawnRequest { command, cwd: dir, env: &env, log: &dir.join("log.txt") }).expect("spawn")
    }

    /// Kills whatever a record points at when the test ends, so a failed assertion does not
    /// leave a `sleep 60` behind.
    struct Cleanup(ProcessRecord);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = stop(&self.0, "SIGKILL", Duration::from_millis(500));
        }
    }

    /// Polls `condition` until it holds or `patience` runs out.
    ///
    /// Unhurried on purpose: several of these run at once and most of the conditions below cost
    /// a `ps`, so a tight loop would spend the machine on watching rather than on working — and
    /// slow down the very processes it is waiting for.
    ///
    /// The patience is a parameter so that the giving-up half can be tested without spending
    /// [`PATIENCE`] to do it.
    fn within(patience: std::time::Duration, mut condition: impl FnMut() -> bool) -> bool {
        let deadline = TestInstant::now() + patience;
        loop {
            if condition() {
                return true;
            }
            if TestInstant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn eventually(condition: impl FnMut() -> bool) -> bool {
        within(PATIENCE, condition)
    }

    /// Whether the process is gone, asked of the kernel directly rather than through the module
    /// under test — a test that used `state` to check `stop` would pass even if both were broken
    /// the same way. Two syscalls rather than a `ps`, because this is polled and the rest of the
    /// suite has its own processes to start.
    ///
    /// The `waitpid` matters: a child of this process that has exited but not been collected is
    /// a zombie, and a zombie still answers `kill(pid, 0)`. Collecting it first is what makes
    /// "gone" mean gone for the children these tests spawn.
    fn gone(pid: i32) -> bool {
        let _ = waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG));
        signal::kill(Pid::from_raw(pid), None) == Err(Errno::ESRCH)
    }

    /// Every pid currently in a process group.
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

    fn log_text(record: &ProcessRecord) -> String {
        fs::read_to_string(&record.log).unwrap_or_default()
    }

    fn force_start_time(value: Option<String>) {
        FORCED_START_TIME.with(|cell| *cell.borrow_mut() = Some(value));
    }

    fn stop_forcing_start_time() {
        FORCED_START_TIME.with(|cell| *cell.borrow_mut() = None);
    }

    fn write_lines(path: &Utf8Path, text: &str) {
        fs::write(path, text).expect("write log");
    }

    // -----------------------------------------------------------------------------------
    // Spawning
    // -----------------------------------------------------------------------------------

    #[test]
    fn spawn_returns_a_live_record() {
        let (_dir, path) = workspace();
        let record = start(&path, "sleep 60");
        let _cleanup = Cleanup(record.clone());

        assert!(record.pid > 0, "{record:?}");
        assert_eq!(record.pgid, record.pid, "the child is its own group leader");
        assert!(record.start_time.is_some(), "the kernel's start time is what makes the pid safe to use later");
        assert_eq!(record.command, "sleep 60");
        assert_eq!(record.cwd, path);
        assert_eq!(record.log, path.join("log.txt"));
        assert!(record.started_at > 1_600_000_000, "{}", record.started_at);
        assert_eq!(state(&record), ProcessState::Running { pid: record.pid });
        assert!(!gone(record.pid), "the child should actually be running");
    }

    #[test]
    fn the_child_survives_the_parent() {
        // The no-daemon promise. Nothing in this process holds the child: the `Child` handle was
        // dropped inside `spawn` and the record is a plain struct, so there is nothing here whose
        // disappearance could take the service with it.
        let (_dir, path) = workspace();
        let pid = {
            let record = start(&path, "sleep 60");
            let pid = record.pid;
            drop(record);
            pid
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!gone(pid), "dropping every handle must not kill the service");

        let _ = signal::kill(Pid::from_raw(-pid), Signal::SIGKILL);
    }

    #[test]
    fn a_child_that_outwrites_a_pipe_buffer_is_not_blocked() {
        // The other half of the promise, and the reason stdout is a file: a pipe holds 64 KiB
        // and then blocks the writer until somebody reads. With no parent there is no reader, so
        // a service redirected into a pipe would hang at its 64 KiB-th byte of output, forever.
        let (_dir, path) = workspace();
        let record = start(&path, "head -c 200000 /dev/zero | tr '\\0' 'x'; echo DONE");
        let _cleanup = Cleanup(record.clone());

        assert!(eventually(|| log_text(&record).ends_with("DONE\n")), "the child never got past the buffer");
        assert!(log_text(&record).len() > 200_000);
    }

    #[test]
    fn spawn_creates_the_log_directory() {
        let (_dir, path) = workspace();
        let env = BTreeMap::new();
        let log = path.join("logs/services/web.log");
        let record = spawn(&SpawnRequest { command: "echo hi", cwd: &path, env: &env, log: &log }).expect("spawn");

        assert!(eventually(|| log_text(&record) == "hi\n"), "{:?}", log_text(&record));
    }

    #[test]
    fn env_and_cwd_are_applied() {
        let (_dir, path) = workspace();
        let inner = path.join("inner");
        fs::create_dir(&inner).expect("mkdir");
        let env = BTreeMap::from([("CANOPYWT_TEST_VAR".to_owned(), "applied".to_owned())]);
        let log = path.join("log.txt");
        let record = spawn(&SpawnRequest {
            command: "echo \"$CANOPYWT_TEST_VAR\" > marker.txt; echo done",
            cwd: &inner,
            env: &env,
            log: &log,
        })
        .expect("spawn");

        assert!(eventually(|| log_text(&record) == "done\n"), "{:?}", log_text(&record));
        // Written relative to the child's cwd, which is the only proof that `current_dir` took.
        assert_eq!(fs::read_to_string(inner.join("marker.txt")).expect("marker"), "applied\n");
    }

    #[test]
    fn launch_id_is_exported_to_the_child() {
        let (_dir, path) = workspace();
        let record = start(&path, "echo \"$CANOPYWT_LAUNCH_ID\"");

        assert_eq!(record.launch_id.len(), 32, "{}", record.launch_id);
        assert!(record.launch_id.chars().all(|c| c.is_ascii_hexdigit()), "{}", record.launch_id);
        let echoed = eventually(|| log_text(&record).trim() == record.launch_id);
        assert!(echoed, "expected {:?}, log has {:?}", record.launch_id, log_text(&record));
    }

    #[test]
    fn two_launches_never_share_an_id() {
        let ids: Vec<String> = (0..8).map(|_| launch_id().expect("urandom")).collect();
        let unique: std::collections::BTreeSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "{ids:?}");
    }

    #[test]
    fn stdout_and_stderr_both_land_in_the_log() {
        let (_dir, path) = workspace();
        let record = start(&path, "echo to-stdout; echo to-stderr 1>&2");

        let both = eventually(|| {
            let text = log_text(&record);
            text.contains("to-stdout") && text.contains("to-stderr")
        });
        assert!(both, "{:?}", log_text(&record));
    }

    #[test]
    fn the_log_is_appended_not_truncated() {
        let (_dir, path) = workspace();
        let first = start(&path, "echo one");
        assert!(eventually(|| log_text(&first) == "one\n"));
        let second = start(&path, "echo two");

        assert!(eventually(|| log_text(&second) == "one\ntwo\n"), "{:?}", log_text(&second));
        assert_eq!(tail(&second.log, 10).expect("tail"), vec!["one", "two"]);
    }

    #[test]
    fn a_command_that_cannot_start_is_an_error_not_a_record() {
        let (_dir, path) = workspace();
        let env = BTreeMap::new();
        let log = path.join("log.txt");
        let missing = path.join("no-such-directory");
        let error = spawn(&SpawnRequest { command: "echo hi", cwd: &missing, env: &env, log: &log })
            .expect_err("a missing cwd cannot be entered");

        assert!(matches!(error, ProcError::Spawn { .. }), "{error:?}");
        assert_eq!(error.code(), ErrorCode::ServiceFailed);
    }

    /// Which unusable log path a case is about. All three are the same failure to the caller —
    /// a log we cannot write is a service we cannot supervise — and three different syscalls.
    #[derive(Debug, Clone, Copy)]
    enum BadLog {
        /// A directory is not something stdout can be redirected into.
        Directory,
        /// The root is a directory too, and the one path with no parent to create first.
        Root,
        /// The directory above it cannot be created: a regular file is in the way.
        UnmakeableParent,
    }

    #[rstest]
    #[case(BadLog::Directory)]
    #[case(BadLog::Root)]
    #[case(BadLog::UnmakeableParent)]
    fn a_log_that_cannot_be_opened_is_an_error(#[case] bad: BadLog) {
        let (_dir, path) = workspace();
        let env = BTreeMap::new();
        let log = match bad {
            BadLog::Directory => path.clone(),
            BadLog::Root => Utf8PathBuf::from("/"),
            BadLog::UnmakeableParent => {
                fs::write(path.join("in-the-way"), "").expect("file");
                path.join("in-the-way").join("web.log")
            }
        };

        let error = spawn(&SpawnRequest { command: "echo hi", cwd: &path, env: &env, log: &log })
            .expect_err("an unusable log path must not produce a record");

        assert!(matches!(error, ProcError::Log { .. }), "{bad:?}: {error:?}");
        assert_eq!(error.code(), ErrorCode::ServiceFailed);
    }

    // -----------------------------------------------------------------------------------
    // Stopping
    // -----------------------------------------------------------------------------------

    #[test]
    fn stop_kills_the_whole_process_group() {
        // The bug process groups exist to prevent: `sh -c 'a & b'` leaves `a` running when only
        // the pid we spawned is signalled, and `a` is the thing still holding the port.
        let (_dir, path) = workspace();
        let record = start(&path, "sleep 60 & sleep 60");
        let _cleanup = Cleanup(record.clone());

        assert!(eventually(|| group_members(record.pgid).len() >= 2), "the group never filled out");
        let members = group_members(record.pgid);

        assert_eq!(stop(&record, "SIGTERM", Duration::from_secs(2)), StopOutcome::Terminated);
        for pid in &members {
            assert!(eventually(|| gone(*pid)), "pid {pid} of group {} survived the stop", record.pgid);
        }
    }

    #[test]
    fn stop_escalates_to_sigkill_after_the_timeout() {
        // `trap ''` ignores the signal and `exec` replaces the shell with `sleep` in place: an
        // ignored disposition survives `exec`, so this is one process that is genuinely deaf to
        // SIGTERM. (Without the explicit `exec`, whether the shell stayed around to be escalated
        // against would depend on the shell.)
        let (_dir, path) = workspace();
        // Waiting only for the process to exist is not enough: on a loaded machine SIGTERM can
        // arrive before the shell has run `trap`, and the child then dies of the signal it was
        // supposed to be deaf to — the test fails reporting Terminated, having proved nothing.
        // The marker is written *after* the trap is installed, so waiting for it is waiting for
        // the condition under test.
        let ready = path.join("trapped");
        let record = start(&path, &format!("trap '' TERM; : > {ready}; exec sleep 60"));
        let _cleanup = Cleanup(record.clone());
        assert!(eventually(|| ready.exists()), "the child never installed its trap");

        let started = TestInstant::now();
        let outcome = stop(&record, "SIGTERM", Duration::from_millis(200));
        let elapsed = started.elapsed();

        assert_eq!(outcome, StopOutcome::Killed);
        assert!(elapsed >= std::time::Duration::from_millis(200), "escalated early, after {elapsed:?}");
        // The timeout, the kill grace, and slack for a loaded machine — anything more means the
        // escalation waited on something it should not have.
        assert!(elapsed < std::time::Duration::from_millis(200) + KILL_GRACE.as_std() + PATIENCE, "took {elapsed:?}");
        assert!(gone(record.pid), "stop returned Killed while the process was still there");
    }

    #[test]
    fn stop_refuses_a_record_whose_pid_was_reused() {
        // The catastrophe this module is built around: the pid on disk now belongs to somebody
        // else. Here it belongs to the test runner, which is the most direct way to notice.
        let me = std::process::id() as i32;
        let record = ProcessRecord {
            pid: me,
            // Our own pid as the group: a test binary is not a group leader, so even a broken
            // refusal cannot reach beyond this process.
            pgid: me,
            start_time: Some("Thu Jan 1 00:00:00 1970".to_owned()),
            launch_id: "0".repeat(32),
            command: "sleep 60".to_owned(),
            cwd: Utf8PathBuf::from("/"),
            log: Utf8PathBuf::from("/dev/null"),
            started_at: 0,
        };

        let outcome = stop(&record, "SIGTERM", Duration::from_millis(200));

        assert!(matches!(outcome, StopOutcome::Refused { .. }), "{outcome:?}");
        let StopOutcome::Refused { reason } = outcome else { unreachable!() };
        assert!(reason.contains("reused"), "{reason}");
        assert_eq!(state(&record), ProcessState::Stale);
        // If the check had not held, this line would not be running.
        assert!(!gone(me), "the test process signalled itself");
    }

    #[test]
    fn stop_refuses_when_the_start_time_is_unreadable_but_one_was_recorded() {
        let (_dir, path) = workspace();
        let record = start(&path, "sleep 60");
        let _cleanup = Cleanup(record.clone());
        assert!(record.start_time.is_some());

        force_start_time(None);
        let outcome = stop(&record, "SIGTERM", Duration::from_millis(200));
        let reported = state(&record);
        stop_forcing_start_time();

        assert!(matches!(outcome, StopOutcome::Refused { .. }), "{outcome:?}");
        let StopOutcome::Refused { reason } = outcome else { unreachable!() };
        assert!(reason.contains("could not be read"), "{reason}");
        assert_eq!(reported, ProcessState::Stale);
        // The whole point: "I cannot tell" left the process alone rather than signalling it.
        assert!(!gone(record.pid));
    }

    #[test]
    fn a_record_with_no_recorded_start_time_is_still_ours() {
        // Nothing was recorded, so there is nothing to contradict — the daemon behaves the same
        // way, and refusing here would make a process that we merely failed to measure
        // unstoppable forever.
        let (_dir, path) = workspace();
        let record = ProcessRecord { start_time: None, ..start(&path, "sleep 60") };
        let _cleanup = Cleanup(record.clone());

        assert_eq!(state(&record), ProcessState::Running { pid: record.pid });
        assert_eq!(stop(&record, "SIGTERM", Duration::from_secs(2)), StopOutcome::Terminated);
    }

    #[test]
    fn stop_on_an_already_dead_process_is_not_an_error() {
        let (_dir, path) = workspace();
        let record = start(&path, "true");
        assert!(eventually(|| gone(record.pid)));

        assert_eq!(stop(&record, "SIGTERM", Duration::from_millis(200)), StopOutcome::NotRunning);
    }

    #[test]
    fn stop_falls_back_to_the_pid_when_the_group_has_gone() {
        // A service that calls `setsid` after we start it leaves the recorded group empty while
        // the pid is still very much ours.
        let (_dir, path) = workspace();
        let finished = start(&path, "true");
        assert!(eventually(|| gone(finished.pid)));
        let empty_group = finished.pid;

        let live = start(&path, "sleep 60");
        let record = ProcessRecord { pgid: empty_group, ..live };
        let _cleanup = Cleanup(record.clone());

        assert_eq!(stop(&record, "SIGTERM", Duration::from_secs(2)), StopOutcome::Terminated);
        assert!(gone(record.pid));
    }

    #[rstest]
    #[case("SIGTERM", Signal::SIGTERM)]
    #[case("sigterm", Signal::SIGTERM)]
    #[case("TERM", Signal::SIGTERM)]
    #[case(" SIGINT ", Signal::SIGINT)]
    #[case("int", Signal::SIGINT)]
    #[case("SIGKILL", Signal::SIGKILL)]
    #[case("HUP", Signal::SIGHUP)]
    #[case("SIGUSR1", Signal::SIGUSR1)]
    fn signal_names_are_read_the_way_people_write_them(#[case] name: &str, #[case] expected: Signal) {
        assert_eq!(parse_signal(name), Some(expected));
    }

    #[rstest]
    #[case("")]
    #[case("SIG")]
    #[case("TERMINATE")]
    #[case("9")]
    #[case("SIGNOPE")]
    fn an_unknown_signal_name_is_not_guessed_at(#[case] name: &str) {
        assert_eq!(parse_signal(name), None);
    }

    #[test]
    fn stop_refuses_a_signal_it_does_not_understand() {
        let (_dir, path) = workspace();
        let record = start(&path, "sleep 60");
        let _cleanup = Cleanup(record.clone());

        let outcome = stop(&record, "SIGNOPE", Duration::from_millis(200));

        assert!(matches!(outcome, StopOutcome::Refused { .. }), "{outcome:?}");
        assert!(!gone(record.pid), "a typo in the signal name must not default to killing it");
    }

    // -----------------------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------------------

    #[test]
    fn state_reports_exited_after_the_child_finishes() {
        let (_dir, path) = workspace();
        let record = start(&path, "true");

        assert!(eventually(|| state(&record) == ProcessState::Exited), "{:?}", state(&record));
    }

    #[rstest]
    // Every one of these would be a disaster at a `kill`: 0 is "my own process group", -1 is
    // "every process I own", and a negative pgid negates into a stranger's pid. This is checked
    // through `state`, which only ever sends signal 0 — a test that made `stop` prove it would,
    // the day the guard broke, take the test runner's own process group down with it.
    #[case(0, 0)]
    #[case(-1, -1)]
    #[case(0, 4242)]
    #[case(4242, 0)]
    #[case(-99999, -99999)]
    fn state_refuses_a_record_with_a_nonsense_pid(#[case] pid: i32, #[case] pgid: i32) {
        let record = ProcessRecord {
            pid,
            pgid,
            start_time: None,
            launch_id: "0".repeat(32),
            command: "sleep 60".to_owned(),
            cwd: Utf8PathBuf::from("/"),
            log: Utf8PathBuf::from("/dev/null"),
            started_at: 0,
        };

        assert_eq!(state(&record), ProcessState::Stale);
    }

    #[test]
    fn a_pid_the_system_will_not_talk_about_has_no_start_time() {
        // `ps` exits non-zero for a pid it cannot look up, and its empty output would otherwise
        // normalize into a perfectly comparable empty string — which would make every such pid
        // match every other one and hand `identify` a reason to signal a stranger.
        assert_eq!(read_start_time(i32::MAX), None);
    }

    #[test]
    fn a_process_we_may_not_signal_still_counts_as_running() {
        // EPERM means "it exists, it is not yours" — which is alive, and must not be read as
        // "gone" by a supervisor that would then start a second copy of the service.
        let record = ProcessRecord {
            pid: 1,
            pgid: 1,
            start_time: None,
            launch_id: "0".repeat(32),
            command: "init".to_owned(),
            cwd: Utf8PathBuf::from("/"),
            log: Utf8PathBuf::from("/dev/null"),
            started_at: 0,
        };

        assert_eq!(state(&record), ProcessState::Running { pid: 1 });
    }

    #[test]
    fn the_wire_shapes_are_what_a_consumer_branches_on() {
        assert_eq!(
            serde_json::to_value(ProcessState::Running { pid: 7 }).unwrap(),
            serde_json::json!({ "state": "running", "pid": 7 })
        );
        assert_eq!(serde_json::to_value(ProcessState::Exited).unwrap(), serde_json::json!({ "state": "exited" }));
        assert_eq!(serde_json::to_value(ProcessState::Stale).unwrap(), serde_json::json!({ "state": "stale" }));
        assert_eq!(
            serde_json::to_value(StopOutcome::NotRunning).unwrap(),
            serde_json::json!({ "outcome": "not_running" })
        );
        assert_eq!(
            serde_json::to_value(StopOutcome::Terminated).unwrap(),
            serde_json::json!({ "outcome": "terminated" })
        );
        assert_eq!(serde_json::to_value(StopOutcome::Killed).unwrap(), serde_json::json!({ "outcome": "killed" }));
        assert_eq!(
            serde_json::to_value(StopOutcome::Refused { reason: "why".to_owned() }).unwrap(),
            serde_json::json!({ "outcome": "refused", "reason": "why" })
        );
    }

    // -----------------------------------------------------------------------------------
    // The record on disk
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_record_round_trips_through_disk() {
        let (_dir, path) = workspace();
        let record = start(&path, "sleep 60");
        let _cleanup = Cleanup(record.clone());
        let file = path.join("state").join("web.json");
        fs::create_dir_all(file.parent().unwrap()).expect("mkdir");

        write_record(&file, &record).expect("write");

        assert_eq!(read_record(&file).expect("read"), record);
    }

    #[test]
    fn an_atomic_write_leaves_no_temp_file_behind() {
        let (_dir, path) = workspace();
        let record = start(&path, "sleep 60");
        let _cleanup = Cleanup(record.clone());
        let file = path.join("web.json");

        write_record(&file, &record).expect("write");
        write_record(&file, &record).expect("write again");

        let left: Vec<String> = fs::read_dir(&path)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "web.json" && name != "log.txt")
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_write_that_fails_leaves_no_temp_file_behind() {
        // Either half of write/rename can fail, and neither may leave a `.tmp` beside the real
        // record: `state` lists this directory, and a half-written record is worse than none.
        let (_dir, path) = workspace();
        let record = ProcessRecord {
            pid: 1,
            pgid: 1,
            start_time: None,
            launch_id: "0".repeat(32),
            command: "sleep 60".to_owned(),
            cwd: Utf8PathBuf::from("/"),
            log: Utf8PathBuf::from("/dev/null"),
            started_at: 0,
        };

        // Nowhere to put the temp file: the write fails before anything is renamed.
        let error = write_record(&path.join("nope").join("web.json"), &record).expect_err("no such directory");
        assert!(matches!(error, ProcError::Io(_)), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);

        // The temp file writes fine and the rename is what cannot land: the name is taken by a
        // directory. This is the half that has a temp file to clean up.
        let occupied = path.join("web.json");
        fs::create_dir(&occupied).expect("mkdir");
        let error = write_record(&occupied, &record).expect_err("a directory is not a record");
        assert!(matches!(error, ProcError::Io(_)), "{error:?}");

        let left: Vec<String> = fs::read_dir(&path)
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_record_that_is_not_json_is_reported_not_ignored() {
        let (_dir, path) = workspace();
        let file = path.join("web.json");
        write_lines(&file, "{ this is not a record");

        let error = read_record(&file).expect_err("corrupt");

        assert!(matches!(error, ProcError::Corrupt { .. }), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
        assert!(error.to_string().contains("web.json"), "{error}");
    }

    #[test]
    fn a_missing_record_is_an_io_error() {
        let (_dir, path) = workspace();

        let error = read_record(&path.join("nope.json")).expect_err("missing");

        assert!(matches!(error, ProcError::Io(_)), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
    }

    // -----------------------------------------------------------------------------------
    // Logs
    // -----------------------------------------------------------------------------------

    #[test]
    fn tail_reads_only_the_end_of_a_large_file() {
        let (_dir, path) = workspace();
        let file = path.join("big.log");
        // Fixed-width lines so the arithmetic below is checkable by eye: 32 bytes each,
        // 163_840 of them, a little over 5 MB.
        let count = 163_840;
        let body: String = (0..count).map(|index| format!("line {index:026}\n")).collect();
        assert_eq!(body.len(), count * 32);
        write_lines(&file, &body);

        let started = TestInstant::now();
        let (lines, read) = tail_read(&file, 255).expect("tail");
        let elapsed = started.elapsed();

        assert_eq!(lines.len(), 255);
        assert_eq!(lines[254], format!("line {:026}", count - 1));
        assert_eq!(lines[0], format!("line {:026}", count - 255));
        // The whole point, stated exactly: one byte to see whether the file ends in a newline,
        // then a single chunk — 8191 bytes of it, that final newline having been trimmed off the
        // end. A 5 MB file for 8 KiB of reading.
        assert_eq!(read, 1 + (TAIL_CHUNK as u64 - 1), "read {read} bytes of a {} byte file", body.len());
        assert!(elapsed < std::time::Duration::from_millis(500), "{elapsed:?}");
    }

    #[test]
    fn tail_walks_back_over_as_many_chunks_as_it_needs() {
        let (_dir, path) = workspace();
        let file = path.join("wide.log");
        // Lines far wider than a chunk's worth of newlines: answering needs several chunks.
        let body: String = (0..10).map(|index| format!("{}{index}\n", "x".repeat(4000))).collect();
        write_lines(&file, &body);

        let (lines, read) = tail_read(&file, 5).expect("tail");

        assert_eq!(lines.len(), 5);
        assert_eq!(lines[4], format!("{}9", "x".repeat(4000)));
        assert_eq!(lines[0], format!("{}5", "x".repeat(4000)));
        assert!(read > TAIL_CHUNK as u64, "five 4 KB lines cannot fit in one chunk");
    }

    #[test]
    fn tail_handles_a_file_with_no_trailing_newline() {
        let (_dir, path) = workspace();
        let file = path.join("partial.log");
        write_lines(&file, "one\ntwo\nthree");

        assert_eq!(tail(&file, 2).expect("tail"), vec!["two", "three"]);
        assert_eq!(tail(&file, 99).expect("tail"), vec!["one", "two", "three"]);
    }

    #[test]
    fn tail_does_not_invent_an_empty_last_line() {
        let (_dir, path) = workspace();
        let file = path.join("whole.log");
        write_lines(&file, "one\ntwo\n");

        assert_eq!(tail(&file, 5).expect("tail"), vec!["one", "two"]);
    }

    #[test]
    fn tail_of_an_empty_file_is_empty() {
        let (_dir, path) = workspace();
        let file = path.join("empty.log");
        write_lines(&file, "");

        assert_eq!(tail(&file, 10).expect("tail"), Vec::<String>::new());
    }

    #[test]
    fn tail_of_a_file_that_is_one_newline_is_one_empty_line() {
        let (_dir, path) = workspace();
        let file = path.join("newline.log");
        write_lines(&file, "\n");

        assert_eq!(tail(&file, 10).expect("tail"), vec![""]);
    }

    #[test]
    fn tail_returns_fewer_lines_than_asked_rather_than_padding() {
        let (_dir, path) = workspace();
        let file = path.join("short.log");
        write_lines(&file, "one\ntwo\nthree\n");

        assert_eq!(tail(&file, 10).expect("tail"), vec!["one", "two", "three"]);
        assert_eq!(tail(&file, 1).expect("tail"), vec!["three"]);
    }

    #[test]
    fn tail_of_no_lines_reads_nothing_at_all() {
        let (_dir, path) = workspace();
        let file = path.join("some.log");
        write_lines(&file, "one\ntwo\n");

        assert_eq!(tail_read(&file, 0).expect("tail"), (Vec::new(), 0));
    }

    #[test]
    fn tail_strips_the_carriage_return_of_a_crlf_log() {
        let (_dir, path) = workspace();
        let file = path.join("crlf.log");
        write_lines(&file, "one\r\ntwo\r\n");

        assert_eq!(tail(&file, 2).expect("tail"), vec!["one", "two"]);
    }

    #[test]
    fn tail_of_a_missing_file_is_an_error() {
        let (_dir, path) = workspace();

        let error = tail(&path.join("nope.log"), 10).expect_err("missing");

        assert!(matches!(error, ProcError::Io(_)), "{error:?}");
    }

    // -----------------------------------------------------------------------------------
    // The suite's own waiting
    // -----------------------------------------------------------------------------------

    #[test]
    fn the_wait_helper_keeps_polling_and_then_gives_up() {
        // Every assertion above about a process dying or output landing goes through this. One
        // that gave up on the first `false` would turn all of them into races with the
        // scheduler; one that never gave up would hang the suite instead of failing it.
        let asked = Cell::new(0u32);
        let on_the_third_ask = || {
            asked.set(asked.get() + 1);
            asked.get() >= 3
        };

        assert!(within(PATIENCE, on_the_third_ask), "it gave up on a condition that came true");
        assert_eq!(asked.get(), 3, "it answered without asking three times");

        // The same condition with no time to reach its third ask.
        asked.set(0);
        assert!(!within(std::time::Duration::ZERO, on_the_third_ask), "a condition that never holds must return");
    }
}
