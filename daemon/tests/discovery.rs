//! M1: repository discovery and the worktree list, against real git repositories.

mod fixture;

use fixture::{Fixture, err_envelope, ok_envelope};

#[test]
fn info_reports_root_and_common_dir_from_the_main_checkout() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["info", "--json"]).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let value = ok_envelope(&out.stdout);
    let data = &value["data"];

    assert_eq!(data["root"], fx.root.as_str());
    assert_eq!(data["common_dir"], fx.root.join(".git").as_str());
    assert_eq!(data["bare"], false);
    assert_eq!(data["worktrees"], 1);
    assert_eq!(data["name"], "repo");
}

#[test]
fn info_from_a_subdirectory_finds_the_same_repo() {
    let fx = Fixture::new();
    fx.write("deep/nested/file.txt", "x\n");
    let nested = fx.root.join("deep/nested");

    let out = fx.cwt_in(&nested).args(["info", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();

    // Discovery walks up: the answer is the repo, not the directory we happened to stand in.
    assert_eq!(data["root"], fx.root.as_str());
}

#[test]
fn info_from_inside_a_linked_worktree_reports_the_same_common_dir() {
    let fx = Fixture::new();
    let wt = fx.root.parent().unwrap().join("wt-feature");
    fx.git(["worktree", "add", "-b", "feature", wt.as_str()]);

    let main = ok_envelope(&fx.cwt().args(["info", "--json"]).output().unwrap().stdout)["data"].clone();
    let linked = ok_envelope(&fx.cwt_in(&wt).args(["info", "--json"]).output().unwrap().stdout)["data"].clone();

    // The common dir is what identifies a repository from anywhere inside it — this is the
    // property the state directory relies on.
    assert_eq!(main["common_dir"], linked["common_dir"]);
    // The per-worktree git dir differs, and lives under the common dir.
    assert_ne!(main["git_dir"], linked["git_dir"]);
    assert!(
        linked["git_dir"].as_str().unwrap().starts_with(main["common_dir"].as_str().unwrap()),
        "linked git dir {} should live under the common dir {}",
        linked["git_dir"],
        main["common_dir"]
    );
    // The linked worktree's root is its own checkout, not the main one.
    assert_eq!(linked["root"], wt.as_str());
    assert_eq!(linked["worktrees"], 2);
}

#[test]
fn info_outside_a_repo_exits_1_with_not_a_repository() {
    let fx = Fixture::new();
    // The fixture's temp base is not itself a repo.
    let outside = fx.root.parent().unwrap().to_owned();

    let out = fx.cwt_in(&outside).args(["info", "--json"]).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let value = err_envelope(&out.stdout, "not_a_repository");
    // The message names the directory, which git's own "not a git repository" does not.
    assert!(value["error"]["message"].as_str().unwrap().contains(outside.as_str()));
}

#[test]
fn info_on_a_bare_repo_has_no_root() {
    let fx = Fixture::new();
    let bare = fx.root.parent().unwrap().join("bare.git");
    fx.git_in(fx.root.parent().unwrap(), ["clone", "--bare", fx.root.as_str(), bare.as_str()]);

    let out = fx.cwt_in(&bare).args(["info", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();

    assert_eq!(data["bare"], true);
    // `root` is omitted rather than null, so a consumer's `if (data.root)` reads correctly.
    assert!(data.get("root").is_none(), "bare repo should have no root, got {data}");
    // `.git` is stripped from the name so `bare.git` and a normal clone agree.
    assert_eq!(data["name"], "bare");
}

#[test]
fn list_reports_one_worktree_for_a_fresh_repo() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["list", "--json"]).output().unwrap();
    let data = ok_envelope(&out.stdout)["data"].clone();
    let entries = data.as_array().expect("list returns an array");

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["path"], fx.root.as_str());
    assert_eq!(entries[0]["branch"], "main");
    assert_eq!(entries[0]["detached"], false);
    assert_eq!(entries[0]["bare"], false);
}

#[test]
fn list_reports_added_worktrees_main_checkout_first() {
    let fx = Fixture::new();
    let base = fx.root.parent().unwrap().to_owned();
    fx.git(["worktree", "add", "-b", "feat/one", base.join("one").as_str()]);
    fx.git(["worktree", "add", "-b", "feat/two", base.join("two").as_str()]);

    let out = fx.cwt().args(["list", "--json"]).output().unwrap();
    let entries = ok_envelope(&out.stdout)["data"].as_array().unwrap().clone();

    assert_eq!(entries.len(), 3);
    // git lists the main checkout first and everything else follows; downstream code relies
    // on that ordering to identify the main worktree without a second call.
    assert_eq!(entries[0]["path"], fx.root.as_str());
    let branches: Vec<&str> = entries.iter().map(|e| e["branch"].as_str().unwrap()).collect();
    assert_eq!(branches, ["main", "feat/one", "feat/two"]);
}

#[test]
fn list_reports_a_detached_worktree_without_a_branch() {
    let fx = Fixture::new();
    let head = fx.git(["rev-parse", "HEAD"]).trim().to_owned();
    let wt = fx.root.parent().unwrap().join("loose");
    fx.git(["worktree", "add", "--detach", wt.as_str(), &head]);

    let out = fx.cwt().args(["list", "--json"]).output().unwrap();
    let entries = ok_envelope(&out.stdout)["data"].as_array().unwrap().clone();
    let loose = entries.iter().find(|e| e["path"] == wt.as_str()).expect("detached worktree listed");

    assert_eq!(loose["detached"], true);
    assert!(loose.get("branch").is_none(), "detached worktree has no branch, got {loose}");
    assert_eq!(loose["head"], head);
}

#[test]
fn list_human_output_names_each_branch_and_path() {
    let fx = Fixture::new();
    let out = fx.cwt().arg("list").output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("main"), "human output should name the branch: {text}");
    assert!(text.contains(fx.root.as_str()), "human output should name the path: {text}");
}

#[test]
fn an_unborn_head_still_lists_the_worktree() {
    // `git init` with no commit yet: `worktree list` reports the checkout with a null HEAD and
    // a branch that does not exist. Discovery must not fall over on a brand-new repo.
    let fx = Fixture::empty();
    let out = fx.cwt().args(["list", "--json"]).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let entries = ok_envelope(&out.stdout)["data"].as_array().unwrap().clone();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["path"], fx.root.as_str());
}

#[test]
fn json_errors_still_print_a_well_formed_envelope_on_stdout() {
    let fx = Fixture::new();
    let outside = fx.root.parent().unwrap().to_owned();
    let out = fx.cwt_in(&outside).args(["list", "--json"]).output().unwrap();

    // The contract: stdout is always one parseable envelope, success or failure, and the
    // `command` field says which command produced it.
    let value = err_envelope(&out.stdout, "not_a_repository");
    assert_eq!(value["command"], "list");
    assert!(out.stderr.is_empty(), "nothing on stderr in --json mode: {:?}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn human_errors_go_to_stderr_and_leave_stdout_empty() {
    let fx = Fixture::new();
    let outside = fx.root.parent().unwrap().to_owned();
    let out = fx.cwt_in(&outside).arg("info").output().unwrap();

    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty(), "stdout must stay clean so it is safe to pipe");
    assert!(String::from_utf8_lossy(&out.stderr).contains("not inside a git repository"));
}

#[test]
fn a_bad_flag_is_a_usage_error_exit_2() {
    let fx = Fixture::new();
    let out = fx.cwt().args(["info", "--nonsense"]).output().unwrap();
    // clap owns usage errors; 2 is reserved for them so a caller can tell "you typed it wrong"
    // from "the operation failed".
    assert_eq!(out.status.code(), Some(2));
}
