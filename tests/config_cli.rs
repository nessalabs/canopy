//! M2 through the CLI: discovery, the check report, and the envelope rules for a command
//! whose failure is a verdict rather than a fault.

mod fixture;

use fixture::{Fixture, err_envelope, ok_envelope};

const GOOD: &str = "version: 1\nports:\n  web: {}\nservices:\n  app:\n    run: serve ${ports.web}\n";
const BROKEN: &str = "version: 1\nservices:\n  app:\n    run: serve ${ports.nope}\n";

#[test]
fn config_path_reports_the_file_and_where_it_came_from() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", GOOD);

    let out = fx.cwt().args(["config", "path", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["path"], fx.root.join("canopy.yaml").as_str());
    assert_eq!(data["source"], "worktree");
}

#[test]
fn a_worktrees_own_config_wins_over_the_main_checkouts() {
    // A branch may change what it runs, and that change travels with the branch.
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", GOOD)], "add config");
    let wt = fx.root.parent().unwrap().join("wt");
    fx.git(["worktree", "add", "-b", "feature", wt.as_str()]);
    std::fs::write(wt.join("canopy.yaml"), "version: 1\nname: from-the-worktree\nservices:\n  a:\n    run: x\n")
        .unwrap();

    let out = fx.cwt_in(&wt).args(["config", "show", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["name"], "from-the-worktree");
}

#[test]
fn a_worktree_without_its_own_config_falls_back_to_the_main_checkout() {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", "version: 1\nname: shared\nservices:\n  a:\n    run: x\n")], "add config");
    let wt = fx.root.parent().unwrap().join("wt");
    fx.git(["worktree", "add", "-b", "feature", wt.as_str()]);
    // The committed file came along with the branch, so remove it to test the fallback.
    std::fs::remove_file(wt.join("canopy.yaml")).unwrap();

    let out = fx.cwt_in(&wt).args(["config", "path", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["source"], "main-checkout");
    assert_eq!(data["path"], fx.root.join("canopy.yaml").as_str());
}

#[test]
fn canopy_yml_is_accepted_too() {
    let fx = Fixture::new();
    fx.write("canopy.yml", GOOD);
    let out = fx.cwt().args(["config", "path", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["path"], fx.root.join("canopy.yml").as_str());
}

#[test]
fn no_config_anywhere_says_where_it_looked() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["config", "check", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "config_not_found");
    let message = value["error"]["message"].as_str().unwrap();
    // A refusal that does not say what to do next is a bad refusal.
    assert!(message.contains("config init"), "should suggest the fix: {message}");
}

#[test]
fn check_passes_a_good_config() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", GOOD);
    let out = fx.cwt().args(["config", "check", "--json"]).output().unwrap();
    assert!(out.status.success());
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["valid"], true);
    assert_eq!(data["errors"], 0);
}

#[test]
fn check_on_an_invalid_config_prints_exactly_one_envelope() {
    // Regression: the report and the failure were emitted separately, so `--json` produced two
    // JSON objects on stdout and any consumer's parser choked on the second.
    let fx = Fixture::new();
    fx.write("canopy.yaml", BROKEN);
    let out = fx.cwt().args(["config", "check", "--json"]).output().unwrap();

    let text = String::from_utf8(out.stdout.clone()).unwrap();
    assert_eq!(text.trim().lines().count(), 1, "exactly one envelope, got:\n{text}");
    serde_json::from_str::<serde_json::Value>(&text).expect("stdout parses as a single JSON value");
}

#[test]
fn an_invalid_config_is_a_verdict_that_still_carries_its_diagnostics() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", BROKEN);
    let out = fx.cwt().args(["config", "check", "--json"]).output().unwrap();

    // Exit 1 so CI need not parse the summary line.
    assert_eq!(out.status.code(), Some(1));
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["error"]["code"], "config_invalid");
    // `data` is present even though `ok` is false: the diagnostics are the point of the command.
    assert_eq!(value["data"]["errors"], 1);
    let diagnostics = value["data"]["diagnostics"].as_array().unwrap();
    assert!(diagnostics.iter().any(|d| d["message"].as_str().unwrap().contains("unknown port")));
}

#[test]
fn check_reads_stdin_without_touching_disk() {
    use std::io::Write;
    use std::process::Stdio;

    let fx = Fixture::new();
    fx.write("canopy.yaml", GOOD);

    // An editor validating an unsaved buffer: the file on disk is valid, the buffer is not.
    let mut child = fx
        .cwt()
        .args(["config", "check", "--stdin", "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(BROKEN.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();

    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["data"]["path"], "<stdin>");
    // The file on disk is untouched and still valid.
    assert_eq!(std::fs::read_to_string(fx.root.join("canopy.yaml")).unwrap(), GOOD);
}

#[test]
fn a_syntax_error_is_reported_with_a_line_and_column() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: one\n");
    let out = fx.cwt().args(["config", "check", "--json"]).output().unwrap();

    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let first = &value["data"]["diagnostics"][0];
    // An editor underlines with these; a flat message list is all it could do otherwise.
    assert_eq!(first["line"], 1);
    assert_eq!(first["column"], 10);
    assert_eq!(first["severity"], "error");
}

#[test]
fn human_check_output_is_editor_jump_to_line_friendly() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: one\n");
    let out = fx.cwt().args(["config", "check"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    // `path:line:column:` is what every editor and terminal already knows how to open.
    assert!(text.contains(&format!("{}:1:10:", fx.root.join("canopy.yaml"))), "got: {text}");
}

#[test]
fn show_fills_in_every_default() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", GOOD);
    let out = fx.cwt().args(["config", "show", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();

    // The point of `show`: a UI renders this without owning a YAML parser or the default table.
    assert_eq!(data["services"]["app"]["restart"], "on-failure");
    assert_eq!(data["services"]["app"]["autostart"], true);
    assert_eq!(data["services"]["app"]["stop_timeout"], "10s");
    assert_eq!(data["env_file"], ".env.canopy");
    assert_eq!(data["defaults"]["runtime"], "host");
    assert!(data["worktree"]["path"].as_str().unwrap().contains("{{ branch | sanitize }}"));
}

#[test]
fn show_refuses_an_invalid_config_rather_than_returning_half_of_it() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", BROKEN);
    let out = fx.cwt().args(["config", "show", "--json"]).output().unwrap();
    err_envelope(&out.stdout, "config_invalid");
}

#[test]
fn init_prints_a_starter_that_passes_check() {
    let fx = Fixture::new();
    let starter = fx.cwt().args(["config", "init"]).output().unwrap();
    assert!(starter.status.success());

    // Whatever `init` emits must survive `check`, or the first thing a new user does is see
    // a warning about the file the tool just gave them.
    std::fs::write(fx.root.join("canopy.yaml"), &starter.stdout).unwrap();
    let out = fx.cwt().args(["config", "check", "--json"]).output().unwrap();
    assert!(out.status.success(), "starter did not pass check: {}", String::from_utf8_lossy(&out.stdout));
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["warnings"], 0, "the starter should be exemplary");
}

#[test]
fn init_never_writes_anything() {
    let fx = Fixture::new();
    fx.cwt().args(["config", "init"]).output().unwrap();
    // Printing to stdout and letting the user redirect is the difference between a tool you
    // can pipe and one that clobbers a file you were editing.
    assert!(!fx.root.join("canopy.yaml").exists());
}

#[test]
fn init_works_outside_a_repository() {
    // You run `config init` to create the file, sometimes in a directory you just made.
    let fx = Fixture::new();
    let outside = fx.root.parent().unwrap().to_owned();
    let out = fx.cwt_in(&outside).args(["config", "init"]).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains("version: 1"));
}

#[test]
fn a_user_level_config_is_found_when_the_repo_has_none() {
    // The third search tier, for a repo that should not carry a canopy.yaml of its own —
    // someone else's project you still want to run this way.
    let fx = Fixture::new();
    // The fixture pins XDG_CONFIG_HOME, and the repo's directory is named `repo`.
    let user_dir = fx.home.join(".config").join("canopywt").join("repo");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("canopy.yaml"), "version: 1\nname: from-user-config\nservices:\n  a:\n    run: x\n")
        .unwrap();

    let out = fx.cwt().args(["config", "path", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["source"], "user-config");
    assert_eq!(data["path"], user_dir.join("canopy.yaml").as_str());
}

#[test]
fn a_committed_config_beats_the_user_level_one() {
    // Ordering matters: a file the team committed must win over one machine's preference,
    // or two developers on the same branch get different environments.
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nname: committed\nservices:\n  a:\n    run: x\n");
    let user_dir = fx.home.join(".config").join("canopywt").join("repo");
    std::fs::create_dir_all(&user_dir).unwrap();
    std::fs::write(user_dir.join("canopy.yaml"), "version: 1\nname: from-user-config\nservices:\n  a:\n    run: x\n")
        .unwrap();

    let out = fx.cwt().args(["config", "show", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["name"], "committed");
}
