//! Errors carry a stable machine code, because the `--json` envelope is an API.
//!
//! A consumer (canopyd, an agent, a shell script) branches on `error.code`, never on the
//! message text. Adding a variant therefore means adding a code string, and the
//! `error_codes_are_exhaustive` test fails to compile until you do.

use std::fmt;

use camino::Utf8PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

/// The stable half of an error. Serialized as the `error.code` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    NotARepository,
    GitFailed,
    ConfigInvalid,
    ConfigNotFound,
    BranchNotFound,
    WorktreeExists,
    WorktreeNotFound,
    WorktreeDirty,
    WorktreeCreateFailed,
    WorktreeRemoveFailed,
    PortInUse,
    ServiceFailed,
    Locked,
    Io,
}

impl ErrorCode {
    /// The wire string. Exhaustive by construction: a new variant will not compile without a case.
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotARepository => "not_a_repository",
            ErrorCode::GitFailed => "git_failed",
            ErrorCode::ConfigInvalid => "config_invalid",
            ErrorCode::ConfigNotFound => "config_not_found",
            ErrorCode::BranchNotFound => "branch_not_found",
            ErrorCode::WorktreeExists => "worktree_exists",
            ErrorCode::WorktreeNotFound => "worktree_not_found",
            ErrorCode::WorktreeDirty => "worktree_dirty",
            ErrorCode::WorktreeCreateFailed => "worktree_create_failed",
            ErrorCode::WorktreeRemoveFailed => "worktree_remove_failed",
            ErrorCode::PortInUse => "port_in_use",
            ErrorCode::ServiceFailed => "service_failed",
            ErrorCode::Locked => "locked",
            ErrorCode::Io => "io",
        }
    }

    /// Process exit status. `3` is reserved for lock contention so a caller can retry it
    /// without parsing anything.
    pub const fn exit_code(self) -> i32 {
        match self {
            ErrorCode::Locked => 3,
            _ => 1,
        }
    }

    /// Every variant, for the exhaustiveness test and for `--help` documentation.
    pub const ALL: &'static [ErrorCode] = &[
        ErrorCode::NotARepository,
        ErrorCode::GitFailed,
        ErrorCode::ConfigInvalid,
        ErrorCode::ConfigNotFound,
        ErrorCode::BranchNotFound,
        ErrorCode::WorktreeExists,
        ErrorCode::WorktreeNotFound,
        ErrorCode::WorktreeDirty,
        ErrorCode::WorktreeCreateFailed,
        ErrorCode::WorktreeRemoveFailed,
        ErrorCode::PortInUse,
        ErrorCode::ServiceFailed,
        ErrorCode::Locked,
        ErrorCode::Io,
    ];
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} is not inside a git repository")]
    NotARepository(Utf8PathBuf),

    #[error("git {args} failed with {status}: {stderr}")]
    GitFailed { args: String, status: String, stderr: String },

    /// A path git handed us that is not UTF-8. Rejected at the edge rather than lossily
    /// converted, because every path in this crate ends up in JSON.
    #[error("path is not valid UTF-8: {0}")]
    NonUtf8Path(String),

    #[error("no canopy.yaml found — {0}")]
    ConfigNotFound(String),

    #[error("canopy.yaml has {0} error(s)")]
    ConfigInvalid(usize),

    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    pub fn code(&self) -> ErrorCode {
        match self {
            Error::NotARepository(_) => ErrorCode::NotARepository,
            Error::GitFailed { .. } => ErrorCode::GitFailed,
            Error::NonUtf8Path(_) => ErrorCode::Io,
            Error::ConfigNotFound(_) => ErrorCode::ConfigNotFound,
            Error::ConfigInvalid(_) => ErrorCode::ConfigInvalid,
            Error::Io(_) => ErrorCode::Io,
        }
    }

    /// Extra machine-readable context for the `error.details` field. `None` means the
    /// message is the whole story.
    pub fn details(&self) -> Option<serde_json::Value> {
        match self {
            Error::GitFailed { args, status, stderr } => Some(serde_json::json!({
                "args": args, "status": status, "stderr": stderr
            })),
            Error::ConfigInvalid(errors) => Some(serde_json::json!({ "errors": errors })),
            _ => None,
        }
    }
}
