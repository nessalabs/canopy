//! The git subprocess layer.
//!
//! We shell out rather than link `gix`/`git2` on purpose: only a real `git` invocation fires
//! the user's hooks, honours `core.hooksPath`, clean/smudge filters, credential helpers and
//! `include`d config. An in-process implementation would silently behave differently from the
//! `git worktree add` the developer would have typed.

use std::ffi::OsStr;
use std::process::{Command, Output, Stdio};

use camino::Utf8Path;

use crate::error::{Error, Result};

/// Runs `git` with a fixed environment. Cheap to clone; holds only the binary name.
#[derive(Debug, Clone)]
pub struct Git {
    bin: String,
    /// Extra variables for the child. The process's own environment cannot be changed —
    /// `set_var` is unsafe in edition 2024 and this crate forbids unsafe — so anything a
    /// spawned git (or a hook it runs) must see is carried here.
    env: Vec<(String, String)>,
}

impl Default for Git {
    fn default() -> Self {
        // Respect an explicit override so tests and exotic installs can point at a specific
        // git, but never search anything but PATH.
        Git { bin: std::env::var("CANOPYWT_GIT").unwrap_or_else(|_| "git".to_owned()), env: Vec::new() }
    }
}

impl Git {
    pub fn new(bin: impl Into<String>) -> Self {
        Git { bin: bin.into(), env: Vec::new() }
    }

    /// A copy that also sets `key` for every git it runs, and so for every hook that git runs.
    pub fn with_env(&self, key: impl Into<String>, value: impl Into<String>) -> Git {
        let mut next = self.clone();
        next.env.push((key.into(), value.into()));
        next
    }

    /// Runs git and returns stdout, or [`Error::GitFailed`] carrying git's own stderr.
    ///
    /// Translating git's message would lose information the user needs ("fatal: a branch named
    /// 'x' already exists"), so it is passed through verbatim in `details.stderr`.
    pub fn run<I, S>(&self, cwd: &Utf8Path, args: I) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.output(cwd, args)?;
        if output.status.success() {
            return String::from_utf8(output.stdout).map_err(|e| Error::NonUtf8Path(e.to_string()));
        }
        Err(Error::GitFailed {
            args: output.args,
            status: match output.status.code() {
                Some(code) => format!("exit code {code}"),
                None => "a signal".to_owned(),
            },
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }

    /// Like [`Git::run`] but hands back the raw bytes — `-z` output is NUL-delimited and may
    /// contain paths we want to validate as UTF-8 ourselves, one at a time.
    pub fn run_bytes<I, S>(&self, cwd: &Utf8Path, args: I) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.output(cwd, args)?;
        if output.status.success() {
            return Ok(output.stdout);
        }
        Err(Error::GitFailed {
            args: output.args,
            status: match output.status.code() {
                Some(code) => format!("exit code {code}"),
                None => "a signal".to_owned(),
            },
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }

    /// Whether the command succeeded. For questions git answers with an exit code
    /// (`merge-base --is-ancestor`), where a non-zero status is the answer, not an error.
    pub fn succeeds<I, S>(&self, cwd: &Utf8Path, args: I) -> bool
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.output(cwd, args).map(|o| o.status.success()).unwrap_or(false)
    }

    fn output<I, S>(&self, cwd: &Utf8Path, args: I) -> Result<GitOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<String> = args.into_iter().map(|a| a.as_ref().to_string_lossy().into_owned()).collect();
        let mut command = Command::new(&self.bin);
        command
            .args(&args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Porcelain parsing must not be reshaped by the user's config or locale.
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        for (key, value) in &self.env {
            command.env(key, value);
        }
        let Output { status, stdout, stderr } = command.output()?;
        Ok(GitOutput { args: args.join(" "), status, stdout, stderr })
    }
}

struct GitOutput {
    args: String,
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory that certainly exists, for commands that do not care where they run.
    fn anywhere() -> &'static Utf8Path {
        Utf8Path::new("/")
    }

    #[test]
    fn succeeds_reports_the_exit_status_as_the_answer() {
        // For questions git answers with a status (`merge-base --is-ancestor`), a non-zero
        // exit is the answer "no", not a failure to ask.
        assert!(Git::new("/usr/bin/true").succeeds(anywhere(), ["ignored"]));
        assert!(!Git::new("/usr/bin/false").succeeds(anywhere(), ["ignored"]));
    }

    #[test]
    fn succeeds_is_false_when_the_binary_cannot_be_spawned() {
        // "I could not ask" and "the answer is no" collapse to the same thing here, because
        // every caller of `succeeds` is asking an optional question.
        assert!(!Git::new("/nonexistent/git").succeeds(anywhere(), ["ignored"]));
    }

    #[test]
    fn a_failing_git_becomes_an_error_carrying_its_stderr() {
        let error = Git::new("/usr/bin/false").run(anywhere(), ["rev-parse"]).unwrap_err();
        match error {
            Error::GitFailed { args, status, .. } => {
                assert_eq!(args, "rev-parse");
                assert_eq!(status, "exit code 1");
            }
            other => panic!("expected GitFailed, got {other:?}"),
        }
    }

    #[test]
    fn run_bytes_reports_a_failure_the_same_way_run_does() {
        // The two entry points duplicate their error construction; if they drift, a caller
        // gets a different shape depending on which one it happened to call.
        let error = Git::new("/usr/bin/false").run_bytes(anywhere(), ["worktree", "list"]).unwrap_err();
        match error {
            Error::GitFailed { args, status, .. } => {
                assert_eq!(args, "worktree list");
                assert_eq!(status, "exit code 1");
            }
            other => panic!("expected GitFailed, got {other:?}"),
        }
    }

    #[test]
    fn a_command_killed_by_a_signal_says_so_rather_than_claiming_an_exit_code() {
        // There is no exit code to report, and inventing one (0? 255?) would be a lie a
        // caller might act on.
        let error = Git::new("/bin/sh").run(anywhere(), ["-c", "kill -TERM $$"]).unwrap_err();
        match error {
            Error::GitFailed { status, .. } => assert_eq!(status, "a signal"),
            other => panic!("expected GitFailed, got {other:?}"),
        }
    }

    #[test]
    fn non_utf8_output_is_an_error_rather_than_a_lossy_string() {
        // Every path this crate reads from git ends up in JSON. Replacing the bad bytes with
        // U+FFFD would produce a path that looks fine and does not exist.
        let error = Git::new("/bin/sh").run(anywhere(), ["-c", "printf '\\377\\376'"]).unwrap_err();
        assert!(matches!(error, Error::NonUtf8Path(_)), "got {error:?}");
    }

    #[test]
    fn run_bytes_hands_back_exactly_what_git_wrote() {
        // The `-z` formats are NUL-delimited and may carry bytes that are not UTF-8 until each
        // field is validated on its own, so this entry point must not touch them.
        let raw = Git::new("/bin/sh").run_bytes(anywhere(), ["-c", "printf 'a\\0b\\0'"]).unwrap();
        assert_eq!(raw, b"a\0b\0");
    }

    #[test]
    fn output_is_not_reshaped_by_the_users_locale() {
        // Porcelain parsing depends on git's C-locale wording; inheriting a translated locale
        // would break it in a way that only reproduces on one machine.
        let out = Git::new("/bin/sh").run(anywhere(), ["-c", "printf %s \"$LC_ALL\""]).unwrap();
        assert_eq!(out, "C");
    }

    #[test]
    fn run_bytes_reports_a_signal_the_same_way_run_does() {
        // Both entry points build their own error; if they drift, which one you called decides
        // whether a killed git looks like an exit code.
        let error = Git::new("/bin/sh").run_bytes(anywhere(), ["-c", "kill -TERM $$"]).unwrap_err();
        match error {
            Error::GitFailed { status, .. } => assert_eq!(status, "a signal"),
            other => panic!("expected GitFailed, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_git_is_an_io_error_not_a_git_failure() {
        // Worth distinguishing: "git is not installed" and "git said no" need different fixes.
        let error = Git::new("/nonexistent/git").run(anywhere(), ["status"]).unwrap_err();
        assert!(matches!(error, Error::Io(_)), "got {error:?}");
    }
}
