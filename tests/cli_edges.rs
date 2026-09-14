//! The corners of the CLI: the flags and failure paths the happy-path tests never reach.

mod fixture;

use fixture::{Fixture, err_envelope, ok_envelope};

const CONFIG: &str = r#"version: 1
worktree:
  path: "{{ repo_path }}/../wt/{{ name }}"
ports:
  web: {}
copy:
  - pattern: .env
setup:
  - name: prepare
    run: echo ready > prepared.txt
services:
  web:
    run: sleep 120
"#;

fn prepared() -> Fixture {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", CONFIG), (".gitignore", ".env\ndeps/\n")], "add config");
    fx.write(".env", "SECRET=1\n");
    fx
}

// -------------------------------------------------------------------------------------
// -C, which every other test avoids by setting the process directory instead
// -------------------------------------------------------------------------------------

#[test]
fn the_directory_flag_works_from_anywhere() {
    let fx = prepared();
    let elsewhere = fx.root.parent().unwrap().to_owned();

    // Run from outside the repository entirely, pointing back at it.
    let out = fx.cwt_in(&elsewhere).args(["-C", fx.root.as_str(), "info", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["root"], fx.root.as_str());
}

#[test]
fn the_directory_flag_reports_a_path_that_is_not_a_repository() {
    let fx = prepared();
    let elsewhere = fx.root.parent().unwrap().to_owned();
    let out = fx.cwt().args(["-C", elsewhere.as_str(), "info", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "not_a_repository");
    // The message names the directory that was asked about, not the one we happened to be in.
    assert!(value["error"]["message"].as_str().unwrap().contains(elsewhere.as_str()));
}

// -------------------------------------------------------------------------------------
// Every command when git itself refuses
// -------------------------------------------------------------------------------------

/// Runs a command with a git that always fails, and asserts it is reported rather than
/// panicking or reporting success. Which code comes back depends on where git was called, so
/// this asserts the envelope's shape and that it is a failure.
#[track_caller]
fn fails_when_git_fails(fx: &Fixture, args: &[&str]) {
    let out = fx.cwt().args(args).arg("--json").env("CANOPYWT_GIT", "/usr/bin/false").output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    let value: serde_json::Value = serde_json::from_str(text.trim())
        .unwrap_or_else(|e| panic!("`{}` printed no envelope ({e}): {text:?}", args.join(" ")));
    assert_eq!(value["ok"], false, "`{}` reported success with a broken git", args.join(" "));
    assert!(value["error"]["code"].is_string(), "`{}` failed without a code", args.join(" "));
    assert_ne!(out.status.code(), Some(0), "`{}` exited 0 with a broken git", args.join(" "));
}

#[test]
fn every_command_reports_a_broken_git_rather_than_pretending() {
    // Silence here would be the worst outcome: a command that cannot ask git anything and
    // still says it succeeded.
    let fx = prepared();
    for args in [
        vec!["info"],
        vec!["list"],
        vec!["path", "feat/x"],
        vec!["ports", "feat/x"],
        vec!["ports", "--all"],
        vec!["env", "feat/x"],
        vec!["new", "feat/x"],
        vec!["rm", "feat/x"],
        vec!["copy", "feat/x"],
        vec!["setup", "feat/x"],
        vec!["up", "feat/x"],
        vec!["down", "feat/x"],
        vec!["ps", "feat/x"],
        vec!["logs", "web", "feat/x"],
        vec!["doctor"],
        vec!["gc"],
        vec!["hook", "install"],
        vec!["hook", "status"],
        vec!["config", "check"],
    ] {
        fails_when_git_fails(&fx, &args);
    }
}

// -------------------------------------------------------------------------------------
// The hook subcommand the installed script actually calls
// -------------------------------------------------------------------------------------

/// The three arguments git passes to `post-checkout`.
const NULL_REF: &str = "0000000000000000000000000000000000000000";

#[test]
fn post_checkout_recognises_a_worktree_add() {
    let fx = prepared();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    // Run from inside the new worktree, the way git runs the hook.
    let out = fx.cwt_in(&wt).args(["hook", "post-checkout", NULL_REF, "abc123", "1", "--json"]).output().unwrap();
    let value = ok_envelope(&out.stdout);
    assert_eq!(value["data"]["trigger"], "worktree_added", "{}", value["data"]);
}

#[test]
fn post_checkout_ignores_everything_that_is_not_a_worktree_add() {
    let fx = prepared();
    // An ordinary checkout: `$1` is a real sha, not the null ref.
    let ordinary = fx.cwt().args(["hook", "post-checkout", "aaa111", "bbb222", "1", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&ordinary.stdout)["data"]["trigger"], "not_a_worktree_add");

    // A file checkout: the flag is 0.
    let file = fx.cwt().args(["hook", "post-checkout", NULL_REF, "bbb222", "0", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&file.stdout)["data"]["trigger"], "not_a_worktree_add");

    // The main checkout has a `.git` directory rather than a gitfile, so a clone looks like this.
    let clone = fx.cwt().args(["hook", "post-checkout", NULL_REF, "bbb222", "1", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&clone.stdout)["data"]["trigger"], "not_a_worktree_add");
}

#[test]
fn post_checkout_always_exits_zero() {
    // The hooks directory is shared by every linked worktree, so a non-zero exit here would
    // break every checkout in the repository. git cannot abort one on our say-so anyway.
    let fx = prepared();
    for args in [
        vec!["hook", "post-checkout", NULL_REF, "abc", "1"],
        vec!["hook", "post-checkout", "nonsense", "", "not-a-number"],
    ] {
        let out = fx.cwt().args(&args).output().unwrap();
        assert_eq!(out.status.code(), Some(0), "`{}` did not exit 0", args.join(" "));
    }
}

#[test]
fn post_checkout_says_nothing_in_human_mode_unless_something_happened() {
    let fx = prepared();
    let quiet = fx.cwt().args(["hook", "post-checkout", "aaa", "bbb", "1"]).output().unwrap();
    assert!(quiet.stdout.is_empty(), "an ordinary checkout should be silent");

    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let noisy = fx.cwt_in(&wt).args(["hook", "post-checkout", NULL_REF, "abc", "1"]).output().unwrap();
    assert!(String::from_utf8_lossy(&noisy.stdout).contains("new worktree"), "a worktree add is worth a line");
}

// -------------------------------------------------------------------------------------
// Flags and branches the happy path misses
// -------------------------------------------------------------------------------------

#[test]
fn a_symlink_copy_rule_makes_a_link() {
    let fx = prepared();
    fx.write("deps/pkg/index.js", "module.exports = 1\n");
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    let out = fx.cwt().args(["copy", "feat/x", "--rule", "deps=symlink", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["entries"][0]["result"], "symlinked", "{data}");

    let link = fx.root.parent().unwrap().join("wt/feat-x/deps/pkg/index.js");
    assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink(), "a symlink rule must not copy");
}

#[test]
fn config_path_names_where_a_fallback_config_came_from() {
    // The worktree's own copy is the usual answer; these are the other two.
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    std::fs::remove_file(wt.join("canopy.yaml")).unwrap();

    let text = String::from_utf8(fx.cwt_in(&wt).args(["config", "path"]).output().unwrap().stdout).unwrap();
    assert!(text.contains("the main checkout"), "{text}");

    // And the user-level one, when the repository has none at all.
    let bare = Fixture::new();
    let user_dir = bare.home.join(".config/canopywt/repo");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("canopy.yaml"), "version: 1\nservices:\n  a:\n    run: x\n").unwrap();
    let text = String::from_utf8(bare.cwt().args(["config", "path"]).output().unwrap().stdout).unwrap();
    assert!(text.contains("your user config"), "{text}");
}

#[test]
fn gc_accepts_a_log_cap() {
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let logs = fx.root.join(".git/canopy/worktrees/feat-x/logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("web.log"), "x".repeat(4096)).unwrap();

    let out = fx.cwt().args(["gc", "--log-cap", "1024", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["logs_truncated"], 1);
    // Truncated, not deleted: the recent lines are what tell you why something died.
    assert!(logs.join("web.log").exists());
    assert!(std::fs::metadata(logs.join("web.log")).unwrap().len() <= 1024);
}

#[test]
fn doctor_reports_a_finding_that_needs_a_person_as_a_failure() {
    // A warning is debris `gc` sweeps, and exits 0. An error is something only a person can
    // settle, and CI should hear about it.
    let fx = prepared();
    let records = fx.root.join(".git/canopy/worktrees/feat-x/services");
    std::fs::create_dir_all(&records).unwrap();
    std::fs::write(records.join("web.json"), "{ not json").unwrap();

    let out = fx.cwt().args(["doctor", "--json"]).output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false, "{value}");
    assert_eq!(value["error"]["code"], "repository_unhealthy");
    assert_eq!(out.status.code(), Some(1));
    // …and the finding itself is still in `data`, which is the point of asking.
    assert!(value["data"]["findings"].as_array().unwrap().iter().any(|f| f["severity"] == "error"));
}

#[test]
fn a_worktree_with_an_unborn_head_is_listed_without_a_branch() {
    // `git init` with no commit: the checkout exists and its branch does not yet.
    let fx = Fixture::empty();
    let text = String::from_utf8(fx.cwt().arg("list").output().unwrap().stdout).unwrap();
    assert_eq!(text.lines().count(), 1, "{text}");
    assert!(text.contains(fx.root.as_str()), "{text}");
}

#[test]
fn copying_from_a_bare_repository_says_there_is_nothing_to_copy_from() {
    let fx = prepared();
    let bare = fx.root.parent().unwrap().join("bare.git");
    fx.git_in(fx.root.parent().unwrap(), ["clone", "--bare", fx.root.as_str(), bare.as_str()]);

    let out = fx.cwt_in(&bare).args(["copy", "main", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "worktree_not_found");
    assert!(value["error"]["message"].as_str().unwrap().contains("bare"), "{}", value["error"]["message"]);
}

// -------------------------------------------------------------------------------------
// Branches reachable only when git fails at one particular step
// -------------------------------------------------------------------------------------

/// A git that behaves normally except for one subcommand pair, which always fails.
///
/// `CANOPYWT_GIT` pointed at a failing binary makes *every* call fail, which never gets past
/// the first one. Creating and removing a worktree both list first, so the arms that map their
/// own failures need a git that answers the listing and refuses the operation.
fn selective_git(fx: &Fixture, refuse: &str) -> camino::Utf8PathBuf {
    let path = fx.home.join(format!("git-without-{}", refuse.replace(' ', "-")));
    let script = format!(
        "#!/bin/sh\n\
         # Everything works except `git {refuse}`, so a caller gets past the listing and fails\n\
         # on the operation itself.\n\
         case \"$1 $2\" in\n\
         '{refuse}') echo 'fatal: refused by the test' >&2; exit 1 ;;\n\
         esac\n\
         exec git \"$@\"\n"
    );
    std::fs::write(&path, script).expect("write fake git");
    let mut mode = std::fs::metadata(&path).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
    std::fs::set_permissions(&path, mode).unwrap();
    path
}

#[test]
fn a_create_that_git_refuses_is_reported_as_a_create_failure() {
    let fx = prepared();
    let git = selective_git(&fx, "worktree add");
    let out = fx.cwt().args(["new", "feat/x", "--json"]).env("CANOPYWT_GIT", git.as_str()).output().unwrap();

    let value = err_envelope(&out.stdout, "worktree_create_failed");
    // git's own words survive; they are the part that says what to fix.
    assert!(value["error"]["message"].as_str().unwrap().contains("refused by the test"));
}

#[test]
fn a_removal_that_git_refuses_is_reported_as_a_remove_failure() {
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    let git = selective_git(&fx, "worktree remove");
    let out = fx.cwt().args(["rm", "feat/x", "--json"]).env("CANOPYWT_GIT", git.as_str()).output().unwrap();

    let value = err_envelope(&out.stdout, "worktree_remove_failed");
    assert!(value["error"]["message"].as_str().unwrap().contains("refused by the test"));
    // …and the checkout is still there, because the removal did not happen.
    assert!(fx.root.parent().unwrap().join("wt/feat-x").exists());
}

#[test]
fn a_dirty_check_that_git_refuses_stops_the_removal() {
    // Reporting "nothing uncommitted" because git would not answer is how work gets deleted.
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    let git = selective_git(&fx, "status --porcelain=v1");
    let out = fx.cwt().args(["rm", "feat/x", "--json"]).env("CANOPYWT_GIT", git.as_str()).output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false, "a removal proceeded without knowing whether the tree was dirty");
    assert!(fx.root.parent().unwrap().join("wt/feat-x").exists());
}

// -------------------------------------------------------------------------------------
// Output branches the happy path does not print
// -------------------------------------------------------------------------------------

#[test]
fn logs_prints_the_tail_in_human_mode() {
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let logs = fx.root.join(".git/canopy/worktrees/feat-x/logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join("web.log"), "first line\nsecond line\n").unwrap();

    let text = String::from_utf8(fx.cwt().args(["logs", "web", "feat/x"]).output().unwrap().stdout).unwrap();
    assert!(text.contains("first line") && text.contains("second line"), "{text}");
}

#[test]
fn copy_reports_a_path_it_could_not_carry_alongside_the_ones_it_did() {
    // One unreadable file must not cost you the rest of them.
    let fx = prepared();
    fx.write("deps/readable.txt", "fine\n");
    fx.write("deps/locked.txt", "secret\n");
    let locked = fx.root.join("deps/locked.txt");
    let mut mode = std::fs::metadata(&locked).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o000);
    std::fs::set_permissions(&locked, mode).unwrap();

    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let text = String::from_utf8(fx.cwt().args(["copy", "feat/x", "--rule", "deps"]).output().unwrap().stdout).unwrap();
    assert!(text.contains("failed") && text.contains("locked.txt"), "{text}");
    assert!(text.contains("readable.txt"), "the readable file should still have landed: {text}");
}

#[test]
fn setup_reports_a_skipped_step_in_human_mode() {
    let fx = prepared();
    fx.write("lock.txt", "v1\n");
    fx.commit(
        &[(
            "canopy.yaml",
            &CONFIG.replace(
                "    run: echo ready > prepared.txt",
                "    run: echo ready > prepared.txt\n    if_changed: [lock.txt]",
            ),
        )],
        "gate setup",
    );
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    let text = String::from_utf8(fx.cwt().args(["setup", "feat/x", "--quiet"]).output().unwrap().stdout).unwrap();
    assert!(text.contains("skipped") && text.contains("prepare"), "{text}");
}

#[test]
fn run_emits_one_json_event_per_line_on_stderr() {
    // stdout is the final envelope; a caller following along wants the events as they happen.
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    let child = fx
        .cwt()
        .args(["run", "feat/x", "--no-restart", "--json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn run");
    std::thread::sleep(std::time::Duration::from_millis(700));
    std::process::Command::new("kill").args(["-INT", &child.id().to_string()]).status().unwrap();
    let out = child.wait_with_output().expect("run exited");

    let events = String::from_utf8(out.stderr).unwrap();
    let parsed: Vec<serde_json::Value> = events
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("each line is one event"))
        .collect();
    assert!(parsed.iter().any(|e| e["event"] == "started"), "{events}");
    assert!(parsed.iter().any(|e| e["event"] == "stopped"), "{events}");

    // And stdout is the single envelope, not the events.
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["command"], "run");
    assert!(value["data"]["restarts"].is_number());
}

#[test]
fn config_show_without_a_config_says_where_it_looked() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["config", "show", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "config_not_found");
    assert!(value["error"]["message"].as_str().unwrap().contains("config init"));
}

#[test]
fn a_copy_rule_with_no_pattern_is_refused() {
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let out = fx.cwt().args(["copy", "feat/x", "--rule", "=copy", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "config_invalid");
    assert!(value["error"]["message"].as_str().unwrap().contains("needs a pattern"));
}

#[test]
fn copying_from_a_bare_repository_has_no_checkout_to_copy_from() {
    // A bare repo has no working tree, so there is nothing to take gitignored files from.
    // The branch has to be named explicitly: there is no current one to default to either.
    let fx = prepared();
    let bare = fx.root.parent().unwrap().join("bare.git");
    fx.git_in(fx.root.parent().unwrap(), ["clone", "--bare", fx.root.as_str(), bare.as_str()]);
    let wt = fx.root.parent().unwrap().join("bare-wt");
    fx.git_in(&bare, ["worktree", "add", "-b", "feat/bare", wt.as_str()]);

    let out = fx.cwt_in(&bare).args(["copy", "feat/bare", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "worktree_not_found");
    assert!(value["error"]["message"].as_str().unwrap().contains("bare repository"), "{}", value["error"]["message"]);
}

#[test]
fn an_error_that_is_not_a_git_refusal_keeps_its_own_kind() {
    // The error mapping turns git's refusal into "create failed", and must leave anything else
    // alone. A git that exits 0 having written bytes that are not UTF-8 is not a refusal, and
    // calling it one would send the user looking for a git message that does not exist.
    let fx = prepared();
    let path = fx.home.join("git-writes-garbage");
    std::fs::write(
        &path,
        "#!/bin/sh\n\
         # Succeeds at listing, then answers `worktree add` with bytes that are not UTF-8.\n\
         case \"$1 $2\" in\n\
         'worktree add') printf '\\377\\376'; exit 0 ;;\n\
         esac\n\
         exec git \"$@\"\n",
    )
    .unwrap();
    let mut mode = std::fs::metadata(&path).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
    std::fs::set_permissions(&path, mode).unwrap();

    let out = fx.cwt().args(["new", "feat/x", "--json"]).env("CANOPYWT_GIT", path.as_str()).output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false);
    // `io`, not `worktree_create_failed`: the kind survived the mapping.
    assert_eq!(value["error"]["code"], "io", "{value}");
}

#[test]
fn config_path_without_a_config_says_where_it_looked() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["config", "path", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "config_not_found");
    assert!(value["error"]["message"].as_str().unwrap().contains("config init"));
}

#[test]
fn logs_for_a_service_that_never_ran_is_reported_not_silent() {
    // An empty answer and a missing log look the same to a reader otherwise.
    let fx = prepared();
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let out = fx.cwt().args(["logs", "never-started", "feat/x", "--json"]).output().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false, "{value}");
    assert!(value["error"]["code"].is_string());
}
