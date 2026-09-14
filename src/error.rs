//! Errors carry a stable machine code, because the `--json` envelope is an API.
//!
//! A consumer (canopyd, an agent, a shell script) branches on `error.code`, never on the
//! message text. Adding a variant therefore means adding a code string, and the
//! `error_codes_are_exhaustive` test fails to compile until you do.

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
    SetupFailed,
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
            ErrorCode::SetupFailed => "setup_failed",
            ErrorCode::ServiceFailed => "service_failed",
            ErrorCode::Locked => "locked",
            ErrorCode::Io => "io",
        }
    }

    /// Process exit status. `3` is reserved for lock contention so a caller can retry it
    /// without parsing anything.
    pub const fn exit_code(self) -> u8 {
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
        ErrorCode::SetupFailed,
        ErrorCode::ServiceFailed,
        ErrorCode::Locked,
        ErrorCode::Io,
    ];
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

    #[error("{0} has no directory-safe form — every character would be stripped")]
    UnusableBranchName(String),

    #[error("{0} already exists")]
    WorktreeExists(Utf8PathBuf),

    #[error("{branch} is already checked out at {path}")]
    BranchAlreadyCheckedOut { branch: String, path: Utf8PathBuf },

    #[error("no worktree for {0}")]
    WorktreeNotFound(String),

    #[error("{path} has {} uncommitted change(s); pass --force to discard them", counts.total)]
    WorktreeDirty { path: Utf8PathBuf, counts: crate::worktree::DirtyCounts },

    #[error("the main checkout at {0} cannot be removed")]
    CannotRemoveMain(Utf8PathBuf),

    #[error("git could not create the worktree: {0}")]
    WorktreeCreateFailed(String),

    #[error("git could not remove the worktree: {0}")]
    WorktreeRemoveFailed(String),

    #[error("no canopy.yaml found — {0}")]
    ConfigNotFound(String),

    #[error("canopy.yaml has {0} error(s)")]
    ConfigInvalid(usize),

    #[error("{0}")]
    Io(#[from] std::io::Error),

    /// A module-local failure lifted to the crate's error type. The module keeps its own
    /// precise enum; this carries the message and, crucially, the code it already chose.
    #[error("{message}")]
    Module { code: ErrorCode, message: String },
}

impl Error {
    pub fn code(&self) -> ErrorCode {
        match self {
            Error::NotARepository(_) => ErrorCode::NotARepository,
            Error::GitFailed { .. } => ErrorCode::GitFailed,
            Error::NonUtf8Path(_) => ErrorCode::Io,
            Error::UnusableBranchName(_) => ErrorCode::BranchNotFound,
            Error::WorktreeExists(_) | Error::BranchAlreadyCheckedOut { .. } => ErrorCode::WorktreeExists,
            Error::WorktreeNotFound(_) => ErrorCode::WorktreeNotFound,
            Error::WorktreeDirty { .. } => ErrorCode::WorktreeDirty,
            Error::CannotRemoveMain(_) => ErrorCode::WorktreeRemoveFailed,
            Error::WorktreeCreateFailed(_) => ErrorCode::WorktreeCreateFailed,
            Error::WorktreeRemoveFailed(_) => ErrorCode::WorktreeRemoveFailed,
            Error::ConfigNotFound(_) => ErrorCode::ConfigNotFound,
            Error::ConfigInvalid(_) => ErrorCode::ConfigInvalid,
            Error::Io(_) => ErrorCode::Io,
            Error::Module { code, .. } => *code,
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
            // The counts let a caller decide whether to offer `--force` and say what it costs.
            Error::WorktreeDirty { path, counts } => Some(serde_json::json!({ "path": path, "counts": counts })),
            Error::BranchAlreadyCheckedOut { branch, path } => {
                Some(serde_json::json!({ "branch": branch, "path": path }))
            }
            _ => None,
        }
    }
}

// Each module defines a precise error of its own and says which wire code it deserves; these
// bridges preserve that choice rather than flattening everything to a generic failure.
impl From<crate::ports::PortError> for Error {
    fn from(error: crate::ports::PortError) -> Error {
        Error::Module { code: error.code(), message: error.to_string() }
    }
}

impl From<crate::copy::CopyError> for Error {
    fn from(error: crate::copy::CopyError) -> Error {
        let code = match error {
            crate::copy::CopyError::Candidates { .. } => ErrorCode::GitFailed,
            crate::copy::CopyError::BadPattern { .. } | crate::copy::CopyError::BadInclude { .. } => {
                ErrorCode::ConfigInvalid
            }
            crate::copy::CopyError::NonUtf8Path(_) => ErrorCode::Io,
        };
        Error::Module { code, message: error.to_string() }
    }
}

impl From<crate::proc::ProcError> for Error {
    fn from(error: crate::proc::ProcError) -> Error {
        Error::Module { code: error.code(), message: error.to_string() }
    }
}

impl From<crate::setup::SetupError> for Error {
    fn from(error: crate::setup::SetupError) -> Error {
        let code = match error {
            // A step naming a directory that cannot be made, or a glob that will not compile,
            // is the config being wrong rather than the machine failing.
            crate::setup::SetupError::BadPattern { .. } | crate::setup::SetupError::UnknownStep(_) => {
                ErrorCode::ConfigInvalid
            }
            crate::setup::SetupError::Io { .. } | crate::setup::SetupError::Shell { .. } => ErrorCode::Io,
        };
        Error::Module { code, message: error.to_string() }
    }
}

impl From<crate::env::EnvError> for Error {
    fn from(error: crate::env::EnvError) -> Error {
        Error::Module { code: ErrorCode::Io, message: error.to_string() }
    }
}
