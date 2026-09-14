//! Running a worktree's `setup:` steps — the port of `runShell` and `anyChanged` in
//! `packages/daemon/src/env/provision/steps.ts`.
//!
//! Setup is the slowest thing `canopywt` does and the thing most likely to fail, so three
//! decisions shape the whole module:
//!
//! - **Output is streamed, not collected.** A four-minute `npm ci` that prints nothing until it
//!   is over is indistinguishable from a hung one. Every line goes to the caller's `on_line` the
//!   moment it is read; only the last [`TAIL_LINES`] are retained, and only so a failure can
//!   quote something.
//! - **Each step gets its own process group.** `sh -c 'vite build & tsc'` leaves the backgrounded
//!   half running when only the shell is signalled. A timeout that has to be finished off by
//!   hand is not a timeout, so the group — not the shell — is what gets signalled.
//! - **`if_changed` compares bytes, never mtimes.** `git worktree add` writes every file at
//!   checkout time, so in a fresh worktree *every* mtime is newer than the source's. An mtime
//!   comparison would report "changed" for a file that is byte-for-byte identical, and the
//!   `npm ci` this feature exists to skip would run every single time.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Instant;

use camino::{Utf8Path, Utf8PathBuf};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use serde::Serialize;

use crate::config::{Duration, SetupStep};

/// The shell every step runs under, matching the daemon's `execa('/bin/sh', ['-c', command])`.
/// A step is a shell snippet — `a && b | c` — not an argv, and pretending otherwise would break
/// half the `setup:` blocks in existence.
const SHELL: &str = "/bin/sh";

/// How many trailing output lines a failure carries.
///
/// Enough to show a compiler's last error and the frame or two of context under it; few enough
/// that a step which fails after printing a megabyte does not put that megabyte in an error.
pub const TAIL_LINES: usize = 20;

/// How long the reader loop blocks before re-checking the deadline.
///
/// Only ever reached when the step is silent: a line that arrives wakes the loop immediately, so
/// this is the latency of *noticing a timeout*, not of delivering output.
const POLL: std::time::Duration = std::time::Duration::from_millis(20);

/// Grace between `SIGTERM` and `SIGKILL` on a timeout.
///
/// A step killed mid-write can leave a half-written lockfile, so it is asked to stop before it is
/// made to. Short, because the step has already overrun its budget and the user is waiting.
const TERM_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/// Why a setup run could not be *attempted*.
///
/// Module-local rather than a [`crate::Error`] variant, and deliberately narrow: a step that
/// exits non-zero is not one of these. A failing build is the normal, reportable outcome of
/// running setup — it belongs in [`StepResult::Failed`] alongside its output, where a caller can
/// show it — whereas these are the cases where there was nothing to report on at all.
#[derive(Debug, thiserror::Error)]
pub enum SetupError {
    #[error("setup step cwd {path}: {source}")]
    Io {
        path: Utf8PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("`{command}` could not be run: {source}")]
    Shell {
        command: String,
        #[source]
        source: std::io::Error,
    },

    #[error("if_changed pattern {pattern:?} is not a valid glob: {source}")]
    BadPattern {
        pattern: String,
        #[source]
        source: globset::Error,
    },

    /// A `--only` label that matches no step. Silence would be worse: a typo would report a
    /// clean, instant, completely empty run, and the missing build would be found much later.
    #[error("no setup step is called {0:?}")]
    UnknownStep(String),
}

// ---------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------

/// Which pipe a line came out of. Kept distinct all the way to the caller so a terminal can
/// colour stderr and a log can label it — merging them is a one-liner for whoever wants it, and
/// un-merging them is impossible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Out,
    Err,
}

/// What became of one step. Serialized into the `--json` envelope, so the tags are an API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StepResult {
    Ran {
        millis: u64,
    },
    /// `if_changed` found nothing to do. The reason names the globs, because "skipped" on its own
    /// is the start of a bug report rather than the end of one.
    Skipped {
        reason: String,
    },
    Failed {
        /// `exit 1`, `killed by signal 9`, `timed out after 2m`.
        status: String,
        /// The last [`TAIL_LINES`] lines of output, both streams in the order they arrived.
        tail: Vec<String>,
        millis: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepOutcome {
    /// The step's `name`, else `step N`; the same spelling `only` accepts.
    pub name: String,
    /// The shell snippet, verbatim, so a report is reproducible by copy-paste.
    pub command: String,
    pub result: StepResult,
}

/// The result of a whole run.
///
/// `steps` holds only the steps that were *considered*: a run stops at the first failure, so a
/// short list with `ok: false` is how "and the rest never happened" is spelled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupOutcome {
    pub steps: Vec<StepOutcome>,
    pub ok: bool,
}

// ---------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SetupOptions<'a> {
    pub worktree: &'a Utf8Path,
    /// The checkout `if_changed` compares against. `None` disables the skip check, so every step
    /// runs — the right answer when there is no baseline to compare with.
    pub source: Option<&'a Utf8Path>,
    /// The resolved environment: layered *under* each step's own `env`, and over the process's.
    pub env: &'a BTreeMap<String, String>,
    /// Run every step even when `if_changed` says it could be skipped.
    pub force: bool,
    /// Run only these step labels. Order comes from the config, not from this list.
    pub only: Option<Vec<String>>,
    /// Per-step, not per-run: one budget shared across ten steps would make which step gets
    /// killed depend on how long the previous nine took.
    pub timeout: Option<Duration>,
}

// ---------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------

/// Runs `steps` in order, stopping at the first failure.
///
/// `on_line` receives `(stream, text)` for every line as it is read, on the calling thread. It is
/// the only way output leaves this function while the step is alive, which is the point: a caller
/// that wants a progress display, a log file or both wires them here and gets them live.
///
/// An `Err` means the run could not be attempted (see [`SetupError`]); a step that failed comes
/// back as an `Ok` outcome with `ok: false`.
pub fn run_setup(
    steps: &[SetupStep],
    options: &SetupOptions<'_>,
    on_line: &mut dyn FnMut(Stream, &str),
) -> Result<SetupOutcome, SetupError> {
    let labels: Vec<String> = steps.iter().enumerate().map(|(index, step)| step.label(index)).collect();
    if let Some(only) = &options.only {
        for wanted in only {
            if !labels.contains(wanted) {
                return Err(SetupError::UnknownStep(wanted.clone()));
            }
        }
    }

    let mut outcome = SetupOutcome { steps: Vec::new(), ok: true };
    for (index, step) in steps.iter().enumerate() {
        let label = &labels[index];
        if let Some(only) = &options.only {
            // Unselected steps are absent from the report rather than listed as skipped: `--only
            // build` asked about one step, and burying it under nine "not selected" lines answers
            // a question nobody asked.
            if !only.contains(label) {
                continue;
            }
        }
        let result = match skip_reason(step, options)? {
            Some(reason) => StepResult::Skipped { reason },
            None => run_step(step, options, on_line)?,
        };
        let failed = matches!(result, StepResult::Failed { .. });
        outcome.steps.push(StepOutcome { name: label.clone(), command: step.run.clone(), result });
        if failed {
            outcome.ok = false;
            break;
        }
    }
    Ok(outcome)
}

/// `Some(reason)` when `if_changed` says this step has nothing to do.
fn skip_reason(step: &SetupStep, options: &SetupOptions<'_>) -> Result<Option<String>, SetupError> {
    if options.force {
        return Ok(None);
    }
    let (Some(source), Some(patterns)) = (options.source, step.if_changed.as_ref()) else {
        return Ok(None);
    };
    if any_changed(patterns, source, options.worktree)? {
        return Ok(None);
    }
    Ok(Some(format!("{} unchanged", patterns.join(", "))))
}

/// Spawns one step and pumps its output until both pipes close or the timeout expires.
fn run_step(
    step: &SetupStep,
    options: &SetupOptions<'_>,
    on_line: &mut dyn FnMut(Stream, &str),
) -> Result<StepResult, SetupError> {
    let cwd = match &step.cwd {
        Some(relative) => options.worktree.join(relative),
        None => options.worktree.to_path_buf(),
    };
    // Created rather than required: `cwd: dist` in a fresh worktree names a directory the step
    // itself is about to fill, and failing before it runs would be a chicken-and-egg error.
    fs::create_dir_all(&cwd).map_err(|source| SetupError::Io { path: cwd.clone(), source })?;

    let began = Instant::now();
    let mut child = Command::new(SHELL)
        .arg("-c")
        .arg(&step.run)
        .current_dir(&cwd)
        // The process environment first, then the resolved one, then the step's own: a step may
        // override a project variable, and both may override the shell we were launched from.
        .envs(options.env)
        .envs(&step.env)
        // Nothing on stdin: setup runs unattended, and a step that stops to ask a question would
        // otherwise hang a provision until someone noticed.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own group, so a timeout can take down everything the step started.
        .process_group(0)
        .spawn()
        .map_err(|source| SetupError::Shell { command: step.run.clone(), source })?;

    let pid = child.id();
    let (sender, lines) = mpsc::channel::<(Stream, String)>();
    // Both pipes are drained on their own threads. A step that fills the stderr pipe while we sit
    // reading stdout would deadlock: it blocks writing, we block reading, and neither moves.
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_sender = sender.clone();
    let pumps = [
        std::thread::spawn(move || pump(stdout, Stream::Out, &stdout_sender)),
        std::thread::spawn(move || pump(stderr, Stream::Err, &sender)),
    ];

    let mut tail: VecDeque<String> = VecDeque::new();
    let deadline = options.timeout.map(|limit| began + limit.as_std());
    let mut termed: Option<Instant> = None;
    let mut timed_out: Option<Duration> = None;
    loop {
        let wait = deadline.map_or(POLL, |at| at.saturating_duration_since(Instant::now()).min(POLL));
        match lines.recv_timeout(wait) {
            Ok((stream, text)) => {
                tail.push_back(text.clone());
                if tail.len() > TAIL_LINES {
                    tail.pop_front();
                }
                on_line(stream, &text);
                continue;
            }
            // Both pipes are closed and both pumps are done. Note this waits for the *pipes*, not
            // for the process: a step whose grandchild still holds stdout keeps us here, which is
            // what we want — that grandchild's output is still the step's output.
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        match nudge(Instant::now(), deadline, termed) {
            Nudge::Wait => {}
            Nudge::Term => {
                timed_out = options.timeout;
                signal_group(pid, Signal::SIGTERM);
                termed = Some(Instant::now());
            }
            // Re-sent every poll until the pipes finally close, which costs one failing syscall
            // and removes the need to track whether the last one landed. The child is unreaped,
            // so its pid — and therefore its group — cannot be recycled under us.
            Nudge::Kill => {
                signal_group(pid, Signal::SIGKILL);
            }
        }
    }

    for pump in pumps {
        let _ = pump.join();
    }
    let status = child.wait().map_err(|source| SetupError::Shell { command: step.run.clone(), source })?;
    let millis = u64::try_from(began.elapsed().as_millis()).unwrap_or(u64::MAX);
    let tail: Vec<String> = tail.into();

    // Reported as the timeout rather than as "killed by signal 15": the signal is how we stopped
    // it, the budget is why.
    if let Some(limit) = timed_out {
        return Ok(StepResult::Failed { status: format!("timed out after {limit}"), tail, millis });
    }
    if status.success() {
        return Ok(StepResult::Ran { millis });
    }
    Ok(StepResult::Failed { status: describe(status), tail, millis })
}

/// Splits a pipe into lines and forwards them, until EOF or until the receiver is gone.
///
/// Line-at-a-time rather than read-to-end: the whole reason this runs on a thread is so a caller
/// sees `npm ci`'s progress while it is happening.
fn pump(reader: impl Read, stream: Stream, sender: &Sender<(Stream, String)>) {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        // A read error is treated as EOF: the pipe is broken, there is nothing more to say about
        // it, and the step's own exit status is the thing that will be reported anyway.
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        // Lossy on purpose. A build tool emitting a stray byte of latin-1 in a warning must not
        // cost the user the rest of the output.
        let mut text = String::from_utf8_lossy(&buffer).into_owned();
        if text.ends_with('\n') {
            text.pop();
            if text.ends_with('\r') {
                text.pop();
            }
        }
        if sender.send((stream, text)).is_err() {
            return;
        }
    }
}

/// What the reader loop should do to the step right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Nudge {
    /// Still inside its budget, or already asked to stop and still within its grace.
    Wait,
    Term,
    Kill,
}

/// The whole escalation policy, as a pure function of the clock.
///
/// Split out from the loop deliberately: "SIGTERM at the deadline, SIGKILL a grace later" is the
/// part with the off-by-ones in it, and a real clock can only ever test it approximately. Here
/// both boundaries can be hit exactly.
///
/// `termed` is when SIGTERM was sent, not when SIGKILL is due, so the grace lives in one place
/// instead of being baked into a deadline at the call site.
fn nudge(now: Instant, deadline: Option<Instant>, termed: Option<Instant>) -> Nudge {
    match (deadline, termed) {
        (_, Some(at)) if at + TERM_GRACE <= now => Nudge::Kill,
        (Some(at), None) if at <= now => Nudge::Term,
        _ => Nudge::Wait,
    }
}

/// Signals the whole group. Returns whether a signal was actually sent.
///
/// A negative pid means "the group", which is the entire point: `sh -c 'a & b'` leaves `a`
/// running when only the shell is signalled.
fn signal_group(pid: u32, sig: Signal) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // Never group 0 — that is *our own* group, so it would signal this process and everything
    // that launched it.
    if pid == 0 {
        return false;
    }
    let _ = signal::kill(Pid::from_raw(-pid), sig);
    true
}

/// How a step ended, for a human. `exit 1` and `killed by signal 9` need different fixes.
fn describe(status: ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("exit {code}"),
        None => format!("killed by signal {}", status.signal().unwrap_or(0)),
    }
}

// ---------------------------------------------------------------------------------------
// if_changed
// ---------------------------------------------------------------------------------------

/// Whether anything matching `patterns` differs between two checkouts.
///
/// Exposed on its own so a caller can explain a skip — or preview one — without running a thing.
///
/// Three rules, and the conservative answer wins every tie, because skipping work the user asked
/// for costs a mystifying debugging session while repeating it costs a minute:
///
/// - A file present on one side and absent on the other is **changed**.
/// - No matches at all is **changed**. A glob that matches nothing is far more likely to be a
///   typo, or a file that does not exist yet, than a genuine "nothing to do".
/// - Everything else is compared **byte for byte**. Not mtime: a fresh worktree's files are all
///   newly written, so every mtime differs and nothing would ever be skipped.
pub fn any_changed(patterns: &[String], source: &Utf8Path, target: &Utf8Path) -> Result<bool, SetupError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        // `literal_separator` so `apps/*/package.json` means one directory level, the way the
        // daemon's picomatch defaults do — `*` quietly crossing `/` would make a narrow rule
        // match a whole tree.
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|source| SetupError::BadPattern { pattern: pattern.clone(), source })?;
        builder.add(glob);
    }
    let set = builder.build().map_err(|source| SetupError::BadPattern { pattern: patterns.join(", "), source })?;

    // The union of both sides, so a file that exists in only one of them still gets compared.
    let mut files = BTreeSet::new();
    collect(source, &set, &mut files);
    collect(target, &set, &mut files);
    if files.is_empty() {
        return Ok(true);
    }
    for file in &files {
        if !same_content(&source.join(file), &target.join(file))? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Adds every file under `root` matching `set`, as a path relative to `root`.
///
/// Ignore rules are honoured — this is the walk equivalent of the daemon's `git ls-files --cached
/// --others --exclude-standard` — so a `.gitignore`d build artefact is not something a rule can
/// accidentally gate on.
///
/// Walk errors are swallowed rather than propagated. An unreadable directory means we cannot see
/// a file that might have changed, and the conservative reading of "cannot see" is "assume it
/// did": an empty or partial listing lands on [`any_changed`]'s "changed" answer, never on a
/// silent skip.
fn collect(root: &Utf8Path, set: &GlobSet, into: &mut BTreeSet<Utf8PathBuf>) {
    let walk = WalkBuilder::new(root)
        // `.env`, `.tool-versions`, `.nvmrc` — dotfiles are exactly what people gate on.
        .hidden(false)
        // Only this tree's own rules: a checkout in someone's home directory must not inherit a
        // stray `~/.gitignore` and start reporting its own lockfile as invisible.
        .parents(false)
        // A worktree is a git checkout in practice, but not necessarily under test, and
        // `.gitignore` should mean the same thing either way.
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();
    for entry in walk.flatten() {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        // A non-UTF-8 name cannot be named by a UTF-8 glob, so it cannot be one of ours.
        let Some(path) = Utf8Path::from_path(entry.path()) else {
            continue;
        };
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if set.is_match(relative) {
            into.insert(relative.to_owned());
        }
    }
}

/// Whether two paths hold the same bytes.
fn same_content(left: &Utf8Path, right: &Utf8Path) -> Result<bool, SetupError> {
    match (read_file(left)?, read_file(right)?) {
        (Some(left), Some(right)) => Ok(left == right),
        // Neither side holds a regular file — the glob matched a directory in one of them, say.
        // There is no content to have changed.
        (None, None) => Ok(true),
        // Present on one side only: the very case an mtime comparison cannot even express.
        _ => Ok(false),
    }
}

/// The file's bytes, or `None` when the path is not a regular file.
///
/// Whole-file reads rather than a streaming hash: `if_changed` names lockfiles and manifests —
/// the files a build is keyed on — and buying exactness and simplicity for a few hundred kilobytes
/// of transient memory is the right trade. A hash would additionally admit collisions, and a
/// collision here means silently skipping the build the user asked for.
fn read_file(path: &Utf8Path) -> Result<Option<Vec<u8>>, SetupError> {
    // Follows symlinks, and is false for a directory or a missing path — exactly the "no
    // comparable content here" answer.
    if !path.is_file() {
        return Ok(None);
    }
    fs::read(path).map(Some).map_err(|source| SetupError::Io { path: path.to_owned(), source })
}

#[cfg(test)]
mod tests {
    use std::time::Duration as StdDuration;

    use rstest::rstest;
    use tempfile::TempDir;

    use super::*;
    use crate::config::Map;

    // -----------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------

    /// [`TERM_GRACE`] in milliseconds, so the boundary cases below can name it exactly.
    const GRACE_MS: u64 = TERM_GRACE.as_millis() as u64;

    fn temp() -> TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn path_of(dir: &TempDir) -> &Utf8Path {
        Utf8Path::from_path(dir.path()).expect("tempdir is utf-8")
    }

    fn step(run: &str) -> SetupStep {
        SetupStep { run: run.to_owned(), name: None, cwd: None, env: Map::new(), if_changed: None }
    }

    fn named(name: &str, run: &str) -> SetupStep {
        SetupStep { name: Some(name.to_owned()), ..step(run) }
    }

    fn no_env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn options<'a>(worktree: &'a Utf8Path, env: &'a BTreeMap<String, String>) -> SetupOptions<'a> {
        SetupOptions { worktree, source: None, env, force: false, only: None, timeout: None }
    }

    /// Runs and collects every streamed line alongside the outcome.
    fn run(steps: &[SetupStep], options: &SetupOptions<'_>) -> (SetupOutcome, Vec<(Stream, String)>) {
        let mut lines = Vec::new();
        let outcome =
            run_setup(steps, options, &mut |stream, text| lines.push((stream, text.to_owned()))).expect("run_setup");
        (outcome, lines)
    }

    fn write(path: &Utf8Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(path, contents).expect("write");
    }

    fn read(path: &Utf8Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    fn texts(lines: &[(Stream, String)]) -> Vec<&str> {
        lines.iter().map(|(_, text)| text.as_str()).collect()
    }

    /// Starts one step on its own thread and hands back a channel carrying its outcome.
    ///
    /// Every test that uses this is about *stopping* a step, and the failure mode they guard
    /// against is a reader loop that waits forever. Joining a thread would inherit that hang;
    /// a channel lets the test give up, fail, and let the harness exit.
    fn spawn_run(command: &str, timeout: Duration) -> mpsc::Receiver<SetupOutcome> {
        let dir = temp();
        let worktree = path_of(&dir).to_owned();
        let command = command.to_owned();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            // Held for the length of the run: dropping it would delete the step's cwd underneath it.
            let _dir = dir;
            let env = no_env();
            let mut options = options(&worktree, &env);
            options.timeout = Some(timeout);
            let outcome = run_setup(&[step(&command)], &options, &mut |_, _| {}).expect("run_setup");
            let _ = sender.send(outcome);
        });
        receiver
    }

    /// How many processes currently have `needle` on their command line.
    fn processes_matching(needle: &str) -> usize {
        let out = Command::new("ps").args(["-A", "-o", "command"]).output().expect("ps");
        String::from_utf8_lossy(&out.stdout).lines().filter(|line| line.contains(needle)).count()
    }

    /// Kills any `sleep <token>` left behind by an interrupted earlier run, so the "the children
    /// really started" assertions cannot be satisfied by a ghost.
    fn reap(token: &str) {
        let _ = Command::new("pkill").args(["-f", &format!("sleep {token}")]).status();
        std::thread::sleep(StdDuration::from_millis(100));
    }

    /// Polls until `needle` is gone, up to a second. Bounded: a blocking wait here would hang the
    /// suite for five minutes if the signal never landed.
    fn waits_until_gone(needle: &str) -> bool {
        (0..40).any(|_| {
            std::thread::sleep(StdDuration::from_millis(25));
            processes_matching(needle) == 0
        })
    }

    // -----------------------------------------------------------------------------------
    // Ordering, environment, cwd
    // -----------------------------------------------------------------------------------

    #[test]
    fn runs_steps_in_order() {
        let dir = temp();
        let env = no_env();
        let steps = [
            step("printf 'a\\n' >> order.log"),
            step("printf 'b\\n' >> order.log"),
            step("printf 'c\\n' >> order.log"),
        ];

        let (outcome, _) = run(&steps, &options(path_of(&dir), &env));

        assert!(outcome.ok);
        assert_eq!(read(&path_of(&dir).join("order.log")), "a\nb\nc\n");
        assert_eq!(outcome.steps.len(), 3);
        assert!(outcome.steps.iter().all(|s| matches!(s.result, StepResult::Ran { .. })));
    }

    #[test]
    fn the_resolved_env_reaches_the_step() {
        let dir = temp();
        let env = BTreeMap::from([("CANOPY_TOKEN".to_owned(), "swordfish".to_owned())]);

        let (outcome, lines) = run(&[step("echo \"$CANOPY_TOKEN\"")], &options(path_of(&dir), &env));

        assert!(outcome.ok);
        assert_eq!(texts(&lines), ["swordfish"]);
    }

    #[test]
    fn a_step_env_layers_over_the_resolved_env() {
        let dir = temp();
        let env =
            BTreeMap::from([("SHARED".to_owned(), "project".to_owned()), ("KEPT".to_owned(), "project".to_owned())]);
        let mut step = step("echo \"$SHARED $KEPT\"");
        step.env = Map::from([("SHARED".to_owned(), "step".to_owned())]);

        let (_, lines) = run(&[step], &options(path_of(&dir), &env));

        assert_eq!(texts(&lines), ["step project"]);
    }

    #[test]
    fn step_cwd_is_relative_to_the_worktree_and_created_if_absent() {
        let dir = temp();
        let env = no_env();
        let mut step = step("printf here > marker.txt");
        step.cwd = Some("apps/web/dist".to_owned());

        let (outcome, _) = run(&[step], &options(path_of(&dir), &env));

        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(read(&path_of(&dir).join("apps/web/dist/marker.txt")), "here");
    }

    #[test]
    fn a_cwd_that_cannot_be_created_is_an_error() {
        let dir = temp();
        let env = no_env();
        // `blocker` is a file, so `blocker/inside` can never be a directory.
        write(&path_of(&dir).join("blocker"), "not a directory");
        let mut step = step("true");
        step.cwd = Some("blocker/inside".to_owned());

        let error = run_setup(&[step], &options(path_of(&dir), &env), &mut |_, _| {}).expect_err("should fail");

        assert!(matches!(error, SetupError::Io { .. }), "{error:?}");
    }

    #[test]
    fn no_steps_is_a_successful_no_op() {
        let dir = temp();
        let env = no_env();

        let (outcome, lines) = run(&[], &options(path_of(&dir), &env));

        assert_eq!(outcome, SetupOutcome { steps: Vec::new(), ok: true });
        assert!(lines.is_empty());
    }

    #[test]
    fn shell_features_work() {
        let dir = temp();
        let env = no_env();
        let steps = [step("true && printf '%s\\n' \"$(echo hello | tr a-z A-Z)\" 'two words'")];

        let (outcome, lines) = run(&steps, &options(path_of(&dir), &env));

        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(texts(&lines), ["HELLO", "two words"]);
    }

    // -----------------------------------------------------------------------------------
    // Failure
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_failing_step_stops_the_run_and_names_itself() {
        let dir = temp();
        let env = no_env();
        let steps = [
            named("install", "printf 'a\\n' >> order.log"),
            named("build", "exit 3"),
            named("test", "printf 'c\\n' >> order.log"),
        ];

        let (outcome, _) = run(&steps, &options(path_of(&dir), &env));

        assert!(!outcome.ok);
        assert_eq!(outcome.steps.len(), 2, "the run must stop at the failure: {outcome:?}");
        assert_eq!(outcome.steps[1].name, "build");
        assert_eq!(outcome.steps[1].command, "exit 3");
        assert!(matches!(&outcome.steps[1].result, StepResult::Failed { status, .. } if status == "exit 3"));
        // The proof that "later steps do not run" is not the report but the filesystem.
        assert_eq!(read(&path_of(&dir).join("order.log")), "a\n");
    }

    #[test]
    fn the_failure_carries_the_tail_of_the_output() {
        let dir = temp();
        let env = no_env();
        let steps = [step("i=1; while [ $i -le 30 ]; do echo \"line $i\"; i=$((i+1)); done; exit 1")];

        let (outcome, lines) = run(&steps, &options(path_of(&dir), &env));

        // Everything was streamed; only the tail was retained.
        assert_eq!(lines.len(), 30);
        let StepResult::Failed { tail, .. } = &outcome.steps[0].result else {
            panic!("expected a failure: {outcome:?}");
        };
        assert_eq!(tail.len(), TAIL_LINES);
        assert_eq!(tail.first().map(String::as_str), Some("line 11"));
        assert_eq!(tail.last().map(String::as_str), Some("line 30"));
    }

    #[test]
    fn a_step_killed_by_a_signal_says_so() {
        let dir = temp();
        let env = no_env();
        // `$$` is this shell; killing it leaves no exit code, only a signal.
        let steps = [step("kill -9 $$")];

        let (outcome, _) = run(&steps, &options(path_of(&dir), &env));

        assert!(!outcome.ok);
        assert!(
            matches!(&outcome.steps[0].result, StepResult::Failed { status, .. } if status == "killed by signal 9"),
            "{outcome:?}"
        );
    }

    // -----------------------------------------------------------------------------------
    // Streaming
    // -----------------------------------------------------------------------------------

    #[test]
    fn output_is_streamed_line_by_line_as_it_happens() {
        let dir = temp();
        let env = no_env();
        let steps = [step("echo one; sleep 0.4; echo two")];

        let began = Instant::now();
        let mut seen: Vec<(String, StdDuration)> = Vec::new();
        let outcome = run_setup(&steps, &options(path_of(&dir), &env), &mut |_, text| {
            seen.push((text.to_owned(), began.elapsed()));
        })
        .expect("run_setup");
        let whole = began.elapsed();

        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, "one");
        // The gap between the two callbacks, not their absolute times: an implementation that
        // buffered everything and replayed it at the end would fire both within a microsecond of
        // each other, however loaded the machine is. The step's own `sleep` is the only thing
        // that can put a third of a second between them, so the first line must have been
        // delivered while the step was still running.
        let gap = seen[1].1.saturating_sub(seen[0].1);
        assert!(gap >= StdDuration::from_millis(300), "both lines arrived together, {gap:?} apart");
        assert!(whole.saturating_sub(seen[0].1) >= StdDuration::from_millis(300), "{whole:?} vs {:?}", seen[0].1);
    }

    #[test]
    fn stdout_and_stderr_are_distinguished() {
        let dir = temp();
        let env = no_env();
        let steps = [step("echo to-stdout; echo to-stderr >&2")];

        let (_, lines) = run(&steps, &options(path_of(&dir), &env));

        assert!(lines.contains(&(Stream::Out, "to-stdout".to_owned())), "{lines:?}");
        assert!(lines.contains(&(Stream::Err, "to-stderr".to_owned())), "{lines:?}");
    }

    #[test]
    fn carriage_returns_and_a_final_unterminated_line_are_handled() {
        let dir = temp();
        let env = no_env();
        // A CRLF line, a blank line, and a last line with no newline at all.
        let steps = [step("printf 'crlf\\r\\n\\nno-newline'")];

        let (outcome, lines) = run(&steps, &options(path_of(&dir), &env));

        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(texts(&lines), ["crlf", "", "no-newline"]);
    }

    #[test]
    fn a_step_that_floods_stderr_does_not_deadlock() {
        let dir = temp();
        let env = no_env();
        // Far more than a pipe buffer on stderr while stdout also has traffic: a single-threaded
        // reader would block on one pipe while the step blocked on the other.
        let steps = [step("i=1; while [ $i -le 2000 ]; do echo \"e $i\" >&2; i=$((i+1)); done; echo done")];
        let mut options = options(path_of(&dir), &env);
        options.timeout = Some(Duration::from_secs(20));

        let (outcome, lines) = run(&steps, &options);

        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(lines.iter().filter(|(stream, _)| *stream == Stream::Err).count(), 2000);
    }

    // -----------------------------------------------------------------------------------
    // if_changed
    // -----------------------------------------------------------------------------------

    /// A source and a worktree, each with `package-lock.json` at the given contents, plus a step
    /// gated on that lockfile which leaves a marker behind when it runs.
    fn lockfile_case(source_text: &str, target_text: &str) -> (TempDir, TempDir, SetupStep) {
        let source = temp();
        let target = temp();
        write(&path_of(&source).join("package-lock.json"), source_text);
        write(&path_of(&target).join("package-lock.json"), target_text);
        let mut gated = step("printf ran > ran.txt");
        gated.if_changed = Some(vec!["package-lock.json".to_owned()]);
        (source, target, gated)
    }

    fn ran(target: &TempDir) -> bool {
        path_of(target).join("ran.txt").exists()
    }

    #[test]
    fn if_changed_skips_when_the_files_match() {
        let (source, target, gated) = lockfile_case("{\"lock\":1}", "{\"lock\":1}");
        let env = no_env();
        let mut options = options(path_of(&target), &env);
        options.source = Some(path_of(&source));

        let (outcome, _) = run(&[gated], &options);

        assert!(outcome.ok);
        assert!(!ran(&target), "the step should have been skipped");
        assert_eq!(outcome.steps[0].result, StepResult::Skipped { reason: "package-lock.json unchanged".to_owned() });
    }

    #[test]
    fn if_changed_runs_when_they_differ() {
        let (source, target, gated) = lockfile_case("{\"lock\":1}", "{\"lock\":2}");
        let env = no_env();
        let mut options = options(path_of(&target), &env);
        options.source = Some(path_of(&source));

        let (outcome, _) = run(&[gated], &options);

        assert!(ran(&target), "the step should have run: {outcome:?}");
        assert!(matches!(outcome.steps[0].result, StepResult::Ran { .. }));
    }

    #[rstest]
    // Removed in the worktree...
    #[case(true, false)]
    // ...and added by it. Both are changes; neither can be expressed by comparing two mtimes.
    #[case(false, true)]
    fn if_changed_runs_when_a_file_is_missing_on_one_side(#[case] in_source: bool, #[case] in_target: bool) {
        let source = temp();
        let target = temp();
        if in_source {
            write(&path_of(&source).join("package-lock.json"), "{}");
        }
        if in_target {
            write(&path_of(&target).join("package-lock.json"), "{}");
        }
        let mut gated = step("printf ran > ran.txt");
        gated.if_changed = Some(vec!["package-lock.json".to_owned()]);
        let env = no_env();
        let mut options = options(path_of(&target), &env);
        options.source = Some(path_of(&source));

        let (outcome, _) = run(&[gated], &options);

        assert!(ran(&target), "a one-sided file is a change: {outcome:?}");
    }

    #[test]
    fn if_changed_runs_when_nothing_matches_the_glob() {
        let source = temp();
        let target = temp();
        let mut gated = step("printf ran > ran.txt");
        gated.if_changed = Some(vec!["never-existed.lock".to_owned()]);
        let env = no_env();
        let mut options = options(path_of(&target), &env);
        options.source = Some(path_of(&source));

        let (outcome, _) = run(&[gated], &options);

        assert!(ran(&target), "an unmatched glob must be conservative: {outcome:?}");
    }

    #[test]
    fn if_changed_compares_content_not_mtime() {
        let (source, target, gated) = lockfile_case("{\"lock\":1}", "{\"lock\":1}");
        let lock = path_of(&source).join("package-lock.json");
        Command::new("touch").args(["-t", "202001010000", lock.as_str()]).status().expect("touch");
        let source_mtime = fs::metadata(&lock).expect("stat").modified().expect("mtime");
        let target_mtime =
            fs::metadata(path_of(&target).join("package-lock.json")).expect("stat").modified().expect("mtime");
        assert_ne!(source_mtime, target_mtime, "the test needs the mtimes to actually differ");

        let env = no_env();
        let mut options = options(path_of(&target), &env);
        options.source = Some(path_of(&source));

        let (outcome, _) = run(&[gated], &options);

        assert!(!ran(&target), "identical bytes with different mtimes must still skip: {outcome:?}");
    }

    #[test]
    fn force_overrides_if_changed() {
        let (source, target, gated) = lockfile_case("{\"lock\":1}", "{\"lock\":1}");
        let env = no_env();
        let mut options = options(path_of(&target), &env);
        options.source = Some(path_of(&source));
        options.force = true;

        let (outcome, _) = run(&[gated], &options);

        assert!(ran(&target), "force must run it anyway: {outcome:?}");
    }

    #[test]
    fn without_a_source_every_step_runs() {
        let (_source, target, gated) = lockfile_case("{\"lock\":1}", "{\"lock\":1}");
        let env = no_env();
        // `source: None` — no baseline, so nothing can be proven unchanged.
        let options = options(path_of(&target), &env);

        let (outcome, _) = run(&[gated], &options);

        assert!(ran(&target), "{outcome:?}");
    }

    #[test]
    fn any_changed_globs_below_the_root() {
        let source = temp();
        let target = temp();
        write(&path_of(&source).join("apps/web/package.json"), "{\"v\":1}");
        write(&path_of(&target).join("apps/web/package.json"), "{\"v\":1}");
        write(&path_of(&source).join("apps/api/package.json"), "{\"v\":1}");
        write(&path_of(&target).join("apps/api/package.json"), "{\"v\":2}");
        let patterns = ["apps/*/package.json".to_owned()];

        assert!(any_changed(&patterns, path_of(&source), path_of(&target)).expect("any_changed"));

        // And with the api manifest lined up again, nothing differs.
        write(&path_of(&target).join("apps/api/package.json"), "{\"v\":1}");
        assert!(!any_changed(&patterns, path_of(&source), path_of(&target)).expect("any_changed"));
    }

    #[test]
    fn any_changed_sees_dotfiles() {
        let source = temp();
        let target = temp();
        write(&path_of(&source).join(".tool-versions"), "node 22\n");
        write(&path_of(&target).join(".tool-versions"), "node 24\n");

        assert!(any_changed(&[".tool-versions".to_owned()], path_of(&source), path_of(&target)).expect("any_changed"));
    }

    #[test]
    fn an_invalid_glob_is_an_error() {
        let source = temp();
        let target = temp();

        let error =
            any_changed(&["[unclosed".to_owned()], path_of(&source), path_of(&target)).expect_err("should fail");

        assert!(matches!(error, SetupError::BadPattern { .. }), "{error:?}");
    }

    #[test]
    fn same_content_calls_two_directories_unchanged() {
        let dir = temp();
        let left = path_of(&dir).join("left");
        let right = path_of(&dir).join("right");
        fs::create_dir_all(&left).expect("mkdir");
        fs::create_dir_all(&right).expect("mkdir");

        // Neither side holds a regular file, so there is no content to have changed.
        assert!(same_content(&left, &right).expect("same_content"));
        // And a directory against a file is a difference.
        write(&path_of(&dir).join("file"), "x");
        assert!(!same_content(&left, &path_of(&dir).join("file")).expect("same_content"));
    }

    // -----------------------------------------------------------------------------------
    // Selection
    // -----------------------------------------------------------------------------------

    #[test]
    fn only_runs_the_named_steps() {
        let dir = temp();
        let env = no_env();
        let steps = [
            named("first", "printf 'a\\n' >> order.log"),
            named("second", "printf 'b\\n' >> order.log"),
            named("third", "printf 'c\\n' >> order.log"),
        ];
        let mut options = options(path_of(&dir), &env);
        // Listed out of order on purpose: `only` selects, it does not reorder.
        options.only = Some(vec!["third".to_owned(), "first".to_owned()]);

        let (outcome, _) = run(&steps, &options);

        assert_eq!(read(&path_of(&dir).join("order.log")), "a\nc\n");
        assert_eq!(outcome.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["first", "third"]);
    }

    #[test]
    fn an_unknown_only_label_is_an_error() {
        let dir = temp();
        let env = no_env();
        let steps = [named("build", "printf 'a\\n' >> order.log")];
        let mut options = options(path_of(&dir), &env);
        options.only = Some(vec!["buidl".to_owned()]);

        let error = run_setup(&steps, &options, &mut |_, _| {}).expect_err("a typo must not be a silent no-op");

        assert!(matches!(&error, SetupError::UnknownStep(label) if label == "buidl"), "{error:?}");
        // Nothing ran.
        assert_eq!(read(&path_of(&dir).join("order.log")), "");
    }

    #[test]
    fn an_unnamed_step_is_addressed_as_step_n() {
        let dir = temp();
        let env = no_env();
        let steps = [step("printf 'a\\n' >> order.log"), step("printf 'b\\n' >> order.log")];

        let (outcome, _) = run(&steps, &options(path_of(&dir), &env));
        assert_eq!(outcome.steps.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["step 1", "step 2"]);

        // And that same spelling is what `only` accepts.
        let second = temp();
        let mut options = options(path_of(&second), &env);
        options.only = Some(vec!["step 2".to_owned()]);
        let (outcome, _) = run(&steps, &options);

        assert_eq!(read(&path_of(&second).join("order.log")), "b\n");
        assert_eq!(outcome.steps.len(), 1);
    }

    // -----------------------------------------------------------------------------------
    // Timeouts and process groups
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_step_that_finishes_inside_the_timeout_runs_normally() {
        let dir = temp();
        let env = no_env();
        let mut options = options(path_of(&dir), &env);
        options.timeout = Some(Duration::from_secs(30));

        let (outcome, lines) = run(&[step("echo quick")], &options);

        assert!(outcome.ok, "a generous timeout must not kill anything: {outcome:?}");
        assert_eq!(texts(&lines), ["quick"]);
    }

    #[test]
    fn a_timeout_kills_the_whole_process_group() {
        // Two distinctive sleeps: one backgrounded, one in the foreground. Signalling only the
        // shell would leave the backgrounded one orphaned for five minutes — the exact bug
        // process groups exist to prevent.
        let (background, foreground) = ("31041", "31042");
        reap(background);
        reap(foreground);
        assert_eq!(processes_matching(background), 0, "stale process from an earlier run");
        assert_eq!(processes_matching(foreground), 0, "stale process from an earlier run");

        let running = spawn_run(&format!("sleep {background} & sleep {foreground}"), Duration::from_millis(900));

        // Mid-run: both children must actually exist, or the "they are gone" assertion below
        // would be satisfied by a step that never started anything. Polled rather than slept on,
        // so a loaded machine gets more time instead of a spurious failure.
        let started = (0..40).any(|_| {
            std::thread::sleep(StdDuration::from_millis(25));
            processes_matching(background) >= 1 && processes_matching(foreground) >= 1
        });
        assert!(started, "the children never started");

        let outcome = running.recv_timeout(StdDuration::from_secs(10)).expect("the timeout never ended the run");
        assert!(!outcome.ok);
        assert!(
            matches!(&outcome.steps[0].result, StepResult::Failed { status, .. } if status == "timed out after 900ms"),
            "{outcome:?}"
        );

        let gone = waits_until_gone(background) && waits_until_gone(foreground);
        if !gone {
            reap(background);
            reap(foreground);
        }
        assert!(gone, "the timeout left grandchildren behind");
    }

    #[test]
    fn a_timeout_escalates_to_sigkill() {
        // The shell ignores SIGTERM and keeps looping, so only SIGKILL can end it. Without the
        // escalation this run would never finish.
        let running = spawn_run("trap '' TERM; while true; do sleep 0.05; done", Duration::from_millis(200));

        let outcome = running.recv_timeout(StdDuration::from_secs(6)).expect("SIGKILL never landed");

        assert!(!outcome.ok);
        assert!(
            matches!(&outcome.steps[0].result, StepResult::Failed { status, .. } if status == "timed out after 200ms"),
            "{outcome:?}"
        );
    }

    #[test]
    fn signal_group_refuses_pid_zero() {
        // Group 0 is *our own* group: signalling it would take down this test process and
        // whatever launched it. SIGCONT so that a regression is a failed assertion rather than a
        // dead test runner.
        assert!(!signal_group(0, Signal::SIGCONT), "pid 0 must never be signalled as a group");
        // And a pid that does not fit an i32 is not a group either.
        assert!(!signal_group(u32::MAX, Signal::SIGCONT));
    }

    #[test]
    fn signal_group_reaches_the_backgrounded_children() {
        // The `-pid` in `signal_group` is the whole feature: without it the shell dies and its
        // backgrounded child is orphaned, still holding a port or a lock.
        let token = "31044";
        reap(token);
        assert_eq!(processes_matching(token), 0, "stale process from an earlier run");
        let mut child = Command::new(SHELL)
            .arg("-c")
            .arg(format!("sleep {token} & sleep {token}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("spawn");
        let started = (0..40).any(|_| {
            std::thread::sleep(StdDuration::from_millis(25));
            processes_matching(token) >= 2
        });
        assert!(started, "the children never started");

        assert!(signal_group(child.id(), Signal::SIGKILL), "a real pid is a signallable group");

        let gone = waits_until_gone(token);
        if !gone {
            reap(token);
        }
        let _ = child.wait();
        assert!(gone, "signal_group left the backgrounded children behind");
    }

    #[rstest]
    // No budget at all: nothing to escalate.
    #[case(0, None, None, Nudge::Wait)]
    // Inside the budget.
    #[case(0, Some(1_000), None, Nudge::Wait)]
    // Exactly on the deadline counts as reached — a budget of zero must still expire.
    #[case(0, Some(0), None, Nudge::Term)]
    #[case(1_000, Some(0), None, Nudge::Term)]
    // Already asked to stop, still inside its grace: leave it alone to clean up.
    #[case(0, Some(0), Some(0), Nudge::Wait)]
    #[case(GRACE_MS / 2, Some(0), Some(0), Nudge::Wait)]
    // Grace exactly spent, and long spent.
    #[case(GRACE_MS, Some(0), Some(0), Nudge::Kill)]
    #[case(GRACE_MS * 2, Some(0), Some(0), Nudge::Kill)]
    fn nudge_escalates_at_the_deadline_then_at_the_grace(
        #[case] now_ms: u64,
        #[case] deadline_ms: Option<u64>,
        #[case] termed_ms: Option<u64>,
        #[case] expected: Nudge,
    ) {
        // One fixed origin, so every boundary above is hit to the nanosecond rather than
        // approximately, the way a real clock would.
        let base = Instant::now();
        let at = |ms: u64| base + StdDuration::from_millis(ms);
        assert_eq!(nudge(at(now_ms), deadline_ms.map(at), termed_ms.map(at)), expected);
    }

    // -----------------------------------------------------------------------------------
    // The wire shape
    // -----------------------------------------------------------------------------------

    #[test]
    fn the_outcome_serializes_with_a_tagged_result() {
        let dir = temp();
        let env = no_env();
        let steps = [named("build", "echo hi"), named("boom", "echo bad >&2; exit 2")];

        let (outcome, _) = run(&steps, &options(path_of(&dir), &env));
        let json = serde_json::to_value(&outcome).expect("serialize");

        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["steps"][0]["name"], serde_json::json!("build"));
        assert_eq!(json["steps"][0]["command"], serde_json::json!("echo hi"));
        assert_eq!(json["steps"][0]["result"]["kind"], serde_json::json!("ran"));
        assert_eq!(json["steps"][1]["result"]["kind"], serde_json::json!("failed"));
        assert_eq!(json["steps"][1]["result"]["status"], serde_json::json!("exit 2"));
        assert_eq!(json["steps"][1]["result"]["tail"], serde_json::json!(["bad"]));
        assert_eq!(serde_json::to_value(Stream::Err).expect("serialize"), serde_json::json!("err"));
        assert_eq!(serde_json::to_value(Stream::Out).expect("serialize"), serde_json::json!("out"));
    }
}
