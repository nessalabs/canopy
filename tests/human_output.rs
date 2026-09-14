//! The human output of every command.
//!
//! `--json` is the contract a program reads; this is the one a person reads, and it is just as
//! much a surface. These assert the shape a user actually sees — that a path is printed, that a
//! count is named, that a refusal says what to do next — rather than exact wording, which should
//! be free to improve.

mod fixture;

use fixture::Fixture;

const CONFIG: &str = r#"version: 1
name: demo
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

/// Runs a command in human mode and returns stdout, asserting it succeeded.
fn human(fx: &Fixture, args: &[&str]) -> String {
    let out = fx.cwt().args(args).output().unwrap();
    assert!(out.status.success(), "`{}` failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

/// Runs a command expected to fail, returning stderr.
fn refusal(fx: &Fixture, args: &[&str]) -> String {
    let out = fx.cwt().args(args).output().unwrap();
    assert!(!out.status.success(), "`{}` unexpectedly succeeded", args.join(" "));
    String::from_utf8(out.stderr).unwrap()
}

fn prepared() -> Fixture {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", CONFIG), (".gitignore", ".env\n")], "add config");
    fx.write(".env", "SECRET=1\n");
    fx
}

#[test]
fn info_names_every_piece_of_the_repository() {
    let fx = prepared();
    let text = human(&fx, &["info"]);
    for expected in ["name", "root", "common dir", "git dir", "worktrees"] {
        assert!(text.contains(expected), "info should name {expected}: {text}");
    }
    assert!(text.contains(fx.root.as_str()));
}

#[test]
fn config_commands_print_something_a_person_can_act_on() {
    let fx = prepared();
    assert!(human(&fx, &["config", "path"]).contains("canopy.yaml"));
    assert!(human(&fx, &["config", "check"]).contains("0 error"));
    // `show` is the config with defaults filled in, so it must mention one the file omits.
    assert!(human(&fx, &["config", "show"]).contains("on-failure"));
    assert!(human(&fx, &["config", "init"]).contains("version: 1"));
    assert!(human(&fx, &["config", "schema"]).contains("json-schema.org"));
}

#[test]
fn path_prints_just_the_path_so_it_can_be_used_in_a_shell() {
    let fx = prepared();
    let text = human(&fx, &["path", "feat/x"]);
    // One line, no decoration: `cd "$(canopywt path feat/x)"` has to work.
    assert_eq!(text.lines().count(), 1, "{text:?}");
    assert!(text.trim().ends_with("wt/feat-x"), "{text:?}");
}

#[test]
fn new_says_what_it_created_and_where() {
    let fx = prepared();
    let text = human(&fx, &["new", "feat/x"]);
    assert!(text.contains("created feat/x"), "{text}");
    assert!(text.contains("from main"), "the base is worth saying: {text}");
    assert!(text.contains("wt/feat-x"), "{text}");
}

#[test]
fn new_on_an_existing_branch_says_checked_out_not_created() {
    let fx = prepared();
    fx.branch("already");
    let text = human(&fx, &["new", "already", "--existing"]);
    assert!(text.contains("checked out already"), "{text}");
}

#[test]
fn ports_and_env_print_usable_tables() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);

    let ports = human(&fx, &["ports", "feat/x"]);
    assert!(ports.contains("web"), "{ports}");

    let all = human(&fx, &["ports", "--all"]);
    assert!(all.contains("feat/x") && all.contains("web"), "{all}");

    let env = human(&fx, &["env", "feat/x"]);
    assert!(env.contains("CANOPY_BRANCH=feat/x"), "{env}");

    let export = human(&fx, &["env", "feat/x", "--export"]);
    assert!(export.contains("export CANOPY_BRANCH="), "{export}");

    let written = human(&fx, &["env", "feat/x", "--write"]);
    assert!(written.contains("wrote") && written.contains(".env.canopy"), "{written}");

    let released = human(&fx, &["ports", "feat/x", "--release"]);
    assert!(released.contains("released") && released.contains("feat/x"), "{released}");
}

#[test]
fn ports_all_on_an_empty_registry_says_so_rather_than_printing_nothing() {
    let fx = prepared();
    assert!(human(&fx, &["ports", "--all"]).contains("no ports"), "silence reads like a bug");
}

#[test]
fn env_with_env_file_disabled_explains_why_nothing_was_written() {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", "version: 1\nenv_file: false\nservices:\n  a:\n    run: x\n")], "init");
    let text = human(&fx, &["env", "main", "--write"]);
    assert!(text.contains("disabled"), "{text}");
}

#[test]
fn copy_names_each_path_and_says_when_there_is_nothing_to_do() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);

    // Dry run first: once the file is there, the honest answer is "skipped", not "planned".
    let dry = human(&fx, &["copy", "feat/x", "--dry-run"]);
    assert!(dry.contains("planned") && dry.contains(".env"), "{dry}");

    let text = human(&fx, &["copy", "feat/x"]);
    assert!(text.contains(".env") && text.contains("bytes"), "{text}");

    // Second run: everything is already there, and nothing is overwritten.
    assert!(human(&fx, &["copy", "feat/x"]).contains("skipped"));
    assert!(human(&fx, &["copy", "feat/x", "--dry-run"]).contains("skipped"), "a dry run must not claim it would copy");

    let none = Fixture::new();
    none.commit(
        &[(
            "canopy.yaml",
            "version: 1\nworktree:\n  path: \"{{ repo_path }}/../wt/{{ name }}\"\nservices:\n  a:\n    run: x\n",
        )],
        "init",
    );
    human(&none, &["new", "feat/y"]);
    assert!(human(&none, &["copy", "feat/y"]).contains("nothing to copy"));
}

#[test]
fn setup_reports_each_step_with_its_outcome() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);

    let text = human(&fx, &["setup", "feat/x", "--quiet"]);
    assert!(text.contains("ran") && text.contains("prepare"), "{text}");
    assert!(text.contains("ms)"), "a duration is worth knowing: {text}");
}

#[test]
fn a_failing_setup_step_is_marked_and_names_its_status() {
    let fx = Fixture::new();
    fx.commit(
        &[("canopy.yaml", "version: 1\nworktree:\n  path: \"{{ repo_path }}/../wt/{{ name }}\"\nsetup:\n  - name: doomed\n    run: exit 4\nservices:\n  a:\n    run: x\n")],
        "init",
    );
    human(&fx, &["new", "feat/x"]);
    let out = fx.cwt().args(["setup", "feat/x", "--quiet"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("FAILED") && text.contains("doomed") && text.contains("exit 4"), "{text}");
}

#[test]
fn service_commands_print_a_table_and_say_when_there_is_nothing() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);

    let up = human(&fx, &["up", "feat/x", "--no-wait"]);
    assert!(up.contains("web"), "{up}");

    let ps = human(&fx, &["ps", "feat/x"]);
    assert!(ps.contains("web") && ps.contains("running"), "{ps}");

    let down = human(&fx, &["down", "feat/x"]);
    assert!(down.contains("web"), "{down}");

    let empty = Fixture::new();
    empty.commit(&[("canopy.yaml", "version: 1\nworktree:\n  path: \"{{ repo_path }}/../wt/{{ name }}\"\n")], "init");
    human(&empty, &["new", "feat/y"]);
    assert!(human(&empty, &["ps", "feat/y"]).contains("no services"));
}

#[test]
fn doctor_and_gc_report_in_words() {
    let fx = prepared();
    assert!(human(&fx, &["doctor"]).contains("no problems"));

    // Make debris: allocate ports, then remove the worktree behind our back.
    human(&fx, &["new", "feat/x"]);
    human(&fx, &["ports", "feat/x"]);
    fx.git(["worktree", "remove", "--force", fx.root.parent().unwrap().join("wt/feat-x").as_str()]);
    fx.git(["worktree", "prune"]);

    let found = human(&fx, &["doctor"]);
    assert!(found.contains("port_row_stale"), "{found}");
    // A warning is debris, so the output says who cleans it up rather than just complaining.
    assert!(found.contains("canopywt gc"), "{found}");

    let swept = human(&fx, &["gc"]);
    assert!(swept.contains("released 1 port"), "{swept}");
    assert!(human(&fx, &["doctor"]).contains("no problems"));
}

#[test]
fn hook_commands_say_what_they_did() {
    let fx = prepared();
    assert!(human(&fx, &["hook", "status"]).contains("not installed"));

    let installed = human(&fx, &["hook", "install"]);
    assert!(installed.contains("installed") && installed.contains("post-checkout"), "{installed}");
    assert!(human(&fx, &["hook", "status"]).contains("installed"));

    assert!(human(&fx, &["hook", "uninstall"]).contains("removed"));
    // Removing again is not an error; it says nothing of ours was there.
    assert!(human(&fx, &["hook", "uninstall"]).contains("nothing of ours"));
}

#[test]
fn rm_says_what_went_and_what_it_freed() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);
    human(&fx, &["ports", "feat/x"]);

    let text = human(&fx, &["rm", "feat/x", "--delete-branch", "always"]);
    assert!(text.contains("removed") && text.contains("wt/feat-x"), "{text}");
    assert!(text.contains("deleted branch feat/x"), "{text}");
    assert!(text.contains("released 1 port"), "{text}");
}

#[test]
fn list_prints_one_line_per_worktree() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);
    let text = human(&fx, &["list"]);
    assert_eq!(text.lines().count(), 2, "{text}");
    assert!(text.contains("main") && text.contains("feat/x"), "{text}");
}

// -------------------------------------------------------------------------------------
// Refusals: the message is the whole product when a command says no.
// -------------------------------------------------------------------------------------

#[test]
fn a_refusal_explains_itself_on_stderr_and_leaves_stdout_clean() {
    let fx = prepared();
    let outside = fx.root.parent().unwrap().to_owned();
    let out = fx.cwt_in(&outside).arg("info").output().unwrap();
    assert!(out.stdout.is_empty(), "stdout must stay pipeable even when a command fails");
    assert!(String::from_utf8_lossy(&out.stderr).contains("not inside a git repository"));
}

#[test]
fn a_missing_config_says_how_to_make_one() {
    let fx = Fixture::new();
    let text = refusal(&fx, &["config", "check"]);
    assert!(text.contains("config init"), "a refusal should say what to do next: {text}");
}

#[test]
fn a_dirty_removal_says_how_much_is_at_stake_and_how_to_override() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);
    std::fs::write(fx.root.parent().unwrap().join("wt/feat-x/scratch.txt"), "work\n").unwrap();

    let text = refusal(&fx, &["rm", "feat/x"]);
    assert!(text.contains("1 uncommitted"), "{text}");
    assert!(text.contains("--force"), "{text}");
}

#[test]
fn an_operation_on_a_branch_with_no_checkout_names_the_branch() {
    let fx = prepared();
    for command in [["setup", "feat/absent"], ["copy", "feat/absent"], ["ps", "feat/absent"]] {
        let text = refusal(&fx, &command);
        assert!(text.contains("feat/absent"), "`{}` should name the branch: {text}", command.join(" "));
    }
}

#[test]
fn a_bad_duration_names_the_grammar_rather_than_saying_invalid() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);
    let text = refusal(&fx, &["setup", "feat/x", "--timeout", "5"]);
    assert!(text.contains("5s"), "the message should show an accepted spelling: {text}");
}

#[test]
fn a_bad_copy_rule_names_the_strategy_it_did_not_understand() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);
    let text = refusal(&fx, &["copy", "feat/x", "--rule", "x=teleport"]);
    assert!(text.contains("teleport") && text.contains("clone"), "{text}");
}

#[test]
fn a_bad_env_override_shows_the_expected_form() {
    let fx = prepared();
    human(&fx, &["new", "feat/x"]);
    let text = refusal(&fx, &["setup", "feat/x", "--env", "NOEQUALS"]);
    assert!(text.contains("KEY=VALUE"), "{text}");
}
