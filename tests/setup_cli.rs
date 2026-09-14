//! M7 through the CLI: running a worktree's `setup:` steps.

mod fixture;

use fixture::{Fixture, ok_envelope};

/// A config whose worktrees land somewhere predictable.
fn config(setup: &str) -> String {
    format!(
        "version: 1\nworktree:\n  path: \"{{{{ repo_path }}}}/../wt/{{{{ name }}}}\"\nports:\n  web: {{}}\nsetup:\n{setup}services:\n  web:\n    run: serve ${{ports.web}}\n"
    )
}

/// A repo with a worktree at `wt/feat-x`, ready for setup.
fn with_worktree(setup: &str) -> (Fixture, camino::Utf8PathBuf) {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", &config(setup)), ("lockfile.txt", "v1\n")], "add config");
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let path = fx.root.parent().unwrap().join("wt/feat-x");
    (fx, path)
}

#[test]
fn steps_run_in_order() {
    let (fx, wt) =
        with_worktree("  - name: one\n    run: echo one >> order.txt\n  - name: two\n    run: echo two >> order.txt\n");
    let out = fx.cwt().args(["setup", "feat/x"]).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(std::fs::read_to_string(wt.join("order.txt")).unwrap(), "one\ntwo\n");
}

#[test]
fn the_resolved_environment_reaches_each_step() {
    let (fx, wt) =
        with_worktree("  - name: env\n    run: printf '%s %s' \"$CANOPY_BRANCH\" \"$CANOPY_PORT_WEB\" > env.txt\n");
    fx.cwt().args(["setup", "feat/x"]).output().unwrap();

    let written = std::fs::read_to_string(wt.join("env.txt")).unwrap();
    let ports = ok_envelope(&fx.cwt().args(["ports", "feat/x", "--json"]).output().unwrap().stdout)["data"].clone();
    assert_eq!(written, format!("feat/x {}", ports["web"]));
}

#[test]
fn a_step_runs_in_its_own_cwd_which_is_created_if_missing() {
    let (fx, wt) = with_worktree("  - name: nested\n    run: pwd > where.txt\n    cwd: apps/web\n");
    fx.cwt().args(["setup", "feat/x"]).output().unwrap();
    let where_ = std::fs::read_to_string(wt.join("apps/web/where.txt")).unwrap();
    assert!(where_.trim().ends_with("apps/web"), "{where_}");
}

#[test]
fn if_changed_skips_when_the_file_matches_the_source() {
    // The whole point: a four-minute install must not repeat for an unchanged lockfile.
    let (fx, _wt) = with_worktree("  - name: install\n    run: touch ran.marker\n    if_changed: [lockfile.txt]\n");
    let out = fx.cwt().args(["setup", "feat/x", "--json"]).output().unwrap();
    let steps = ok_envelope(&out.stdout)["data"]["steps"].as_array().unwrap().clone();
    assert_eq!(steps[0]["result"]["kind"], "skipped");
    // The reason is shown, so "why did nothing happen" is answerable without a debugger.
    assert!(steps[0]["result"]["reason"].as_str().unwrap().contains("lockfile.txt"));
}

#[test]
fn if_changed_runs_when_the_file_differs() {
    let (fx, wt) = with_worktree("  - name: install\n    run: touch ran.marker\n    if_changed: [lockfile.txt]\n");
    std::fs::write(wt.join("lockfile.txt"), "v2\n").unwrap();

    let out = fx.cwt().args(["setup", "feat/x", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["steps"][0]["result"]["kind"], "ran");
    assert!(wt.join("ran.marker").exists());
}

#[test]
fn force_overrides_the_skip() {
    let (fx, wt) = with_worktree("  - name: install\n    run: touch ran.marker\n    if_changed: [lockfile.txt]\n");
    fx.cwt().args(["setup", "feat/x", "--force"]).output().unwrap();
    assert!(wt.join("ran.marker").exists());
}

#[test]
fn only_runs_the_named_steps() {
    let (fx, wt) =
        with_worktree("  - name: one\n    run: touch one.marker\n  - name: two\n    run: touch two.marker\n");
    fx.cwt().args(["setup", "feat/x", "--only", "two"]).output().unwrap();
    assert!(!wt.join("one.marker").exists());
    assert!(wt.join("two.marker").exists());
}

#[test]
fn a_failing_step_stops_the_run_and_reports_a_verdict() {
    let (fx, wt) = with_worktree(
        "  - name: ok\n    run: echo fine\n  - name: bad\n    run: echo 'the reason' >&2; exit 3\n  - name: never\n    run: touch never.marker\n",
    );

    let out = fx.cwt().args(["setup", "feat/x", "--json", "-q"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "a failed step is a failed command");

    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    // A verdict, not a fault: the run happened and the answer is no, so `data` still carries
    // every step. Reporting ok:true alongside exit 1 would be a contradiction a caller trips on.
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "setup_failed");
    assert!(value["error"]["message"].as_str().unwrap().contains("bad"));

    let steps = value["data"]["steps"].as_array().unwrap();
    assert_eq!(steps[0]["result"]["kind"], "ran");
    assert_eq!(steps[1]["result"]["kind"], "failed");
    assert_eq!(steps[1]["result"]["status"], "exit 3");
    // The tail is what tells you why without opening a log.
    assert!(steps[1]["result"]["tail"].as_array().unwrap().iter().any(|l| l == "the reason"));
    // A step after the failure must not run.
    assert_eq!(steps.len(), 2, "{steps:?}");
    assert!(!wt.join("never.marker").exists());
}

#[test]
fn step_output_streams_to_stderr_so_stdout_stays_parseable() {
    let (fx, _wt) = with_worktree("  - name: talk\n    run: echo 'from the step'\n");
    let out = fx.cwt().args(["setup", "feat/x", "--json"]).output().unwrap();

    assert!(String::from_utf8_lossy(&out.stderr).contains("from the step"));
    // One envelope and nothing else on stdout, even though the step printed.
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(text.trim().lines().count(), 1, "{text}");
    serde_json::from_str::<serde_json::Value>(&text).expect("stdout is one JSON value");
}

#[test]
fn quiet_suppresses_the_stream_but_not_the_result() {
    let (fx, _wt) = with_worktree("  - name: talk\n    run: echo 'from the step'\n");
    let out = fx.cwt().args(["setup", "feat/x", "--quiet"]).output().unwrap();
    assert!(!String::from_utf8_lossy(&out.stderr).contains("from the step"));
    assert!(String::from_utf8_lossy(&out.stdout).contains("talk"));
}

#[test]
fn shell_features_work_because_a_step_is_a_shell_command() {
    let (fx, wt) = with_worktree(
        "  - name: shell\n    run: mkdir -p out && echo \"$(printf pipe)\" | tr a-z A-Z > out/result.txt\n",
    );
    fx.cwt().args(["setup", "feat/x"]).output().unwrap();
    assert_eq!(std::fs::read_to_string(wt.join("out/result.txt")).unwrap(), "PIPE\n");
}

#[test]
fn a_config_with_no_setup_steps_succeeds_doing_nothing() {
    let (fx, _wt) = with_worktree("");
    let out = fx.cwt().args(["setup", "feat/x", "--json"]).output().unwrap();
    assert!(out.status.success());
    assert!(ok_envelope(&out.stdout)["data"]["steps"].as_array().unwrap().is_empty());
}

#[test]
fn setup_on_a_branch_with_no_checkout_says_so() {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", &config("  - run: true\n"))], "add config");
    let out = fx.cwt().args(["setup", "feat/absent", "--json"]).output().unwrap();
    fixture::err_envelope(&out.stdout, "worktree_not_found");
}

#[test]
fn an_unknown_only_label_is_an_error_not_a_silent_success() {
    // A typo that reports a clean instant run is the failure mode that costs an hour.
    let (fx, _wt) = with_worktree("  - name: build\n    run: true\n");
    let out = fx.cwt().args(["setup", "feat/x", "--only", "biuld", "--json"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let value = fixture::err_envelope(&out.stdout, "config_invalid");
    assert!(value["error"]["message"].as_str().unwrap().contains("biuld"));
}

#[test]
fn a_bad_timeout_is_rejected_with_the_grammar() {
    let (fx, _wt) = with_worktree("  - name: build\n    run: true\n");
    let out = fx.cwt().args(["setup", "feat/x", "--timeout", "5", "--json"]).output().unwrap();
    let value = fixture::err_envelope(&out.stdout, "config_invalid");
    assert!(value["error"]["message"].as_str().unwrap().contains("5s"), "{}", value["error"]["message"]);
}

#[test]
fn a_step_that_exceeds_its_timeout_is_killed() {
    let (fx, _wt) = with_worktree("  - name: slow\n    run: sleep 60\n");
    let began = std::time::Instant::now();
    let out = fx.cwt().args(["setup", "feat/x", "--timeout", "300ms", "--json", "-q"]).output().unwrap();
    assert!(began.elapsed() < std::time::Duration::from_secs(20), "the timeout did not fire");

    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["data"]["steps"][0]["result"]["kind"], "failed");
}

#[test]
fn an_env_override_reaches_the_step_and_wins() {
    // The passthrough an embedder needs when its environment is richer than the crate can
    // resolve — Canopy's database URLs, for one.
    let (fx, wt) = with_worktree("  - name: env\n    run: printf '%s|%s' \"$EXTRA\" \"$CANOPY_BRANCH\" > env.txt\n");
    let out = fx
        .cwt()
        .args(["setup", "feat/x", "--env", "EXTRA=from-the-caller", "--env", "CANOPY_BRANCH=overridden"])
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    // An override beats even a fact the crate resolved itself; last layer wins.
    assert_eq!(std::fs::read_to_string(wt.join("env.txt")).unwrap(), "from-the-caller|overridden");
}

#[test]
fn an_env_override_may_be_empty_but_needs_a_name() {
    let (fx, wt) = with_worktree("  - name: env\n    run: printf '[%s]' \"$EMPTY\" > env.txt\n");
    assert!(fx.cwt().args(["setup", "feat/x", "--env", "EMPTY="]).output().unwrap().status.success());
    assert_eq!(std::fs::read_to_string(wt.join("env.txt")).unwrap(), "[]");

    for bad in ["=novalue", "NOEQUALS"] {
        let out = fx.cwt().args(["setup", "feat/x", "--env", bad, "--json"]).output().unwrap();
        fixture::err_envelope(&out.stdout, "config_invalid");
    }
}
