//! M6 through the CLI: carrying gitignored files into a new worktree.

mod fixture;

use fixture::{Fixture, err_envelope, ok_envelope};

const CONFIG: &str = r#"version: 1
worktree:
  path: "{{ repo_path }}/../wt/{{ name }}"
copy:
  - pattern: .env
  - pattern: .env.*.local
  - pattern: deps
    strategy: clone
services:
  a:
    run: sleep 1
"#;

/// A repo whose gitignored files are in place and whose worktree exists.
fn prepared() -> (Fixture, camino::Utf8PathBuf) {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", CONFIG), (".gitignore", "deps/\n.env*\ntracked-pattern.txt\n")], "add config");
    fx.write(".env", "SECRET=1\n");
    fx.write(".env.dev.local", "LOCAL=2\n");
    fx.write("deps/pkg/index.js", "module.exports = 1\n");
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    (fx, wt)
}

fn copy(fx: &Fixture, args: &[&str]) -> serde_json::Value {
    let mut command = fx.cwt();
    command.args(["copy", "feat/x", "--json"]).args(args);
    let out = command.output().unwrap();
    assert!(out.status.success(), "stdout: {}", String::from_utf8_lossy(&out.stdout));
    ok_envelope(&out.stdout)["data"].clone()
}

fn paths_of(data: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> =
        data["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

#[test]
fn gitignored_files_matching_a_rule_are_carried_across() {
    let (fx, wt) = prepared();
    let data = copy(&fx, &[]);

    assert_eq!(paths_of(&data), [".env", ".env.dev.local", "deps/pkg/index.js"]);
    assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1\n");
    assert_eq!(std::fs::read_to_string(wt.join("deps/pkg/index.js")).unwrap(), "module.exports = 1\n");
    assert!(data["failures"].as_array().unwrap().is_empty());
}

#[test]
fn a_tracked_file_is_never_copied_even_when_a_rule_matches_it() {
    // Tracked files arrive with `git worktree add`. Copying over them would overwrite what the
    // branch actually says.
    let fx = Fixture::new();
    let config = CONFIG.replace("  - pattern: .env\n", "  - pattern: .env\n  - pattern: tracked-pattern.txt\n");
    fx.commit(
        &[("canopy.yaml", &config), (".gitignore", "deps/\n.env*\n"), ("tracked-pattern.txt", "from the branch\n")],
        "init",
    );
    fx.write(".env", "SECRET=1\n");
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");

    // Change the source copy; the worktree must keep the committed content.
    fx.write("tracked-pattern.txt", "edited in the source\n");
    let data = copy(&fx, &[]);

    assert!(!paths_of(&data).contains(&"tracked-pattern.txt".to_owned()), "{data}");
    assert_eq!(std::fs::read_to_string(wt.join("tracked-pattern.txt")).unwrap(), "from the branch\n");
}

#[test]
fn a_bare_directory_pattern_carries_everything_under_it() {
    let (fx, wt) = prepared();
    fx.write("deps/pkg/nested/deep.js", "deep\n");
    copy(&fx, &[]);
    assert!(wt.join("deps/pkg/nested/deep.js").exists());
}

#[test]
fn nothing_is_overwritten_on_a_second_run() {
    let (fx, wt) = prepared();
    copy(&fx, &[]);
    std::fs::write(wt.join(".env"), "EDITED_IN_THE_WORKTREE=1\n").unwrap();

    let second = copy(&fx, &[]);
    // Every entry is reported as skipped rather than silently re-copied, so the report is
    // honest about having done nothing.
    assert!(second["entries"].as_array().unwrap().iter().all(|e| e["result"] == "skipped"), "{second}");
    assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "EDITED_IN_THE_WORKTREE=1\n");
}

#[test]
fn a_dry_run_reports_the_plan_and_writes_nothing() {
    let (fx, wt) = prepared();
    let data = copy(&fx, &["--dry-run"]);

    assert!(data["entries"].as_array().unwrap().iter().all(|e| e["result"] == "planned"), "{data}");
    assert!(!wt.join(".env").exists(), "a dry run must not write");
}

#[test]
fn the_report_says_whether_a_clone_actually_cloned() {
    // A silent fallback from reflink to a byte copy turns a twenty-second provision into two
    // minutes with no explanation, so the result has to distinguish them.
    let (fx, _wt) = prepared();
    let data = copy(&fx, &[]);
    let dep = data["entries"].as_array().unwrap().iter().find(|e| e["path"] == "deps/pkg/index.js").unwrap().clone();
    assert_eq!(dep["strategy"], "clone");
    assert!(dep["result"] == "cloned" || dep["result"] == "copied", "unexpected result {}", dep["result"]);
}

#[test]
fn the_reflink_fallback_is_reported_as_a_plain_copy() {
    let (fx, _wt) = prepared();
    let out = fx.cwt().args(["copy", "feat/x", "--json"]).env("CANOPYWT_NO_REFLINK", "1").output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    let dep = data["entries"].as_array().unwrap().iter().find(|e| e["path"] == "deps/pkg/index.js").unwrap().clone();
    assert_eq!(dep["result"], "copied", "with reflink off this must not claim to have cloned");
}

#[test]
fn copying_from_another_checkout() {
    let (fx, wt) = prepared();
    // A second worktree with its own gitignored file, used as the source.
    let other = fx.root.parent().unwrap().join("wt/other");
    fx.cwt().args(["new", "feat/other"]).output().unwrap();
    std::fs::write(fx.root.parent().unwrap().join("wt/feat-other/.env"), "FROM_THE_OTHER_ONE=1\n").unwrap();
    let _ = other;

    let out = fx
        .cwt()
        .args(["copy", "feat/x", "--from", fx.root.parent().unwrap().join("wt/feat-other").as_str(), "--json"])
        .output()
        .unwrap();
    ok_envelope(&out.stdout);
    assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "FROM_THE_OTHER_ONE=1\n");
}

#[test]
fn a_canopyinclude_narrows_the_set() {
    let (fx, wt) = prepared();
    // Both gitignored and listed is the rule; `.env.dev.local` is only the former.
    fx.write(".canopyinclude", ".env\ndeps/\n");
    let data = copy(&fx, &[]);

    assert!(paths_of(&data).contains(&".env".to_owned()));
    assert!(!paths_of(&data).contains(&".env.dev.local".to_owned()), "{data}");
    assert!(!wt.join(".env.dev.local").exists());
}

#[test]
fn no_rules_is_a_no_op() {
    let fx = Fixture::new();
    fx.commit(
        &[(
            "canopy.yaml",
            "version: 1\nworktree:\n  path: \"{{ repo_path }}/../wt/{{ name }}\"\nservices:\n  a:\n    run: x\n",
        )],
        "init",
    );
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    let data = copy(&fx, &[]);
    assert!(data["entries"].as_array().unwrap().is_empty());
}

#[test]
fn copying_into_a_branch_with_no_checkout_says_so() {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", CONFIG)], "init");
    let out = fx.cwt().args(["copy", "feat/absent", "--json"]).output().unwrap();
    err_envelope(&out.stdout, "worktree_not_found");
}

#[test]
fn human_output_says_what_happened_to_each_path() {
    let (fx, _wt) = prepared();
    let out = fx.cwt().args(["copy", "feat/x"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains(".env"), "{text}");
    assert!(text.contains("bytes"), "{text}");
}
