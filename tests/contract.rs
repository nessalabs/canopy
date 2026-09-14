//! The parts of the surface that consumers pin against: the envelope shape and the error codes.
//!
//! These are the tests that stop `--json` rotting as commands are added.

mod fixture;

use canopy_worktree::ErrorCode;
use fixture::Fixture;

/// Every read-only command, for the table-driven envelope tests. Each new subcommand must be
/// added here — that is what stops `--json` rotting as the CLI grows.
/// Every command that answers with an envelope, with arguments that make it runnable. Success
/// is not the point — a failure is an envelope too — so these are checked for *shape*.
const ENVELOPE_COMMANDS: &[(&[&str], &str)] = &[
    (&["info"], "info"),
    (&["list"], "list"),
    (&["config", "check"], "config check"),
    (&["config", "show"], "config show"),
    (&["config", "path"], "config path"),
    (&["path", "feat/x"], "path"),
    (&["ports", "feat/x"], "ports"),
    (&["env", "feat/x"], "env"),
    (&["ps", "feat/x"], "ps"),
    (&["up", "feat/x"], "up"),
    (&["down", "feat/x"], "down"),
    (&["logs", "web", "feat/x"], "logs"),
    (&["setup", "feat/x"], "setup"),
    (&["copy", "feat/x"], "copy"),
    (&["new", "feat/new-one"], "new"),
    (&["rm", "feat/x"], "rm"),
    (&["doctor"], "doctor"),
    (&["gc"], "gc"),
    (&["hook", "status"], "hook status"),
];

/// The two that print a *document* rather than an envelope: `init` emits a starter file and
/// `schema` emits JSON Schema, both meant to be redirected into a file. Wrapping either in an
/// envelope would mean every consumer unwrapping it before use.
const DOCUMENT_COMMANDS: &[&[&str]] = &[&["config", "init"], &["config", "schema"]];

/// Kept for the human-output tests below, which need commands that work with no arguments.
const READ_ONLY_COMMANDS: &[&[&str]] =
    &[&["info"], &["list"], &["config", "check"], &["config", "show"], &["config", "path"]];

const CONFIG: &str = "version: 1\nports:\n  web: {}\nservices:\n  app:\n    run: serve ${ports.web}\n";

#[test]
fn every_command_emits_a_v1_envelope() {
    // Shape, not success: a command that fails still owes the caller an envelope, and several
    // of these are *expected* to fail against this fixture. What must never happen is raw text
    // or a half-written object on stdout.
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    for (args, expected) in ENVELOPE_COMMANDS {
        let out = fx.cwt().args(*args).arg("--json").output().unwrap();
        let invocation = args.join(" ");
        let text = String::from_utf8(out.stdout).unwrap();
        let value: serde_json::Value = serde_json::from_str(text.trim())
            .unwrap_or_else(|error| panic!("`{invocation}` did not print one JSON value ({error}): {text:?}"));

        assert_eq!(value["v"], 1, "`{invocation}` envelope version");
        assert_eq!(value["command"], *expected, "`{invocation}` names itself");
        assert!(value["ok"].is_boolean(), "`{invocation}` must report ok");
        assert!(value["warnings"].is_array(), "`{invocation}` always carries warnings");
        if value["ok"] == serde_json::Value::Bool(false) {
            assert!(value["error"]["code"].is_string(), "`{invocation}` failed without a code");
        }
    }
}

#[test]
fn every_subcommand_is_accounted_for() {
    // The guard that stops this file rotting. A new subcommand must be classified as one that
    // answers with an envelope or one that prints a document; forgetting is what let several
    // commands go unchecked here for a while.
    let fx = Fixture::new();
    let help = String::from_utf8(fx.cwt().arg("--help").output().unwrap().stdout).unwrap();
    let listed: std::collections::BTreeSet<String> = help
        .lines()
        .skip_while(|line| !line.starts_with("Commands:"))
        .skip(1)
        .take_while(|line| line.starts_with("  ") && !line.trim().is_empty())
        .filter_map(|line| line.split_whitespace().next())
        .filter(|name| *name != "help")
        .map(str::to_owned)
        .collect();
    assert!(!listed.is_empty(), "could not read the command list from --help:\n{help}");

    let classified: std::collections::BTreeSet<String> = ENVELOPE_COMMANDS
        .iter()
        .map(|(args, _)| args[0].to_owned())
        .chain(DOCUMENT_COMMANDS.iter().map(|args| args[0].to_owned()))
        .collect();

    let unclassified: Vec<&String> = listed.difference(&classified).collect();
    assert!(unclassified.is_empty(), "unclassified subcommand(s): {unclassified:?}");
}

#[test]
fn a_document_command_prints_a_document_not_an_envelope() {
    // `config init > canopy.yaml` and `config schema > canopy.schema.json` have to produce the
    // file, not something a consumer unwraps first.
    let fx = Fixture::new();
    for command in DOCUMENT_COMMANDS {
        let out = fx.cwt().args(*command).arg("--json").output().unwrap();
        let name = command.join(" ");
        assert!(out.status.success(), "{name} failed");
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(!text.contains("\"v\":1"), "{name} wrapped its document in an envelope");
        assert!(!text.trim().is_empty(), "{name} printed nothing");
    }
}

#[test]
fn json_output_is_exactly_one_line_so_it_streams() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    for command in READ_ONLY_COMMANDS {
        let out = fx.cwt().args(*command).arg("--json").output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        assert_eq!(text.lines().count(), 1, "{} --json must be one NDJSON-able line", command.join(" "));
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
    assert_eq!(ErrorCode::ALL.len(), 16, "a variant was added or removed — update ALL and this count");
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

#[test]
fn a_git_failure_carries_gits_own_stderr() {
    // Translating git's message would lose the part the user needs ("fatal: a branch named 'x'
    // already exists"), so it is passed through in `error.details`.
    let fx = Fixture::new();
    let out = fx.cwt().args(["list", "--json"]).env("CANOPYWT_GIT", "/usr/bin/false").output().unwrap();

    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false);
    // Crucially *not* `not_a_repository`: a git that fails for some other reason must not be
    // reported as "you are not in a repo", which would send the user looking in the wrong place.
    assert_eq!(value["error"]["code"], "git_failed");
    let details = &value["error"]["details"];
    assert!(details["args"].as_str().unwrap().contains("rev-parse"), "details name the command: {details}");
    assert!(details["status"].is_string(), "details carry the exit status: {details}");
}

#[test]
fn an_invalid_config_error_says_how_many() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nservices:\n  a:\n    run: x ${ports.nope}\n");
    let out = fx.cwt().args(["config", "show", "--json"]).output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["error"]["code"], "config_invalid");
    assert_eq!(value["error"]["details"]["errors"], 1);
}

#[test]
fn human_list_output_shortens_a_detached_head() {
    let fx = Fixture::new();
    let head = fx.git(["rev-parse", "HEAD"]).trim().to_owned();
    let wt = fx.root.parent().unwrap().join("loose");
    fx.git(["worktree", "add", "--detach", wt.as_str(), &head]);

    let out = fx.cwt().arg("list").output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    // A full 40-character sha in a column would push the path off the screen.
    assert!(text.contains(&format!("(detached {})", &head[..8])), "got: {text}");
    assert!(!text.contains(&head), "the full sha should not appear: {text}");
}

#[test]
fn human_config_path_output_names_the_source_in_words() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    let out = fx.cwt().args(["config", "path"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    // "worktree" is the enum's wire name; the human form should read like a sentence.
    assert!(text.contains("this worktree"), "got: {text}");
}

#[test]
fn human_list_output_labels_a_bare_repo() {
    let fx = Fixture::new();
    let bare = fx.root.parent().unwrap().join("bare.git");
    fx.git_in(fx.root.parent().unwrap(), ["clone", "--bare", fx.root.as_str(), bare.as_str()]);

    let out = fx.cwt_in(&bare).arg("list").output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    // A bare entry has neither branch nor head, so without its own arm it would print as a
    // blank column.
    assert!(text.contains("(bare)"), "got: {text}");
}
