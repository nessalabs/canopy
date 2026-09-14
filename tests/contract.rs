//! The parts of the surface that consumers pin against: the envelope shape and the error codes.
//!
//! These are the tests that stop `--json` rotting as commands are added.

mod fixture;

use canopy_worktree::ErrorCode;
use fixture::{Fixture, ok_envelope};

/// Every command, for the table-driven envelope test. Each new subcommand must be added here.
const READ_ONLY_COMMANDS: &[&str] = &["info", "list"];

#[test]
fn every_command_emits_a_v1_envelope() {
    let fx = Fixture::new();
    for command in READ_ONLY_COMMANDS {
        let out = fx.cwt().args([command, "--json"]).output().unwrap();
        assert!(out.status.success(), "{command} failed: {}", String::from_utf8_lossy(&out.stderr));
        let value = ok_envelope(&out.stdout);
        assert_eq!(value["command"], *command, "envelope names the command it came from");
        assert!(value["warnings"].is_array(), "warnings is always an array, even when empty");
        assert!(value.get("data").is_some(), "a successful envelope carries data");
        assert!(value.get("error").is_none(), "a successful envelope carries no error");
    }
}

#[test]
fn json_output_is_exactly_one_line_so_it_streams() {
    let fx = Fixture::new();
    for command in READ_ONLY_COMMANDS {
        let out = fx.cwt().args([command, "--json"]).output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        assert_eq!(text.lines().count(), 1, "{command} --json must be one NDJSON-able line");
    }
}

#[test]
fn error_codes_are_unique_and_wire_stable() {
    let mut seen = std::collections::BTreeSet::new();
    for code in ErrorCode::ALL {
        let text = code.as_str();
        assert!(!text.is_empty(), "{code:?} has an empty wire string");
        assert!(
            text.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "{text} must be snake_case ascii so it is safe in any consumer"
        );
        assert!(seen.insert(text), "duplicate error code {text}");
    }
}

#[test]
fn error_code_count_is_pinned() {
    // `ErrorCode::as_str` is an exhaustive match, so a new variant cannot compile without a
    // wire string. This guards the other half: that the variant was also added to `ALL`,
    // which the CLI documentation and these tests iterate. Bump the number deliberately.
    assert_eq!(ErrorCode::ALL.len(), 14, "a variant was added or removed — update ALL and this count");
}

#[test]
fn only_lock_contention_is_retryable() {
    // Exit 3 means "someone else holds the lock, try again"; a caller retries on it blindly,
    // so nothing else may claim that code.
    for code in ErrorCode::ALL {
        let expected = if *code == ErrorCode::Locked { 3 } else { 1 };
        assert_eq!(code.exit_code(), expected, "{} has the wrong exit code", code.as_str());
    }
}
