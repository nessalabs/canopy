//! The crate used as a library, not a CLI.
//!
//! Two jobs. It proves the public Rust API is usable on its own — the thing a program embedding
//! this crate actually does — and it reaches the branches the CLI cannot: a bare repository, a
//! renamed file, a git that fails for a reason other than "not a repository".

mod fixture;

use camino::{Utf8Path, Utf8PathBuf};
use canopy_worktree::config::CanopyConfig;
use canopy_worktree::git::Git;
use canopy_worktree::paths::{self, PathVars};
use canopy_worktree::repo::Repo;
use canopy_worktree::worktree::{BranchSpec, CreateOptions, DeleteBranch, RemoveOptions};
use canopy_worktree::{Canopy, Error, ErrorCode};
use fixture::Fixture;

/// Opens the fixture repo through the library, with git pinned the way the fixture pins it.
fn open(fx: &Fixture) -> Canopy {
    // The library reads the ambient environment for git; the fixture's isolation is applied by
    // the test process itself here, which is why these tests avoid anything HOME-dependent.
    Canopy::open(&fx.root).expect("fixture is a repository")
}

#[test]
fn the_facade_answers_without_a_config() {
    let fx = Fixture::new();
    let canopy = open(&fx);

    let info = canopy.info().unwrap();
    assert_eq!(info.root.as_deref(), Some(fx.root.as_path()));
    assert_eq!(info.worktrees, 1);
    assert!(!info.bare);
    // No canopy.yaml anywhere is a normal state, not an error.
    assert!(canopy.config().is_none());
    // …and the built-in template still answers.
    assert!(canopy.worktree_template().contains("{{ branch | sanitize }}"));
}

#[test]
fn the_facade_exposes_a_parsed_config_with_its_provenance() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nservices:\n  a:\n    run: sleep 1\n");
    let canopy = open(&fx);

    let (located, parsed) = canopy.config().expect("config found");
    assert_eq!(located.path, fx.root.join("canopy.yaml"));
    assert!(parsed.is_valid());
    assert_eq!(parsed.error_count(), 0);
    assert_eq!(parsed.config.as_ref().unwrap().services.len(), 1);
}

#[test]
fn an_invalid_config_is_reported_without_throwing_it_away() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nservices:\n  a:\n    run: x ${ports.nope}\n");
    let canopy = open(&fx);

    let (_, parsed) = canopy.config().expect("config found");
    // A caller can render the diagnostics even though there is no usable config.
    assert!(!parsed.is_valid());
    assert_eq!(parsed.error_count(), 1);
    assert!(parsed.diagnostics.iter().any(|d| d.message.contains("unknown port")));
}

#[test]
fn create_and_remove_through_the_library_api() {
    let fx = Fixture::new();
    fx.write(
        "canopy.yaml",
        "version: 1\nworktree:\n  path: \"{{ repo_path }}/../lib-wt/{{ name }}\"\nservices:\n  a:\n    run: sleep 1\n",
    );
    let canopy = open(&fx);

    let spec = BranchSpec::New { name: "feat/lib".to_owned(), base: Some("main".to_owned()) };
    let created = canopy.create(&spec, &CreateOptions::default()).unwrap();
    assert_eq!(created.branch, "feat/lib");
    assert!(created.created_branch);
    assert_eq!(created.base.as_deref(), Some("main"));
    assert!(created.path.join("README.md").exists());

    let removed =
        canopy.remove("feat/lib", &RemoveOptions { force: false, delete_branch: DeleteBranch::Always }).unwrap();
    assert!(removed.branch_deleted);
    assert!(!removed.path.exists());
}

#[test]
fn path_for_is_pure_and_needs_no_branch() {
    let fx = Fixture::new();
    let canopy = open(&fx);
    // The branch does not exist; this answers "where would it go".
    let templated = canopy.path_for("feat/x", None).unwrap();
    assert!(templated.as_str().ends_with("repo.feat-x"), "{templated}");
}

#[test]
fn an_explicit_name_only_matters_to_a_template_that_uses_it() {
    // The built-in template is keyed on the branch, so `name` changes nothing there. It is an
    // override for a template that spells `{{ name }}`, which is worth pinning: a caller that
    // passes a name and sees no effect should find the reason here rather than in a debugger.
    let fx = Fixture::new();
    let canopy = open(&fx);
    assert_eq!(canopy.path_for("feat/x", Some("custom")).unwrap(), canopy.path_for("feat/x", None).unwrap());

    fx.write(
        "canopy.yaml",
        "version: 1\nworktree:\n  path: \"{{ repo_path }}/../wt/{{ name }}\"\nservices:\n  a:\n    run: x\n",
    );
    let with_name = open(&fx);
    assert!(with_name.path_for("feat/x", Some("custom")).unwrap().as_str().ends_with("wt/custom"));
    // …and without one, the sanitized branch is the default.
    assert!(with_name.path_for("feat/x", None).unwrap().as_str().ends_with("wt/feat-x"));
}

#[test]
fn default_base_prefers_the_config_then_the_repository() {
    let fx = Fixture::new();
    assert_eq!(open(&fx).default_base().as_deref(), Some("main"));

    fx.write("canopy.yaml", "version: 1\nworktree:\n  base: release\nservices:\n  a:\n    run: x\n");
    assert_eq!(open(&fx).default_base().as_deref(), Some("release"));
}

// -------------------------------------------------------------------------------------
// Bare repositories — the branch the CLI tests barely touch
// -------------------------------------------------------------------------------------

#[test]
fn a_bare_repo_resolves_relative_templates_against_its_git_dir() {
    let fx = Fixture::new();
    let bare = fx.root.parent().unwrap().join("bare.git");
    fx.git_in(fx.root.parent().unwrap(), ["clone", "--bare", fx.root.as_str(), bare.as_str()]);

    let canopy = Canopy::open(&bare).unwrap();
    assert!(canopy.repo().is_bare());
    assert_eq!(canopy.repo().root, None);
    // With no checkout, the directory holding the git dir stands in for `{{ repo_path }}`.
    let path = canopy.path_for("feat/x", None).unwrap();
    assert!(path.as_str().contains("bare"), "{path}");
    // A bare repo has no config of its own to find.
    assert!(canopy.config().is_none());
}

#[test]
fn a_bare_repos_name_drops_the_git_suffix() {
    let fx = Fixture::new();
    let bare = fx.root.parent().unwrap().join("named.git");
    fx.git_in(fx.root.parent().unwrap(), ["clone", "--bare", fx.root.as_str(), bare.as_str()]);
    assert_eq!(Canopy::open(&bare).unwrap().repo().name(), "named");
}

// -------------------------------------------------------------------------------------
// Dirty counting — the paths a normal `git status` does not produce
// -------------------------------------------------------------------------------------

#[test]
fn dirty_counts_reads_a_rename_as_one_change_not_two() {
    // `-z` gives a rename two NUL-terminated paths. Reading the second as another entry would
    // double-count it, and worse, misread its first two bytes as a status code.
    let fx = Fixture::new();
    fx.commit(&[("old-name.txt", "content\n")], "add a file");
    fx.git(["mv", "old-name.txt", "new-name.txt"]);

    let canopy = open(&fx);
    let counts = canopy.repo().dirty_counts(&fx.root).unwrap();
    assert_eq!(counts.staged, 1, "a rename is one staged change: {counts:?}");
    assert_eq!(counts.untracked, 0);
    assert_eq!(counts.total, 1);
}

#[test]
fn dirty_counts_separates_staged_from_unstaged_on_one_file() {
    let fx = Fixture::new();
    fx.write("README.md", "staged edit\n");
    fx.git(["add", "README.md"]);
    fx.write("README.md", "and an unstaged one\n");

    let counts = open(&fx).repo().dirty_counts(&fx.root).unwrap();
    // One file, two kinds of change; both are work that would be lost.
    assert_eq!(counts.staged, 1);
    assert_eq!(counts.unstaged, 1);
    assert_eq!(counts.total, 2);
}

#[test]
fn a_clean_checkout_counts_zero() {
    let fx = Fixture::new();
    let counts = open(&fx).repo().dirty_counts(&fx.root).unwrap();
    assert_eq!(counts.total, 0);
}

// -------------------------------------------------------------------------------------
// Errors as a library contract
// -------------------------------------------------------------------------------------

#[test]
fn a_git_that_fails_for_another_reason_is_not_reported_as_not_a_repository() {
    // The guard exists so "git said no" and "you are not in a repo" stay distinguishable —
    // they need different fixes.
    let fx = Fixture::new();
    let error = Canopy::open_with(&fx.root, Git::new("/usr/bin/false")).unwrap_err();
    assert_eq!(error.code(), ErrorCode::GitFailed);
    let details = error.details().expect("git failures carry details");
    assert!(details["args"].as_str().unwrap().contains("rev-parse"));
}

#[test]
fn opening_outside_a_repository_names_the_directory() {
    let fx = Fixture::new();
    let outside = fx.root.parent().unwrap().to_owned();
    let error = Canopy::open(&outside).unwrap_err();
    assert_eq!(error.code(), ErrorCode::NotARepository);
    assert!(error.to_string().contains(outside.as_str()));
    assert!(error.details().is_none(), "a plain message needs no details");
}

#[test]
fn every_worktree_error_carries_a_code_a_caller_can_branch_on() {
    let fx = Fixture::new();
    let canopy = open(&fx);

    let missing = canopy.remove("no-such-branch", &RemoveOptions::default()).unwrap_err();
    assert_eq!(missing.code(), ErrorCode::WorktreeNotFound);

    let main_checkout = canopy.remove("main", &RemoveOptions::default()).unwrap_err();
    assert_eq!(main_checkout.code(), ErrorCode::WorktreeRemoveFailed);

    let unusable = canopy.path_for("///", None).unwrap_err();
    assert_eq!(unusable.code(), ErrorCode::BranchNotFound);
}

#[test]
fn creating_over_an_existing_branch_reports_where_it_already_lives() {
    let fx = Fixture::new();
    let canopy = open(&fx);
    let spec = BranchSpec::New { name: "feat/dup".to_owned(), base: None };
    let first = canopy.create(&spec, &CreateOptions::default()).unwrap();

    let existing = BranchSpec::Existing { name: "feat/dup".to_owned() };
    let options = CreateOptions { path: Some(fx.root.parent().unwrap().join("elsewhere")), name: None };
    let error = canopy.create(&existing, &options).unwrap_err();

    assert_eq!(error.code(), ErrorCode::WorktreeExists);
    let details = error.details().unwrap();
    assert_eq!(details["path"].as_str().unwrap(), first.path.as_str());
    assert_eq!(details["branch"].as_str().unwrap(), "feat/dup");
}

#[test]
fn a_dirty_removal_reports_counts_a_caller_can_show_the_user() {
    let fx = Fixture::new();
    let canopy = open(&fx);
    let created =
        canopy.create(&BranchSpec::New { name: "dirty".to_owned(), base: None }, &CreateOptions::default()).unwrap();
    std::fs::write(created.path.join("scratch.txt"), "work\n").unwrap();

    let error = canopy.remove("dirty", &RemoveOptions::default()).unwrap_err();
    assert_eq!(error.code(), ErrorCode::WorktreeDirty);
    let details = error.details().unwrap();
    assert_eq!(details["counts"]["untracked"], 1);

    // …and forcing past it works, which is the other half of the contract.
    canopy.remove("dirty", &RemoveOptions { force: true, delete_branch: DeleteBranch::Never }).unwrap();
}

// -------------------------------------------------------------------------------------
// Pure helpers, reachable only from the library
// -------------------------------------------------------------------------------------

#[test]
fn a_tilde_template_expands_to_the_home_directory() {
    let home = std::env::var("HOME").expect("HOME is set for this test process");
    let vars = PathVars { repo: "r", repo_path: Utf8Path::new("/base"), branch: "b", name: "n" };
    assert_eq!(
        paths::render("~/wt/{{ name }}", &vars),
        Utf8PathBuf::from(format!("{}/wt/n", home.trim_end_matches('/')))
    );
    // A bare `~` is the home directory itself.
    assert_eq!(paths::render("~", &vars), Utf8PathBuf::from(home.trim_end_matches('/')));
}

#[test]
fn a_relative_template_may_climb_above_its_base() {
    // `..` with nothing to pop has to be kept, or the path silently means something else.
    let vars = PathVars { repo: "r", repo_path: Utf8Path::new("base"), branch: "b", name: "n" };
    assert_eq!(paths::render("../../{{ name }}", &vars), Utf8PathBuf::from("../n"));
}

#[test]
fn default_branch_prefers_the_remote_head() {
    let fx = Fixture::new();
    // A clone has origin/HEAD; the local heuristic would answer the same here, so point
    // origin/HEAD at a branch that is not main to prove which one is consulted.
    fx.git(["branch", "trunk"]);
    fx.git(["remote", "add", "origin", fx.root.as_str()]);
    fx.git(["update-ref", "refs/remotes/origin/trunk", "refs/heads/trunk"]);
    fx.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);

    assert_eq!(open(&fx).repo().default_branch().as_deref(), Some("trunk"));
}

#[test]
fn default_branch_falls_back_to_master_when_there_is_no_main() {
    let fx = Fixture::new();
    fx.git(["branch", "-m", "main", "master"]);
    assert_eq!(open(&fx).repo().default_branch().as_deref(), Some("master"));
}

#[test]
fn default_branch_is_none_when_nothing_is_discoverable() {
    let fx = Fixture::new();
    fx.git(["branch", "-m", "main", "something-else"]);
    // A caller must be told to pass a base rather than have one guessed.
    assert_eq!(open(&fx).repo().default_branch(), None);
}

#[test]
fn a_repo_can_be_discovered_and_driven_with_an_explicit_git_binary() {
    // The seam an embedder uses to pin which git runs.
    let fx = Fixture::new();
    let repo = Repo::discover(Git::new("git"), &fx.root).unwrap();
    assert_eq!(repo.worktrees().unwrap().len(), 1);
    assert_eq!(repo.name(), "repo");
}

#[test]
fn the_config_type_is_constructible_and_serializable_by_a_consumer() {
    // A UI receives this shape; it must round-trip through JSON without losing defaults.
    let parsed =
        canopy_worktree::parse_str("version: 1\nports:\n  web: {}\nservices:\n  a:\n    run: x ${ports.web}\n");
    let config: &CanopyConfig = parsed.config.as_ref().unwrap();
    let json = serde_json::to_value(config).unwrap();
    assert_eq!(json["services"]["a"]["stop_timeout"], "10s");
    assert_eq!(json["env_file"], ".env.canopy");
    assert_eq!(json["worktree"]["path"], canopy_worktree::config::WorktreeSpec::default().path);
}

#[test]
fn error_is_a_std_error_so_it_composes_with_anyhow_and_friends() {
    let fx = Fixture::new();
    let error: Error = Canopy::open(fx.root.parent().unwrap()).unwrap_err();
    let dynamic: &dyn std::error::Error = &error;
    assert!(!dynamic.to_string().is_empty());
}

// -------------------------------------------------------------------------------------
// The facade's port and environment surface, driven as a library rather than a CLI
// -------------------------------------------------------------------------------------

#[test]
fn ports_are_allocated_released_and_reallocated_through_the_facade() {
    let fx = Fixture::new();
    fx.write(
        "canopy.yaml",
        "version: 1\nports:\n  web: {}\n  api: {}\nservices:\n  a:\n    run: x ${ports.web} ${ports.api}\n",
    );
    let canopy = open(&fx);

    let first = canopy.ports_for("feat/x").unwrap();
    assert_eq!(first.len(), 2);
    // Idempotent: a second ask must not move a number something has already been told to use.
    assert_eq!(canopy.ports_for("feat/x").unwrap(), first);

    assert_eq!(canopy.release_ports("feat/x").unwrap(), 2);
    // Releasing again is not an error; there is simply nothing left to free.
    assert_eq!(canopy.release_ports("feat/x").unwrap(), 0);
}

#[test]
fn releasing_ports_before_anything_was_allocated_is_a_no_op() {
    // The registry file does not exist yet, which must not be an error — `rm` calls this on
    // every worktree, including ones that never declared a port.
    let fx = Fixture::new();
    let canopy = open(&fx);
    assert!(!canopy.ports_path().exists());
    assert_eq!(canopy.release_ports("feat/x").unwrap(), 0);
}

#[test]
fn a_repo_with_no_declared_ports_writes_no_registry() {
    // An empty registry file is noise: it says something was allocated when nothing was.
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nservices:\n  a:\n    run: x\n");
    let canopy = open(&fx);
    assert!(canopy.ports_for("feat/x").unwrap().is_empty());
    assert!(!canopy.ports_path().exists());
}

#[test]
fn the_environment_carries_the_facts_and_the_allocated_ports() {
    let fx = Fixture::new();
    fx.write(
        "canopy.yaml",
        "version: 1\nname: demo\nports:\n  web: {}\nenv:\n  URL: http://127.0.0.1:${ports.web}\nservices:\n  a:\n    run: x ${ports.web}\n",
    );
    let canopy = open(&fx);
    let worktree = fx.root.parent().unwrap().join("wt/feat-x");

    let table = canopy.env_for("feat/x", &worktree).unwrap();
    let ports = canopy.ports_for("feat/x").unwrap();

    assert_eq!(table.get("CANOPY_BRANCH"), Some("feat/x"));
    assert_eq!(table.get("CANOPY_PROJECT"), Some("demo"));
    assert_eq!(table.get("CANOPY_WORKTREE_PATH"), Some(worktree.as_str()));
    assert_eq!(table.get("CANOPY_PORT_WEB"), Some(ports["web"].to_string().as_str()));
    // …and a declared variable is interpolated against the same numbers.
    assert_eq!(table.get("URL"), Some(format!("http://127.0.0.1:{}", ports["web"]).as_str()));
}

#[test]
fn the_environment_works_for_a_repository_with_no_config() {
    // Canopy's own facts are always available; a repo nobody has configured is not an error.
    let fx = Fixture::new();
    let canopy = open(&fx);
    let table = canopy.env_for("main", &fx.root).unwrap();
    assert_eq!(table.get("CANOPY_BRANCH"), Some("main"));
    assert!(table.get("CANOPY_PORT_WEB").is_none());
}

#[test]
fn state_lives_under_the_common_dir_so_every_worktree_agrees() {
    let fx = Fixture::new();
    let canopy = open(&fx);
    let root = canopy.state_root();
    let branch = canopy.state_dir("feat/x");

    // Under the common git dir: outside every checkout, so `git clean -xfd` cannot take it and
    // a linked worktree sees the same state as the main one.
    assert!(root.starts_with(&canopy.repo().common_dir), "{root}");
    assert!(branch.starts_with(&root), "{branch} should live under {root}");
    // Addressed by the sanitized branch, so `feat/x` and `feat-x` do not share a directory by
    // accident — `create` refuses that collision rather than letting it happen here.
    assert!(branch.as_str().ends_with("feat-x"), "{branch}");
    assert_eq!(canopy.ports_path().parent().unwrap(), canopy.repo().common_dir.join("canopy"));
}

#[test]
fn a_config_that_names_itself_is_what_the_project_is_called() {
    // The directory is whatever the person who cloned it chose; `name:` is what the project
    // calls itself, and it is the one that belongs in CANOPY_PROJECT and ${project.name}.
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nname: the-real-name\nservices:\n  a:\n    run: echo ${project.name}\n");
    let table = open(&fx).env_for("main", &fx.root).unwrap();
    assert_eq!(table.get("CANOPY_PROJECT"), Some("the-real-name"));

    // Without one, the directory name is the fallback rather than an empty string.
    let unnamed = Fixture::new();
    unnamed.write("canopy.yaml", "version: 1\nservices:\n  a:\n    run: x\n");
    assert_eq!(open(&unnamed).env_for("main", &unnamed.root).unwrap().get("CANOPY_PROJECT"), Some("repo"));
}
