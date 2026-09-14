//! M4: creating and removing worktrees, against real git repositories.

mod fixture;

use fixture::{Fixture, err_envelope, ok_envelope};

/// A config that puts worktrees in a predictable place inside the temp dir.
const CONFIG: &str =
    "version: 1\nworktree:\n  path: \"{{ repo_path }}/../wt/{{ name }}\"\nservices:\n  a:\n    run: sleep 1\n";

#[test]
fn path_is_pure_and_needs_no_branch() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);

    let out = fx.cwt().args(["path", "feat/login", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    // The branch does not exist and that is fine: this answers "where would it go".
    assert_eq!(data["path"], fx.root.parent().unwrap().join("wt/feat-login").as_str());
    assert_eq!(data["branch"], "feat/login");
}

#[test]
fn path_uses_the_built_in_template_when_there_is_no_config() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["path", "feat/x", "--json"]).output().unwrap();
    // Beside the repo, not inside it.
    assert_eq!(ok_envelope(&out.stdout)["data"]["path"], fx.root.parent().unwrap().join("repo.feat-x").as_str());
}

#[test]
fn new_creates_a_branch_and_a_worktree_at_the_templated_path() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);

    let out = fx.cwt().args(["new", "feat/login", "--json"]).output().unwrap();
    assert!(out.status.success(), "stdout: {}", String::from_utf8_lossy(&out.stdout));
    let data = ok_envelope(&out.stdout)["data"].clone();

    let expected = fx.root.parent().unwrap().join("wt/feat-login");
    assert_eq!(data["path"], expected.as_str());
    assert_eq!(data["branch"], "feat/login");
    assert_eq!(data["created_branch"], true);
    assert!(expected.join("README.md").exists(), "the worktree should be checked out");
    // The branch keeps its real name; only the directory is sanitized.
    assert!(fx.git(["branch", "--list", "feat/login"]).contains("feat/login"));
}

#[test]
fn new_forks_from_the_default_branch_not_from_wherever_head_is() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    // Leave the main checkout on a side branch with an extra commit.
    fx.git(["checkout", "-q", "-b", "side"]);
    let side = fx.commit(&[("side.txt", "x\n")], "side work");

    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    let head = fx.git_in(&wt, ["rev-parse", "HEAD"]).trim().to_owned();

    // Branching off "whatever the main checkout was last left on" is a silent trap.
    assert_ne!(head, side, "should not have forked from the side branch");
    assert_eq!(head, fx.git(["rev-parse", "main"]).trim());
}

#[test]
fn new_with_an_explicit_base() {
    let fx = Fixture::new();
    // Committed on main before branching: `commit` stages everything, so writing it after the
    // branch exists would put the config on that branch alone and lose it on checkout.
    fx.commit(&[("canopy.yaml", CONFIG)], "add config");
    fx.git(["checkout", "-q", "-b", "release"]);
    let release = fx.commit(&[("r.txt", "x\n")], "release work");
    fx.git(["checkout", "-q", "main"]);

    fx.cwt().args(["new", "feat/x", "--base", "release"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    assert_eq!(fx.git_in(&wt, ["rev-parse", "HEAD"]).trim(), release);
}

#[test]
fn new_can_check_out_an_existing_branch() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.branch("already-here");

    let out = fx.cwt().args(["new", "already-here", "--existing", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    assert_eq!(data["created_branch"], false);
    assert!(fx.root.parent().unwrap().join("wt/already-here").exists());
}

#[test]
fn new_honours_an_explicit_path_over_the_template() {
    // This is how an embedder that owns its own layout drives us.
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    let elsewhere = fx.root.parent().unwrap().join("somewhere-else");

    let out = fx.cwt().args(["new", "feat/x", "--path", elsewhere.as_str(), "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["path"], elsewhere.as_str());
    assert!(elsewhere.join("README.md").exists());
}

#[test]
fn new_twice_is_refused_and_leaves_the_first_intact() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    std::fs::write(wt.join("precious.txt"), "do not lose me\n").unwrap();

    let out = fx.cwt().args(["new", "feat/x", "--json"]).output().unwrap();
    err_envelope(&out.stdout, "worktree_exists");
    assert_eq!(std::fs::read_to_string(wt.join("precious.txt")).unwrap(), "do not lose me\n");
}

#[test]
fn new_refuses_a_branch_already_checked_out_elsewhere() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    // Same branch, different directory: git would refuse with its own message, but we can say
    // where it already lives.
    let out = fx
        .cwt()
        .args(["new", "feat/x", "--existing", "--path", fx.root.parent().unwrap().join("other").as_str(), "--json"])
        .output()
        .unwrap();
    let value = err_envelope(&out.stdout, "worktree_exists");
    assert!(value["error"]["details"]["path"].as_str().unwrap().ends_with("wt/feat-x"));
}

#[test]
fn a_branch_with_no_directory_safe_form_is_refused() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["path", "///", "--json"]).output().unwrap();
    // Otherwise the worktree would land on the repository's parent directory.
    err_envelope(&out.stdout, "branch_not_found");
}

#[test]
fn new_reports_gits_own_message_when_git_refuses() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["new", "feat/x", "--base", "no-such-branch", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "worktree_create_failed");
    // Translating git's message would throw away the part that says what to fix.
    assert!(
        value["error"]["message"].as_str().unwrap().contains("no-such-branch"),
        "got {}",
        value["error"]["message"]
    );
}

// ---------------------------------------------------------------------------------------
// Removal — the destructive half
// ---------------------------------------------------------------------------------------

#[test]
fn rm_removes_the_checkout_and_leaves_no_stale_admin_dir() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");

    let out = fx.cwt().args(["rm", "feat/x", "--json"]).output().unwrap();
    assert!(out.status.success(), "stdout: {}", String::from_utf8_lossy(&out.stdout));
    assert!(!wt.exists());
    // Without the prune, the next `worktree add` at this path fails with a confusing message
    // about a directory that is not there.
    assert!(!fx.root.join(".git/worktrees/feat-x").exists(), "stale admin dir left behind");
    assert!(!fx.git(["worktree", "list"]).contains("feat-x"));
}

#[test]
fn rm_can_address_a_worktree_by_path() {
    // A detached worktree has no branch, so this has to work.
    let fx = Fixture::new();
    let head = fx.git(["rev-parse", "HEAD"]).trim().to_owned();
    let wt = fx.root.parent().unwrap().join("loose");
    fx.git(["worktree", "add", "--detach", wt.as_str(), &head]);

    let out = fx.cwt().args(["rm", wt.as_str(), "--json"]).output().unwrap();
    assert!(out.status.success(), "stdout: {}", String::from_utf8_lossy(&out.stdout));
    assert!(!wt.exists());
}

#[test]
fn rm_refuses_a_dirty_worktree_and_says_what_is_at_stake() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    std::fs::write(wt.join("untracked.txt"), "work\n").unwrap();

    let out = fx.cwt().args(["rm", "feat/x", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "worktree_dirty");
    assert_eq!(value["error"]["details"]["counts"]["untracked"], 1);
    assert_eq!(value["error"]["details"]["counts"]["total"], 1);
    assert!(wt.exists(), "nothing should have been removed");
}

#[test]
fn rm_counts_all_three_kinds_of_dirt() {
    // `git worktree remove` notices some of these and not others; all three are work someone
    // would be upset to lose.
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");

    std::fs::write(wt.join("untracked.txt"), "new\n").unwrap();
    std::fs::write(wt.join("README.md"), "modified\n").unwrap();
    std::fs::write(wt.join("staged.txt"), "staged\n").unwrap();
    fx.git_in(&wt, ["add", "staged.txt"]);

    let out = fx.cwt().args(["rm", "feat/x", "--json"]).output().unwrap();
    let counts = err_envelope(&out.stdout, "worktree_dirty")["error"]["details"]["counts"].clone();
    assert_eq!(counts["untracked"], 1, "{counts}");
    assert_eq!(counts["unstaged"], 1, "{counts}");
    assert_eq!(counts["staged"], 1, "{counts}");
    assert_eq!(counts["total"], 3, "{counts}");
}

#[test]
fn rm_force_discards_uncommitted_work() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    std::fs::write(wt.join("untracked.txt"), "work\n").unwrap();

    let out = fx.cwt().args(["rm", "feat/x", "--force"]).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(!wt.exists());
}

#[test]
fn rm_keeps_the_branch_by_default() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();

    let out = fx.cwt().args(["rm", "feat/x", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["branch_deleted"], false);
    assert!(fx.git(["branch", "--list", "feat/x"]).contains("feat/x"));
}

#[test]
fn rm_if_merged_deletes_a_merged_branch_and_keeps_an_unmerged_one() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);

    // Unmerged: has a commit main does not.
    fx.cwt().args(["new", "feat/unmerged"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-unmerged");
    std::fs::write(wt.join("new.txt"), "x\n").unwrap();
    fx.git_in(&wt, ["add", "-A"]);
    fx.git_in(&wt, ["commit", "-m", "unmerged work"]);

    let out = fx.cwt().args(["rm", "feat/unmerged", "--delete-branch", "if-merged", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["branch_deleted"], false, "unmerged work must survive");
    assert!(fx.git(["branch", "--list", "feat/unmerged"]).contains("feat/unmerged"));

    // Merged: identical to main.
    fx.cwt().args(["new", "feat/merged"]).output().unwrap();
    let out = fx.cwt().args(["rm", "feat/merged", "--delete-branch", "if-merged", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["branch_deleted"], true);
    assert!(!fx.git(["branch", "--list", "feat/merged"]).contains("feat/merged"));
}

#[test]
fn rm_always_deletes_even_an_unmerged_branch() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    std::fs::write(wt.join("new.txt"), "x\n").unwrap();
    fx.git_in(&wt, ["add", "-A"]);
    fx.git_in(&wt, ["commit", "-m", "work"]);

    let out = fx.cwt().args(["rm", "feat/x", "--delete-branch", "always", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["branch_deleted"], true);
}

#[test]
fn rm_refuses_the_main_checkout() {
    let fx = Fixture::new();
    // Removing it would take the repository with it.
    let out = fx.cwt().args(["rm", "main", "--json"]).output().unwrap();
    let value = err_envelope(&out.stdout, "worktree_remove_failed");
    assert!(value["error"]["message"].as_str().unwrap().contains("main checkout"));
    assert!(fx.root.join("README.md").exists());
}

#[test]
fn rm_of_an_unknown_target_is_worktree_not_found() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["rm", "nope", "--json"]).output().unwrap();
    err_envelope(&out.stdout, "worktree_not_found");
}

#[test]
fn rm_tolerates_a_checkout_that_is_already_gone() {
    // Someone deleted the directory by hand. The row in git still exists and should be cleaned
    // up rather than reported as an error.
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let wt = fx.root.parent().unwrap().join("wt/feat-x");
    std::fs::remove_dir_all(&wt).unwrap();

    let out = fx.cwt().args(["rm", "feat/x", "--json"]).output().unwrap();
    assert!(out.status.success(), "stdout: {}", String::from_utf8_lossy(&out.stdout));
    assert!(!fx.git(["worktree", "list"]).contains("feat-x"));
}

#[test]
fn a_worktree_can_be_recreated_at_the_same_path_after_removal() {
    // The end-to-end proof that prune actually ran.
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    fx.cwt().args(["rm", "feat/x", "--delete-branch", "always"]).output().unwrap();

    let out = fx.cwt().args(["new", "feat/x", "--json"]).output().unwrap();
    assert!(out.status.success(), "stdout: {}", String::from_utf8_lossy(&out.stdout));
}
