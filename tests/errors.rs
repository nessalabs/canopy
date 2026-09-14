//! The error surface as a contract.
//!
//! `error.code` is what a consumer branches on, and `error.details` is what it shows the user.
//! Both are API. These tests construct every variant directly rather than provoking it through
//! a scenario, so a variant whose code or details change cannot slip through on the strength of
//! there being no scenario for it yet.

use camino::Utf8PathBuf;
use canopy_worktree::copy::CopyError;
use canopy_worktree::env::EnvError;
use canopy_worktree::ports::PortError;
use canopy_worktree::worktree::DirtyCounts;
use canopy_worktree::{Error, ErrorCode};

fn path() -> Utf8PathBuf {
    Utf8PathBuf::from("/tmp/wt")
}

/// Every variant of the crate error, paired with the code it must report.
fn every_variant() -> Vec<(Error, ErrorCode)> {
    vec![
        (Error::NotARepository(path()), ErrorCode::NotARepository),
        (
            Error::GitFailed { args: "status".into(), status: "exit code 1".into(), stderr: "fatal: nope".into() },
            ErrorCode::GitFailed,
        ),
        (Error::NonUtf8Path("bad".into()), ErrorCode::Io),
        (Error::UnusableBranchName("///".into()), ErrorCode::BranchNotFound),
        (Error::WorktreeExists(path()), ErrorCode::WorktreeExists),
        (Error::BranchAlreadyCheckedOut { branch: "feat/x".into(), path: path() }, ErrorCode::WorktreeExists),
        (Error::WorktreeNotFound("feat/x".into()), ErrorCode::WorktreeNotFound),
        (
            Error::WorktreeDirty {
                path: path(),
                counts: DirtyCounts { staged: 1, unstaged: 2, untracked: 3, total: 6 },
            },
            ErrorCode::WorktreeDirty,
        ),
        (Error::CannotRemoveMain(path()), ErrorCode::WorktreeRemoveFailed),
        (Error::WorktreeCreateFailed("git said no".into()), ErrorCode::WorktreeCreateFailed),
        (Error::WorktreeRemoveFailed("git said no".into()), ErrorCode::WorktreeRemoveFailed),
        (Error::ConfigNotFound("looked everywhere".into()), ErrorCode::ConfigNotFound),
        (Error::ConfigInvalid(3), ErrorCode::ConfigInvalid),
        (Error::Io(std::io::Error::other("disk went away")), ErrorCode::Io),
        (Error::Module { code: ErrorCode::Locked, message: "held".into() }, ErrorCode::Locked),
    ]
}

#[test]
fn every_variant_reports_its_code() {
    for (error, expected) in every_variant() {
        assert_eq!(error.code(), expected, "wrong code for {error:?}");
    }
}

#[test]
fn every_variant_has_a_non_empty_message_that_is_not_the_debug_form() {
    for (error, _) in every_variant() {
        let message = error.to_string();
        assert!(!message.is_empty(), "{error:?} has no message");
        // A Display that falls back to Debug reads like internals leaking into a UI.
        assert_ne!(message, format!("{error:?}"), "{error:?} has no real Display");
    }
}

#[test]
fn details_are_present_exactly_where_they_help() {
    // `details` exists so a caller can act without parsing prose. Anything without structured
    // context must report `None` rather than an empty object, which a consumer would have to
    // distinguish anyway.
    for (error, _) in every_variant() {
        let has_details = error.details().is_some();
        let should = matches!(
            error,
            Error::GitFailed { .. }
                | Error::ConfigInvalid(_)
                | Error::WorktreeDirty { .. }
                | Error::BranchAlreadyCheckedOut { .. }
        );
        assert_eq!(has_details, should, "details mismatch for {error:?}");
    }
}

#[test]
fn git_failure_details_carry_everything_needed_to_diagnose_it() {
    let error = Error::GitFailed {
        args: "worktree add x".into(),
        status: "exit code 128".into(),
        stderr: "fatal: exists".into(),
    };
    let details = error.details().unwrap();
    assert_eq!(details["args"], "worktree add x");
    assert_eq!(details["status"], "exit code 128");
    // git's own words, verbatim: translating them loses the part that says what to fix.
    assert_eq!(details["stderr"], "fatal: exists");
}

#[test]
fn dirty_details_break_down_what_would_be_lost() {
    let counts = DirtyCounts { staged: 1, unstaged: 2, untracked: 3, total: 6 };
    let error = Error::WorktreeDirty { path: path(), counts };
    let details = error.details().unwrap();
    assert_eq!(details["counts"]["staged"], 1);
    assert_eq!(details["counts"]["unstaged"], 2);
    assert_eq!(details["counts"]["untracked"], 3);
    assert_eq!(details["counts"]["total"], 6);
    assert_eq!(details["path"], "/tmp/wt");
    // The message says the total, so a caller that only prints it is still useful.
    assert!(error.to_string().contains('6'), "{error}");
}

#[test]
fn already_checked_out_details_say_where_it_lives() {
    let error = Error::BranchAlreadyCheckedOut { branch: "feat/x".into(), path: path() };
    let details = error.details().unwrap();
    assert_eq!(details["branch"], "feat/x");
    assert_eq!(details["path"], "/tmp/wt");
}

#[test]
fn config_invalid_details_carry_the_count() {
    assert_eq!(Error::ConfigInvalid(3).details().unwrap()["errors"], 3);
}

// -------------------------------------------------------------------------------------
// Module errors keep the code they chose
// -------------------------------------------------------------------------------------

#[test]
fn a_port_error_keeps_its_own_code() {
    // Flattening these to a generic failure would make `port_in_use` and `locked`
    // indistinguishable, and `locked` is the one a caller is meant to retry.
    let cases = [
        (PortError::RangeExhausted { name: "web".into(), from: 10_000, to: 10_002 }, ErrorCode::PortInUse),
        (PortError::PortInUse { port: 4000, branch: "other".into(), name: "web".into() }, ErrorCode::PortInUse),
        (PortError::InvalidPort { port: 0 }, ErrorCode::ConfigInvalid),
    ];
    for (port_error, expected) in cases {
        let message = port_error.to_string();
        let error: Error = port_error.into();
        assert_eq!(error.code(), expected);
        // The module's message survives the bridge; it is more specific than anything the
        // crate-level type could say.
        assert_eq!(error.to_string(), message);
    }
}

#[test]
fn a_copy_error_maps_by_kind() {
    let listing = CopyError::Candidates {
        path: path(),
        error: Error::GitFailed { args: "ls-files".into(), status: "1".into(), stderr: "x".into() },
    };
    assert_eq!(Error::from(listing).code(), ErrorCode::GitFailed);

    let pattern = CopyError::BadPattern { pattern: "[".into(), message: "unclosed".into() };
    // A bad glob is the user's config being wrong, not an I/O failure.
    assert_eq!(Error::from(pattern).code(), ErrorCode::ConfigInvalid);

    let include = CopyError::BadInclude { path: path(), message: "unreadable".into() };
    assert_eq!(Error::from(include).code(), ErrorCode::ConfigInvalid);

    let utf8 = CopyError::NonUtf8Path("bad".into());
    assert_eq!(Error::from(utf8).code(), ErrorCode::Io);
}

#[test]
fn an_env_error_is_an_io_failure() {
    let error = EnvError::Write { path: path(), source: std::io::Error::other("read-only") };
    let message = error.to_string();
    let lifted: Error = error.into();
    assert_eq!(lifted.code(), ErrorCode::Io);
    assert_eq!(lifted.to_string(), message);
}

#[test]
fn an_io_error_lifts_through_the_question_mark_operator() {
    // `?` on a std io error has to work, or every call site needs a map_err.
    fn fallible() -> Result<(), Error> {
        Err(std::io::Error::other("boom"))?;
        Ok(())
    }
    assert_eq!(fallible().unwrap_err().code(), ErrorCode::Io);
}

// -------------------------------------------------------------------------------------
// The code table itself
// -------------------------------------------------------------------------------------

#[test]
fn every_code_in_the_table_is_produced_by_some_variant() {
    // A code nobody can produce is a branch a consumer writes and never takes. The two
    // exceptions are documented below.
    let produced: std::collections::BTreeSet<&str> =
        every_variant().iter().map(|(error, _)| error.code().as_str()).collect();
    let unproduced: std::collections::BTreeSet<&str> =
        ErrorCode::ALL.iter().map(|code| code.as_str()).filter(|code| !produced.contains(code)).collect();

    // `service_failed` arrives with the supervisor. `port_in_use` and `setup_failed` are
    // produced by a module bridge or a verdict envelope rather than a crate-level variant,
    // and are covered elsewhere.
    //
    // Compared as a set: the iteration order is `ErrorCode::ALL`'s, and a variant inserted in
    // the middle of that list should not fail a test about *which* codes exist.
    let expected =
        std::collections::BTreeSet::from(["port_in_use", "repository_unhealthy", "service_failed", "setup_failed"]);
    assert_eq!(unproduced, expected, "unexpected unproduced codes");
}

#[test]
fn only_lock_contention_is_retryable() {
    for code in ErrorCode::ALL {
        let expected = if *code == ErrorCode::Locked { 3 } else { 1 };
        assert_eq!(code.exit_code(), expected, "{} has the wrong exit code", code.as_str());
    }
}
