//! Carrying the untracked half of a checkout into a new worktree.
//!
//! `git worktree add` brings tracked files only, which leaves out exactly what makes a checkout
//! runnable: the `.env` the app reads, the local certificate, the `node_modules` that costs four
//! minutes to rebuild. These rules carry that across.
//!
//! **Candidates come from git, never from a directory walk.** `git ls-files --others --ignored
//! --exclude-standard` applies the repository's real ignore rules — nested `.gitignore` files,
//! `.git/info/exclude`, the user's global excludes — which a reimplementation would get subtly
//! wrong. It also cannot name a tracked file, so no rule, however broad, can put a copy of a
//! version-controlled file on top of the one git just checked out.
//!
//! The port of the daemon's `packages/daemon/src/env/provision/{copy-files,caches}.ts`.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::time::Instant;

use camino::{Utf8Path, Utf8PathBuf};
use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Serialize;

use crate::config::{CopyRule, CopyStrategy};
use crate::git::Git;

/// An optional file in the source checkout that narrows what the rules may carry.
pub const INCLUDE_FILE: &str = ".canopyinclude";

/// Set it to `1` to force the plain-copy path even where the filesystem can clone.
pub const NO_REFLINK_ENV: &str = "CANOPYWT_NO_REFLINK";

// ---------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------

/// What happened to one path. Serialized into the `--json` envelope, so the field names are an
/// API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CopiedPath {
    /// Repo-relative, the same spelling git used.
    pub path: String,
    pub strategy: CopyStrategy,
    pub result: CopyResult,
    /// Bytes written. Zero for a symlink and for a path that was skipped, since neither moves
    /// any data.
    pub bytes: u64,
    pub millis: u64,
}

/// How a path actually landed.
///
/// [`CopyResult::Cloned`] and [`CopyResult::Copied`] are reported separately on purpose: a
/// `clone` rule that quietly degrades to a byte-for-byte copy turns a twenty-second provision
/// into a two-minute one, and without this distinction there is nothing in the output to explain
/// where the time went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CopyResult {
    /// Copy-on-write: the filesystem shared the blocks instead of moving them.
    Cloned,
    Copied,
    Symlinked,
    /// Something was already at the target. Never overwritten.
    Skipped,
    /// A dry run. Nothing was written.
    Planned,
}

/// One path that could not be carried across. The run continued without it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CopyFailure {
    pub path: String,
    pub strategy: CopyStrategy,
    /// The underlying message, verbatim — "permission denied" and "no space left on device"
    /// need different fixes.
    pub message: String,
}

/// The result of applying every rule.
///
/// A per-path failure is collected rather than propagated: one unreadable `.env` must not cost
/// the developer the `node_modules` that took a minute to clone, and a half-provisioned worktree
/// with a listed reason is far more useful than an error with nothing done.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CopyOutcome {
    pub entries: Vec<CopiedPath>,
    pub failures: Vec<CopyFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyOptions {
    /// Report the plan, write nothing.
    pub dry_run: bool,
    /// The checkout the rules are resolved against — the same path passed to [`copy_ignored`],
    /// kept here so a caller can hold a plan and its provenance together.
    pub source: Utf8PathBuf,
}

impl CopyOptions {
    pub fn new(source: impl Into<Utf8PathBuf>) -> CopyOptions {
        CopyOptions { dry_run: false, source: source.into() }
    }

    pub fn dry_run(source: impl Into<Utf8PathBuf>) -> CopyOptions {
        CopyOptions { dry_run: true, source: source.into() }
    }
}

/// Whether to try a copy-on-write clone at all.
///
/// The test seam behind `CANOPYWT_NO_REFLINK`: the fallback path is the one that turns a fast
/// provision into a slow one, and it cannot be exercised by choosing a filesystem from inside a
/// test.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reflink {
    Attempt,
    Never,
}

impl Reflink {
    /// Only the exact string `1` disables cloning. `0`, `false` and an empty value leave it on,
    /// because an env var that switches behaviour on merely *being set* is a trap.
    fn from_var(value: Option<&OsStr>) -> Reflink {
        match value {
            Some(value) if value == OsStr::new("1") => Reflink::Never,
            _ => Reflink::Attempt,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CopyError {
    #[error("could not list the ignored files in {path}: {error}")]
    Candidates {
        path: Utf8PathBuf,
        #[source]
        error: crate::error::Error,
    },

    #[error("copy pattern {pattern:?} is not a valid glob: {message}")]
    BadPattern { pattern: String, message: String },

    #[error("{path} is not a usable {INCLUDE_FILE}: {message}")]
    BadInclude { path: Utf8PathBuf, message: String },

    /// Every path in this crate ends up in JSON, so one is rejected at the edge rather than
    /// lossily converted into a name that would not round-trip back to a file.
    #[error("git reported a path that is not valid UTF-8: {0}")]
    NonUtf8Path(String),
}

// ---------------------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------------------

/// Carries every gitignored file matching `rules` from `source` into `target`.
///
/// Honours `CANOPYWT_NO_REFLINK=1`; see [`copy_ignored_with`] for the same thing with the clone
/// decision made by the caller.
pub fn copy_ignored(
    git: &Git,
    source: &Utf8Path,
    target: &Utf8Path,
    rules: &[CopyRule],
    options: &CopyOptions,
) -> Result<CopyOutcome, CopyError> {
    let reflink = Reflink::from_var(std::env::var_os(NO_REFLINK_ENV).as_deref());
    copy_ignored_with(git, source, target, rules, options, reflink)
}

/// [`copy_ignored`] with the clone decision supplied rather than read from the environment.
pub fn copy_ignored_with(
    git: &Git,
    source: &Utf8Path,
    target: &Utf8Path,
    rules: &[CopyRule],
    options: &CopyOptions,
    reflink: Reflink,
) -> Result<CopyOutcome, CopyError> {
    let mut outcome = CopyOutcome::default();
    // No rules means no work, and in particular no `git ls-files`: listing every ignored file in
    // a monorepo is not free, and a repo that configures no copy rules should not pay for it.
    if rules.is_empty() {
        return Ok(outcome);
    }
    let candidates = candidates(git, source)?;
    let include = include_filter(source)?;
    let run = Run { source, target, dry_run: options.dry_run, reflink };
    let mut handled: BTreeSet<&str> = BTreeSet::new();
    for rule in rules {
        let matcher = matcher(&rule.pattern)?;
        for candidate in &candidates {
            if !matcher.is_match(candidate) || !included(include.as_ref(), candidate) {
                continue;
            }
            // First rule to claim a path wins; a second rule naming it again must not copy it
            // twice or report it twice.
            if !handled.insert(candidate.as_str()) {
                continue;
            }
            match run.apply(candidate, rule.strategy) {
                Ok(entry) => outcome.entries.push(entry),
                Err(failure) => outcome.failures.push(failure),
            }
        }
    }
    Ok(outcome)
}

/// Every gitignored file in the checkout, repo-relative.
///
/// `--others --ignored --exclude-standard` is the one listing that means "ignored, and only
/// ignored": `--others` alone would also hand back untracked files the developer has simply not
/// added yet, which belong to the branch they are working on, not to the new worktree.
fn candidates(git: &Git, source: &Utf8Path) -> Result<Vec<String>, CopyError> {
    let stdout = git
        .run_bytes(source, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
        .map_err(|error| CopyError::Candidates { path: source.to_owned(), error })?;
    stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            String::from_utf8(entry.to_vec())
                .map_err(|_| CopyError::NonUtf8Path(String::from_utf8_lossy(entry).into_owned()))
        })
        .collect()
}

/// The `.canopyinclude` matcher, or `None` when the checkout has no such file.
fn include_filter(source: &Utf8Path) -> Result<Option<Gitignore>, CopyError> {
    let path = source.join(INCLUDE_FILE);
    if fs::symlink_metadata(&path).is_err() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new(source);
    if let Some(error) = builder.add(&path) {
        return Err(CopyError::BadInclude { path, message: error.to_string() });
    }
    match builder.build() {
        Ok(gitignore) => Ok(Some(gitignore)),
        Err(error) => Err(CopyError::BadInclude { path, message: error.to_string() }),
    }
}

/// Whether `.canopyinclude` lets this path through.
///
/// The file *narrows*: absent, everything a rule matches is carried; present, a path must also
/// be matched by a positive line in it. Gitignore syntax, so the last matching line decides and
/// `!` takes a path back out again — which is why this asks for `Match::Ignore` (a line claimed
/// it) rather than merely "some line mentioned it".
fn included(include: Option<&Gitignore>, path: &str) -> bool {
    match include {
        None => true,
        // Parents are consulted too, so a line naming a directory carries its whole subtree, the
        // way `node_modules/` does in a `.gitignore`.
        Some(gitignore) => matches!(gitignore.matched_path_or_any_parents(path, false), Match::Ignore(_)),
    }
}

/// Matches a rule's pattern and everything beneath it.
///
/// The second glob is what makes a bare `node_modules` mean the directory's contents: candidates
/// are individual files, so without it a rule naming a directory would match nothing at all.
fn matcher(pattern: &str) -> Result<GlobSet, CopyError> {
    let base = pattern.trim_end_matches('/');
    let mut builder = GlobSetBuilder::new();
    builder.add(glob(base, pattern)?);
    builder.add(glob(&format!("{base}/**"), pattern)?);
    builder.build().map_err(|error| CopyError::BadPattern { pattern: pattern.to_owned(), message: error.to_string() })
}

fn glob(spec: &str, pattern: &str) -> Result<Glob, CopyError> {
    GlobBuilder::new(spec)
        // `*` stops at a directory boundary, as it does in a shell and in the picomatch the
        // daemon uses: `*.local.json` is the top level, not every such file in the tree.
        .literal_separator(true)
        .build()
        .map_err(|error| CopyError::BadPattern { pattern: pattern.to_owned(), message: error.to_string() })
}

/// One pass's fixed context: everything `apply` needs that does not change per path.
struct Run<'a> {
    source: &'a Utf8Path,
    target: &'a Utf8Path,
    dry_run: bool,
    reflink: Reflink,
}

impl Run<'_> {
    fn apply(&self, path: &str, strategy: CopyStrategy) -> Result<CopiedPath, CopyFailure> {
        let started = Instant::now();
        let from = self.source.join(path);
        let to = self.target.join(path);
        let fail = |message: String| CopyFailure { path: path.to_owned(), strategy, message };

        // `exists()` follows the link, so a *broken* symlink at the target answers false and
        // would then be silently clobbered. `symlink_metadata` asks about the entry itself,
        // which is the only question worth asking here: anything already at that path — file,
        // directory, live link or dangling one — is the worktree's, not ours to replace.
        if fs::symlink_metadata(&to).is_ok() {
            return Ok(entry(path, strategy, CopyResult::Skipped, 0, started));
        }
        if self.dry_run {
            let bytes = size(&from).map_err(&fail)?;
            return Ok(entry(path, strategy, CopyResult::Planned, bytes, started));
        }
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|error| fail(format!("could not create {parent}: {error}")))?;
        }
        let (result, bytes) = match strategy {
            CopyStrategy::Copy => {
                let bytes = fs::copy(&from, &to).map_err(|error| fail(format!("could not copy {from}: {error}")))?;
                (CopyResult::Copied, bytes)
            }
            CopyStrategy::Clone => {
                self.clone_file(&from, &to).map_err(|error| fail(format!("could not clone {from}: {error}")))?
            }
            CopyStrategy::Symlink => {
                std::os::unix::fs::symlink(&from, &to)
                    .map_err(|error| fail(format!("could not link {to} to {from}: {error}")))?;
                (CopyResult::Symlinked, 0)
            }
        };
        Ok(entry(path, strategy, result, bytes, started))
    }

    /// A copy-on-write clone where the filesystem can (APFS `clonefile`, Linux `FICLONE`), and a
    /// plain copy where it cannot — reporting which, because the difference is the whole point
    /// of the strategy.
    fn clone_file(&self, from: &Utf8Path, to: &Utf8Path) -> std::io::Result<(CopyResult, u64)> {
        if self.reflink == Reflink::Never {
            return Ok((CopyResult::Copied, fs::copy(from, to)?));
        }
        let fallback = reflink_copy::reflink_or_copy(from, to)?;
        Ok(clone_result(fallback, fs::metadata(from)?.len()))
    }
}

/// `reflink_or_copy` answers `None` when the filesystem cloned the blocks and `Some(bytes)` when
/// it had to fall back to copying them.
fn clone_result(fallback: Option<u64>, size: u64) -> (CopyResult, u64) {
    match fallback {
        None => (CopyResult::Cloned, size),
        Some(bytes) => (CopyResult::Copied, bytes),
    }
}

fn entry(path: &str, strategy: CopyStrategy, result: CopyResult, bytes: u64, started: Instant) -> CopiedPath {
    CopiedPath {
        path: path.to_owned(),
        strategy,
        result,
        bytes,
        millis: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}

fn size(path: &Utf8Path) -> Result<u64, String> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) => Err(format!("could not read {path}: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    use tempfile::TempDir;

    use super::*;

    // -----------------------------------------------------------------------------------
    // Fixture
    // -----------------------------------------------------------------------------------

    /// A throwaway checkout and the worktree directory beside it.
    ///
    /// Every fixture `git` runs with a pinned environment for the same reason the integration
    /// fixture does: otherwise the suite passes or fails according to the developer's own global
    /// git config. The repo also pins `core.excludesFile` locally, because the `Git` under test
    /// inherits this process's environment and would otherwise consult the real user's global
    /// excludes when listing candidates.
    struct Checkout {
        _dir: TempDir,
        source: Utf8PathBuf,
        target: Utf8PathBuf,
        home: Utf8PathBuf,
    }

    impl Checkout {
        fn new() -> Checkout {
            let dir = TempDir::new().expect("temp dir");
            // Canonicalized: macOS hands out /var/folders/… which is a symlink to
            // /private/var/folders/…, and git reports the resolved path.
            let base = Utf8PathBuf::from_path_buf(dir.path().canonicalize().expect("canonicalize"))
                .expect("temp path is utf-8");
            let checkout = Checkout {
                source: base.join("source"),
                target: base.join("worktree"),
                home: base.join("home"),
                _dir: dir,
            };
            fs::create_dir_all(&checkout.source).expect("create source");
            fs::create_dir_all(&checkout.home).expect("create home");
            checkout.git(["init", "-b", "main"]);
            checkout.git(["config", "--local", "core.excludesFile", "/dev/null"]);
            checkout.write("README.md", "# fixture\n");
            checkout.git(["add", "-A"]);
            checkout.git(["commit", "-m", "initial"]);
            checkout
        }

        fn git<const N: usize>(&self, args: [&str; N]) -> String {
            let mut command = Command::new("git");
            command
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .env("HOME", self.home.as_str())
                .env("XDG_CONFIG_HOME", self.home.join(".config").as_str())
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", self.home.join("gitconfig-absent").as_str())
                .env("GIT_AUTHOR_NAME", "Fixture")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
                .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00+0000")
                .env("GIT_COMMITTER_NAME", "Fixture")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
                .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00+0000")
                .env("TZ", "UTC");
            let output = command.args(args).current_dir(&self.source).output().expect("spawn git");
            assert!(
                output.status.success(),
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).expect("git output is utf-8")
        }

        /// Writes a file in the source checkout.
        fn write(&self, path: &str, body: &str) {
            write_at(&self.source.join(path), body);
        }

        /// Writes a file that is already in the worktree, for the "never overwrite" cases.
        fn place(&self, path: &str, body: &str) {
            write_at(&self.target.join(path), body);
        }

        /// Commits the given files, making them tracked.
        fn track(&self, files: &[(&str, &str)]) {
            for (path, body) in files {
                self.write(path, body);
            }
            self.git(["add", "-A"]);
            self.git(["commit", "-m", "track"]);
        }

        /// Writes a `.gitignore` and tracks it, so its entries are the repo's ignore rules.
        fn ignore(&self, path: &str, lines: &str) {
            self.track(&[(path, lines)]);
        }

        fn run(&self, rules: &[CopyRule]) -> CopyOutcome {
            self.attempt(rules).expect("copy succeeds")
        }

        fn attempt(&self, rules: &[CopyRule]) -> Result<CopyOutcome, CopyError> {
            copy_ignored(&Git::default(), &self.source, &self.target, rules, &CopyOptions::new(&self.source))
        }

        fn plan(&self, rules: &[CopyRule]) -> CopyOutcome {
            copy_ignored(&Git::default(), &self.source, &self.target, rules, &CopyOptions::dry_run(&self.source))
                .expect("plan succeeds")
        }

        fn without_reflink(&self, rules: &[CopyRule]) -> CopyOutcome {
            copy_ignored_with(
                &Git::default(),
                &self.source,
                &self.target,
                rules,
                &CopyOptions::new(&self.source),
                Reflink::Never,
            )
            .expect("copy succeeds")
        }

        /// The content that landed in the worktree.
        fn landed(&self, path: &str) -> String {
            fs::read_to_string(self.target.join(path)).unwrap_or_else(|error| panic!("read {path}: {error}"))
        }

        fn exists(&self, path: &str) -> bool {
            fs::symlink_metadata(self.target.join(path)).is_ok()
        }
    }

    fn write_at(path: &Utf8Path, body: &str) {
        fs::create_dir_all(path.parent().expect("a parent")).expect("create parent");
        fs::write(path, body).expect("write file");
    }

    fn rule(pattern: &str) -> CopyRule {
        CopyRule { pattern: pattern.to_owned(), strategy: CopyStrategy::Copy }
    }

    fn rule_with(pattern: &str, strategy: CopyStrategy) -> CopyRule {
        CopyRule { pattern: pattern.to_owned(), strategy }
    }

    /// The paths reported, in the order they were handled.
    fn paths(outcome: &CopyOutcome) -> Vec<&str> {
        outcome.entries.iter().map(|entry| entry.path.as_str()).collect()
    }

    fn entry_for<'a>(outcome: &'a CopyOutcome, path: &str) -> &'a CopiedPath {
        outcome
            .entries
            .iter()
            .find(|entry| entry.path == path)
            .unwrap_or_else(|| panic!("no entry for {path} in {:?}", paths(outcome)))
    }

    // -----------------------------------------------------------------------------------
    // What gets carried
    // -----------------------------------------------------------------------------------

    #[test]
    fn copies_a_gitignored_dotenv() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "TOKEN=shh\n");

        let outcome = checkout.run(&[rule(".env")]);

        assert_eq!(paths(&outcome), [".env"]);
        assert_eq!(entry_for(&outcome, ".env").result, CopyResult::Copied);
        assert_eq!(checkout.landed(".env"), "TOKEN=shh\n");
        assert_eq!(outcome.failures, []);
    }

    #[test]
    fn never_copies_a_tracked_file() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        // Both end in `.env` and both match the rule; only the ignored one is a candidate.
        checkout.track(&[("committed.env", "TRACKED=1\n")]);
        checkout.write(".env", "IGNORED=1\n");

        let outcome = checkout.run(&[rule("*.env"), rule(".env")]);

        assert_eq!(paths(&outcome), [".env"], "a tracked file is never a candidate");
        assert!(!checkout.exists("committed.env"));
        assert_eq!(checkout.landed(".env"), "IGNORED=1\n");
    }

    #[test]
    fn an_untracked_but_unignored_file_is_not_a_candidate() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "IGNORED=1\n");
        // Untracked, but nothing ignores it: it belongs to the branch being worked on.
        checkout.write("scratch.env", "NEW=1\n");

        let outcome = checkout.run(&[rule("*.env")]);

        assert_eq!(paths(&outcome), [".env"]);
        assert!(!checkout.exists("scratch.env"));
    }

    #[test]
    fn nested_gitignore_is_honoured() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "# nothing at the root\n");
        // Only `app/.gitignore` knows about this file. Asking git rather than reading the root
        // `.gitignore` ourselves is what makes it a candidate.
        checkout.ignore("app/.gitignore", ".env.local\n");
        checkout.write("app/.env.local", "LOCAL=1\n");
        checkout.write("app/notes.txt", "not ignored\n");

        let outcome = checkout.run(&[rule("app/*")]);

        assert_eq!(paths(&outcome), ["app/.env.local"]);
        assert_eq!(checkout.landed("app/.env.local"), "LOCAL=1\n");
        assert!(!checkout.exists("app/notes.txt"));
        assert!(!checkout.exists("app/.gitignore"), "the tracked .gitignore is git's to place");
    }

    #[test]
    fn no_rules_is_a_no_op() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "TOKEN=shh\n");

        // A git that cannot be spawned proves the listing never happened.
        let outcome = copy_ignored_with(
            &Git::new("/nonexistent/git"),
            &checkout.source,
            &checkout.target,
            &[],
            &CopyOptions::new(&checkout.source),
            Reflink::Attempt,
        )
        .expect("no rules cannot fail");

        assert_eq!(outcome, CopyOutcome::default());
        assert!(!checkout.exists(".env"));
    }

    // -----------------------------------------------------------------------------------
    // Patterns
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_bare_directory_pattern_matches_everything_under_it() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "node_modules/\nnode_modules_backup/\n");
        checkout.write("node_modules/pkg/index.js", "one\n");
        checkout.write("node_modules/pkg/deep/two.js", "two\n");
        // A sibling with the pattern as a prefix: matching must respect the boundary.
        checkout.write("node_modules_backup/old.js", "old\n");

        let outcome = checkout.run(&[rule("node_modules")]);

        assert_eq!(paths(&outcome), ["node_modules/pkg/deep/two.js", "node_modules/pkg/index.js"]);
        assert_eq!(checkout.landed("node_modules/pkg/index.js"), "one\n");
        assert_eq!(checkout.landed("node_modules/pkg/deep/two.js"), "two\n");
        assert!(!checkout.exists("node_modules_backup/old.js"));
    }

    #[test]
    fn a_trailing_slash_in_a_pattern_means_the_same_directory() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "cache/\n");
        checkout.write("cache/a.bin", "a\n");

        let outcome = checkout.run(&[rule("cache/")]);

        assert_eq!(paths(&outcome), ["cache/a.bin"]);
    }

    #[test]
    fn a_star_does_not_cross_a_directory_boundary() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "*.env\n");
        checkout.write("top.env", "top\n");
        checkout.write("app/deep.env", "deep\n");

        let outcome = checkout.run(&[rule("*.env")]);

        assert_eq!(paths(&outcome), ["top.env"], "`*` is one path component, as in a shell");
        assert!(!checkout.exists("app/deep.env"));
    }

    #[test]
    fn a_pattern_matching_nothing_is_not_a_failure() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "TOKEN=shh\n");

        let outcome = checkout.run(&[rule("absent.json"), rule(".env")]);

        assert_eq!(paths(&outcome), [".env"]);
        assert_eq!(outcome.failures, []);
    }

    #[test]
    fn each_file_is_handled_once_even_when_two_rules_match_it() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "TOKEN=shh\n");

        // The second rule would symlink it; the first rule already claimed it.
        let outcome = checkout.run(&[rule(".env"), rule_with("*", CopyStrategy::Symlink)]);

        assert_eq!(paths(&outcome), [".env"]);
        assert_eq!(entry_for(&outcome, ".env").result, CopyResult::Copied);
        assert!(!fs::symlink_metadata(checkout.target.join(".env")).expect("landed").is_symlink());
    }

    #[test]
    fn a_bad_pattern_is_an_error() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "TOKEN=shh\n");

        let error = checkout.attempt(&[rule("[")]).expect_err("an unclosed class is not a glob");

        match error {
            CopyError::BadPattern { pattern, .. } => assert_eq!(pattern, "["),
            other => panic!("expected BadPattern, got {other:?}"),
        }
        assert!(!checkout.exists(".env"), "nothing is carried when a rule cannot be understood");
    }

    #[test]
    fn a_git_that_cannot_list_the_checkout_is_an_error() {
        let checkout = Checkout::new();

        let error = copy_ignored(
            &Git::new("/nonexistent/git"),
            &checkout.source,
            &checkout.target,
            &[rule(".env")],
            &CopyOptions::new(&checkout.source),
        )
        .expect_err("the candidate listing is not optional");

        assert!(matches!(error, CopyError::Candidates { .. }), "got {error:?}");
    }

    // -----------------------------------------------------------------------------------
    // Never overwriting
    // -----------------------------------------------------------------------------------

    #[test]
    fn never_overwrites_an_existing_file() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "SOURCE=1\n");
        checkout.place(".env", "WORKTREE=1\n");

        let outcome = checkout.run(&[rule(".env")]);

        assert_eq!(entry_for(&outcome, ".env").result, CopyResult::Skipped);
        assert_eq!(entry_for(&outcome, ".env").bytes, 0);
        assert_eq!(checkout.landed(".env"), "WORKTREE=1\n", "the worktree's own file wins");
    }

    #[test]
    fn never_overwrites_an_existing_symlink_including_a_broken_one() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "*.env\n");
        checkout.write("broken.env", "SOURCE=1\n");
        checkout.write("live.env", "SOURCE=2\n");
        checkout.place("elsewhere.env", "ELSEWHERE=1\n");

        // `exists()` answers false for a dangling link, which would make a naive check clobber
        // whatever the developer deliberately pointed at a not-yet-created file.
        std::os::unix::fs::symlink(checkout.target.join("gone.env"), checkout.target.join("broken.env"))
            .expect("dangling symlink");
        std::os::unix::fs::symlink(checkout.target.join("elsewhere.env"), checkout.target.join("live.env"))
            .expect("live symlink");

        let outcome = checkout.run(&[rule("*.env")]);

        assert_eq!(entry_for(&outcome, "broken.env").result, CopyResult::Skipped);
        assert_eq!(entry_for(&outcome, "live.env").result, CopyResult::Skipped);
        let broken = fs::symlink_metadata(checkout.target.join("broken.env")).expect("still there");
        assert!(broken.is_symlink(), "the dangling link is still a link");
        assert!(fs::read_to_string(checkout.target.join("broken.env")).is_err(), "still dangling");
        assert_eq!(checkout.landed("live.env"), "ELSEWHERE=1\n", "the live link still points where it did");
    }

    // -----------------------------------------------------------------------------------
    // Strategies
    // -----------------------------------------------------------------------------------

    #[test]
    fn symlink_strategy_creates_a_link_not_a_copy() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "node_modules/\n");
        checkout.write("node_modules/pkg/index.js", "shared\n");

        let outcome = checkout.run(&[rule_with("node_modules", CopyStrategy::Symlink)]);

        let landed = checkout.target.join("node_modules/pkg/index.js");
        assert_eq!(entry_for(&outcome, "node_modules/pkg/index.js").result, CopyResult::Symlinked);
        assert!(fs::symlink_metadata(&landed).expect("landed").is_symlink());
        assert_eq!(
            fs::read_link(&landed).expect("readlink"),
            checkout.source.join("node_modules/pkg/index.js").as_std_path()
        );
        assert_eq!(checkout.landed("node_modules/pkg/index.js"), "shared\n", "it reads through to the source");
        // A link moves no bytes, and saying it copied some would be a lie in the report.
        assert_eq!(entry_for(&outcome, "node_modules/pkg/index.js").bytes, 0);
    }

    #[test]
    fn clone_strategy_falls_back_to_copy_and_says_so() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "target/\n");
        checkout.write("target/debug/app", "binary\n");

        let outcome = checkout.without_reflink(&[rule_with("target", CopyStrategy::Clone)]);

        let entry = entry_for(&outcome, "target/debug/app");
        assert_eq!(entry.result, CopyResult::Copied, "a degraded clone must not report itself as cloned");
        assert_eq!(entry.bytes, "binary\n".len() as u64);
        assert_eq!(checkout.landed("target/debug/app"), "binary\n");
    }

    #[test]
    fn clone_strategy_clones_or_copies_and_reports_which() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "target/\n");
        checkout.write("target/debug/app", "binary\n");

        let outcome = checkout.run(&[rule_with("target", CopyStrategy::Clone)]);

        let entry = entry_for(&outcome, "target/debug/app");
        // Which one it is depends on the filesystem the tests run on; either is correct, and the
        // content and the byte count are not.
        assert!(matches!(entry.result, CopyResult::Cloned | CopyResult::Copied), "got {:?}", entry.result);
        assert_eq!(entry.bytes, "binary\n".len() as u64);
        assert_eq!(checkout.landed("target/debug/app"), "binary\n");
    }

    #[test]
    fn a_clone_reports_whether_the_filesystem_did_the_work() {
        assert_eq!(clone_result(None, 4096), (CopyResult::Cloned, 4096));
        assert_eq!(clone_result(Some(120), 4096), (CopyResult::Copied, 120));
    }

    #[test]
    fn the_no_reflink_variable_is_honoured_only_when_it_is_exactly_one() {
        assert_eq!(Reflink::from_var(Some(OsStr::new("1"))), Reflink::Never);
        assert_eq!(Reflink::from_var(None), Reflink::Attempt);
        assert_eq!(Reflink::from_var(Some(OsStr::new("0"))), Reflink::Attempt);
        assert_eq!(Reflink::from_var(Some(OsStr::new(""))), Reflink::Attempt);
        assert_eq!(Reflink::from_var(Some(OsStr::new("true"))), Reflink::Attempt);
    }

    // -----------------------------------------------------------------------------------
    // Failures and reporting
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_failing_file_does_not_abort_the_rest() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "*.env\n");
        checkout.write("a.env", "A=1\n");
        checkout.write("b.env", "B=1\n");
        checkout.write("c.env", "C=1\n");
        fs::set_permissions(checkout.source.join("b.env").as_std_path(), fs::Permissions::from_mode(0o000))
            .expect("chmod");

        let outcome = checkout.run(&[rule("*.env")]);

        assert_eq!(paths(&outcome), ["a.env", "c.env"], "the readable files still land");
        assert_eq!(checkout.landed("a.env"), "A=1\n");
        assert_eq!(checkout.landed("c.env"), "C=1\n");
        assert_eq!(outcome.failures.len(), 1, "got {:?}", outcome.failures);
        assert_eq!(outcome.failures[0].path, "b.env");
        assert_eq!(outcome.failures[0].strategy, CopyStrategy::Copy);
        assert!(outcome.failures[0].message.contains("b.env"), "got {:?}", outcome.failures[0].message);
        assert!(!checkout.exists("b.env"), "a failed copy leaves nothing behind");
    }

    #[test]
    fn reports_bytes_and_a_result_per_path() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "*.env\nlib/\n");
        checkout.write("small.env", "A=1\n");
        checkout.write("lib/big.bin", &"x".repeat(5000));

        let outcome = checkout.run(&[rule("*.env"), rule_with("lib", CopyStrategy::Symlink)]);

        assert_eq!(
            outcome.entries,
            vec![
                CopiedPath {
                    path: "small.env".to_owned(),
                    strategy: CopyStrategy::Copy,
                    result: CopyResult::Copied,
                    bytes: 4,
                    millis: outcome.entries[0].millis,
                },
                CopiedPath {
                    path: "lib/big.bin".to_owned(),
                    strategy: CopyStrategy::Symlink,
                    result: CopyResult::Symlinked,
                    bytes: 0,
                    millis: outcome.entries[1].millis,
                },
            ]
        );
        assert_eq!(
            serde_json::to_value(entry_for(&outcome, "small.env")).expect("serializes")["result"],
            serde_json::json!("copied")
        );
    }

    #[test]
    fn copying_into_a_target_that_does_not_exist_creates_parent_directories() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "deep/\n");
        checkout.write("deep/nested/.env", "DEEP=1\n");
        assert!(!checkout.target.exists(), "the worktree directory is not there yet");

        let outcome = checkout.run(&[rule("deep")]);

        assert_eq!(entry_for(&outcome, "deep/nested/.env").result, CopyResult::Copied);
        assert_eq!(checkout.landed("deep/nested/.env"), "DEEP=1\n");
    }

    #[test]
    fn dry_run_writes_nothing_but_reports_the_plan() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", "*.env\n");
        checkout.write("a.env", "A=1\n");
        checkout.write("b.env", "BB=22\n");

        let outcome = checkout.plan(&[rule("*.env")]);

        assert_eq!(paths(&outcome), ["a.env", "b.env"]);
        assert_eq!(entry_for(&outcome, "a.env").result, CopyResult::Planned);
        assert_eq!(entry_for(&outcome, "a.env").bytes, 4, "the plan says what it would move");
        assert_eq!(entry_for(&outcome, "b.env").bytes, 6);
        assert!(!checkout.target.exists(), "a dry run does not even create the directory");
    }

    #[test]
    fn a_dry_run_still_reports_what_it_would_skip() {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env\n");
        checkout.write(".env", "SOURCE=1\n");
        checkout.place(".env", "WORKTREE=1\n");

        let outcome = checkout.plan(&[rule(".env")]);

        assert_eq!(entry_for(&outcome, ".env").result, CopyResult::Skipped, "the plan is honest about the no-op");
        assert_eq!(checkout.landed(".env"), "WORKTREE=1\n");
    }

    // -----------------------------------------------------------------------------------
    // .canopyinclude
    // -----------------------------------------------------------------------------------

    /// Four ignored files, one of them nested, for the narrowing cases.
    fn narrowable() -> Checkout {
        let checkout = Checkout::new();
        checkout.ignore(".gitignore", ".env*\nconfig/\n*.log\n");
        checkout.write(".env", "A=1\n");
        checkout.write(".env.secret", "S=1\n");
        checkout.write("config/local.json", "{}\n");
        checkout.write("debug.log", "noise\n");
        checkout
    }

    #[test]
    fn canopyinclude_narrows_the_set() {
        let checkout = narrowable();
        checkout.write(
            INCLUDE_FILE,
            // Gitignore syntax: a later line wins, so the negation takes `.env.secret` back out.
            "# what a worktree may inherit\n.env*\n!.env.secret\nconfig/\n",
        );

        let outcome = checkout.run(&[rule("**")]);

        assert_eq!(paths(&outcome), [".env", "config/local.json"]);
        assert!(!checkout.exists(".env.secret"), "the negation wins over the earlier line");
        assert!(!checkout.exists("debug.log"), "nothing mentions it, so it stays behind");
        assert!(!checkout.exists(INCLUDE_FILE), "the include file is not itself listed");
    }

    #[test]
    fn canopyinclude_ordering_decides_a_conflict() {
        let checkout = narrowable();
        // The same two lines the other way round: now nothing takes `.env.secret` back out.
        checkout.write(INCLUDE_FILE, "!.env.secret\n.env*\n");

        let outcome = checkout.run(&[rule("**")]);

        assert_eq!(paths(&outcome), [".env", ".env.secret"]);
    }

    #[test]
    fn canopyinclude_absent_means_no_narrowing() {
        let checkout = narrowable();

        let outcome = checkout.run(&[rule("**")]);

        assert_eq!(paths(&outcome), [".env", ".env.secret", "config/local.json", "debug.log"]);
    }

    #[test]
    fn an_empty_canopyinclude_carries_nothing() {
        let checkout = narrowable();
        checkout.write(INCLUDE_FILE, "# deliberately nothing\n");

        let outcome = checkout.run(&[rule("**")]);

        assert_eq!(paths(&outcome), [] as [&str; 0], "present and matching nothing means nothing");
        assert_eq!(outcome.failures, []);
    }

    #[test]
    fn an_unreadable_canopyinclude_is_an_error() {
        let checkout = narrowable();
        checkout.write(INCLUDE_FILE, ".env*\n");
        fs::set_permissions(checkout.source.join(INCLUDE_FILE).as_std_path(), fs::Permissions::from_mode(0o000))
            .expect("chmod");

        let error = checkout.attempt(&[rule("**")]).expect_err("a narrowing we cannot read is not a narrowing");

        match error {
            CopyError::BadInclude { path, .. } => assert_eq!(path, checkout.source.join(INCLUDE_FILE)),
            other => panic!("expected BadInclude, got {other:?}"),
        }
        assert!(!checkout.exists(".env"), "nothing is carried when the narrowing is unreadable");
    }
}
