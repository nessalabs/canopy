//! `canopy-worktree` — git worktree dev environments driven by `canopy.yaml`.
//!
//! One crate, two faces: a library other Rust programs embed, and the `canopywt` binary. The
//! binary is a printf over the library — every subcommand calls exactly one method here and
//! serializes the result — so the `--json` contract cannot drift from the API.
//!
//! Two invariants hold everywhere:
//!
//! - **`git worktree list` is the registry.** Persisted state covers only what git cannot know:
//!   which processes we started, and which ports are taken.
//! - **Progress goes to stderr, results to stdout.** A caller can pipe stdout into `jq` while a
//!   human watches the same command work.

#![cfg(unix)]
#![forbid(unsafe_code)]

pub mod config;
pub mod error;
pub mod git;
pub mod repo;
pub mod wire;

use camino::{Utf8Path, Utf8PathBuf};
use serde::Serialize;

pub use config::{CanopyConfig, ConfigSource, Diagnostic, LocatedConfig, Parsed, Severity, parse_str};
pub use error::{Error, ErrorCode, Result};
pub use repo::{WorktreeEntry, parse_worktree_list};
pub use wire::{ENVELOPE_VERSION, Envelope};

use git::Git;
use repo::Repo;

/// The entry point for everything. Cheap to construct: discovery is one `git rev-parse`,
/// and the config is read lazily so `list` costs nothing extra in a repo that has none.
pub struct Canopy {
    repo: Repo,
    config: std::cell::OnceCell<Option<(LocatedConfig, Parsed)>>,
}

impl Canopy {
    /// Opens the repository containing `cwd`.
    pub fn open(cwd: &Utf8Path) -> Result<Canopy> {
        Canopy::open_with(cwd, Git::default())
    }

    /// Opens with an explicit git binary — the seam tests use to pin behaviour.
    pub fn open_with(cwd: &Utf8Path, git: Git) -> Result<Canopy> {
        Ok(Canopy { repo: Repo::discover(git, cwd)?, config: std::cell::OnceCell::new() })
    }

    /// The `canopy.yaml` in effect, parsed and linted, with the path it came from.
    ///
    /// `None` means no config exists anywhere in the search path — a normal state for a repo
    /// nobody has configured yet, not an error.
    pub fn config(&self) -> Option<&(LocatedConfig, Parsed)> {
        self.config
            .get_or_init(|| {
                let root = self.repo.root.as_deref()?;
                let main = self.repo.worktrees().ok().and_then(|list| list.first().map(|e| e.path.clone()));
                let located = config::locate(root, main.as_deref(), &self.repo.name())?;
                let parsed = config::load::load_file(&located.path).ok()?;
                Some((located, parsed))
            })
            .as_ref()
    }

    pub fn repo(&self) -> &Repo {
        &self.repo
    }

    /// What this repository is and where its pieces live.
    pub fn info(&self) -> Result<RepoInfo> {
        Ok(RepoInfo {
            name: self.repo.name(),
            root: self.repo.root.clone(),
            common_dir: self.repo.common_dir.clone(),
            git_dir: self.repo.git_dir.clone(),
            bare: self.repo.is_bare(),
            worktrees: self.repo.worktrees()?.len(),
        })
    }

    /// Every worktree git knows about.
    pub fn list(&self) -> Result<Vec<WorktreeEntry>> {
        self.repo.worktrees()
    }
}

/// `canopywt info`.
#[derive(Debug, Clone, Serialize)]
pub struct RepoInfo {
    /// Stable repository name — the common dir's parent.
    pub name: String,
    /// The checkout we were invoked from; absent for a bare repo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<Utf8PathBuf>,
    /// Identifies the repository from any worktree.
    pub common_dir: Utf8PathBuf,
    pub git_dir: Utf8PathBuf,
    pub bare: bool,
    pub worktrees: usize,
}
