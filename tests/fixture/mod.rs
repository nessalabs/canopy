//! A throwaway git repository per test.
//!
//! Every `git` and `canopywt` invocation runs with a pinned environment. Without it the suite
//! passes or fails according to the developer's own git config — a global `commit.gpgsign`, an
//! `init.defaultBranch=master`, a `core.hooksPath` pointing at someone's dotfiles — and the
//! failure only reproduces on their machine.

#![allow(dead_code)]

use std::process::Command;

use assert_cmd::cargo::CommandCargoExt;
use camino::{Utf8Path, Utf8PathBuf};
use tempfile::TempDir;

pub struct Fixture {
    /// Kept alive so the directory outlives the test; dropping it deletes the repo.
    _dir: TempDir,
    pub root: Utf8PathBuf,
    /// Stands in for $HOME, so nothing reads or writes the real one.
    pub home: Utf8PathBuf,
}

impl Fixture {
    /// An initialised repo on `main` with one commit.
    pub fn new() -> Fixture {
        let fixture = Fixture::empty();
        fixture.commit(&[("README.md", "# fixture\n")], "initial");
        fixture
    }

    /// An initialised repo with no commits — for testing the unborn-HEAD edges.
    pub fn empty() -> Fixture {
        let dir = TempDir::new().expect("temp dir");
        // Canonicalized because macOS hands out /var/folders/... which is a symlink to
        // /private/var/folders/...; git reports the resolved path and the comparisons would
        // fail against the unresolved one.
        let base =
            Utf8PathBuf::from_path_buf(dir.path().canonicalize().expect("canonicalize")).expect("temp path is utf-8");
        let root = base.join("repo");
        let home = base.join("home");
        std::fs::create_dir_all(&root).expect("create repo dir");
        std::fs::create_dir_all(&home).expect("create home dir");
        let fixture = Fixture { _dir: dir, root, home };
        fixture.git(["init", "-b", "main"]);
        fixture
    }

    /// Runs git in the repo and returns stdout; panics with git's stderr on failure, because a
    /// broken fixture should fail loudly rather than produce a confusing assertion later.
    pub fn git<const N: usize>(&self, args: [&str; N]) -> String {
        self.git_in(&self.root, args)
    }

    pub fn git_in<const N: usize>(&self, cwd: &Utf8Path, args: [&str; N]) -> String {
        let mut command = Command::new("git");
        self.pin(&mut command);
        let output = command.args(args).current_dir(cwd).output().expect("spawn git");
        assert!(output.status.success(), "git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).expect("git output is utf-8")
    }

    /// Writes files and commits them.
    pub fn commit(&self, files: &[(&str, &str)], message: &str) -> String {
        for (path, body) in files {
            self.write(path, body);
        }
        self.git(["add", "-A"]);
        self.git(["commit", "-m", message]);
        self.git(["rev-parse", "HEAD"]).trim().to_owned()
    }

    pub fn write(&self, rel: &str, body: &str) {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(&path, body).expect("write file");
    }

    pub fn branch(&self, name: &str) {
        self.git(["branch", name]);
    }

    /// `canopywt`, pointed at the fixture repo, with the same pinned environment.
    pub fn cwt(&self) -> Command {
        let mut command = Command::cargo_bin("canopywt").expect("canopywt binary is built");
        self.pin(&mut command);
        command.current_dir(&self.root);
        command
    }

    /// `canopywt` run from somewhere other than the repo root.
    pub fn cwt_in(&self, cwd: &Utf8Path) -> Command {
        let mut command = self.cwt();
        command.current_dir(cwd);
        command
    }

    fn pin(&self, command: &mut Command) {
        command
            .env_clear()
            // PATH must survive env_clear or nothing can spawn git at all.
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home.as_str())
            .env("XDG_CONFIG_HOME", self.home.join(".config").as_str())
            // Belt and braces with HOME: these two make git ignore user and system config
            // outright, whatever the platform's defaults are.
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join("gitconfig-absent").as_str())
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00+0000")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00+0000")
            .env("TZ", "UTC");
    }
}

/// Parses a `--json` envelope, asserting it is well-formed and successful.
pub fn ok_envelope(stdout: &[u8]) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_slice(stdout).expect("stdout is one JSON object");
    assert_eq!(value["v"], 1, "envelope version");
    assert_eq!(value["ok"], true, "expected ok envelope, got: {value}");
    value
}

/// Parses a `--json` envelope, asserting it is well-formed and reports the given code.
pub fn err_envelope(stdout: &[u8], code: &str) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_slice(stdout).expect("stdout is one JSON object");
    assert_eq!(value["v"], 1, "envelope version");
    assert_eq!(value["ok"], false, "expected error envelope, got: {value}");
    assert_eq!(value["error"]["code"], code, "error code");
    value
}
