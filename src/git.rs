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
}

impl Default for Git {
    fn default() -> Self {
        // Respect an explicit override so tests and exotic installs can point at a specific
        // git, but never search anything but PATH.
        Git { bin: std::env::var("CANOPYWT_GIT").unwrap_or_else(|_| "git".to_owned()) }
    }
}

impl Git {
    pub fn new(bin: impl Into<String>) -> Self {
        Git { bin: bin.into() }
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
