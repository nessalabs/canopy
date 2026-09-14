//! M3 and M5 through the CLI: port allocation and environment resolution.

mod fixture;

use fixture::{Fixture, err_envelope, ok_envelope};

const CONFIG: &str = r#"version: 1
name: demo
ports:
  web: {}
  api:
    preferred: 14100
env:
  BASE: /srv/demo
  DATA_DIR: ${env.BASE}/data
  PUBLIC_URL: http://127.0.0.1:${ports.web}
  API_TOKEN: hunter2
services:
  web:
    run: serve --port ${ports.web}
  api:
    run: api --port ${ports.api}
"#;

fn ports_of(fx: &Fixture, branch: &str) -> serde_json::Value {
    let out = fx.cwt().args(["ports", branch, "--json"]).output().unwrap();
    assert!(out.status.success(), "stdout: {}", String::from_utf8_lossy(&out.stdout));
    ok_envelope(&out.stdout)["data"].clone()
}

#[test]
fn ports_are_allocated_on_first_ask_and_never_move_after() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);

    let first = ports_of(&fx, "main");
    assert!(first["web"].is_number() && first["api"].is_number());

    // Idempotent: a second ask must return the same numbers, or every consumer that derived a
    // URL from the first one is now wrong.
    assert_eq!(ports_of(&fx, "main"), first);
}

#[test]
fn a_preferred_port_inside_the_range_is_honoured() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    assert_eq!(ports_of(&fx, "main")["api"], 14100);
}

#[test]
fn a_preferred_port_outside_the_range_is_ignored_rather_than_widening_it() {
    // Otherwise one `preferred:` quietly opts a project out of the range it configured.
    let fx = Fixture::new();
    fx.write(
        "canopy.yaml",
        "version: 1\nports:\n  api:\n    preferred: 80\nservices:\n  a:\n    run: x ${ports.api}\n",
    );
    let port = ports_of(&fx, "main")["api"].as_u64().unwrap();
    assert_ne!(port, 80);
    assert!((10_000..=19_999).contains(&port), "{port} should be in the default range");
}

#[test]
fn two_branches_get_different_numbers() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    let main = ports_of(&fx, "main");
    let other = ports_of(&fx, "feat/other");
    assert_ne!(main["web"], other["web"]);
    assert_ne!(main["api"], other["api"], "even a preferred port cannot be handed out twice");
}

#[test]
fn the_registry_lists_every_allocation() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    ports_of(&fx, "main");
    ports_of(&fx, "feat/x");

    let out = fx.cwt().args(["ports", "--all", "--json"]).output().unwrap();
    let rows = ok_envelope(&out.stdout)["data"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 4, "two branches × two ports: {rows:?}");
    assert!(rows.iter().all(|row| row["allocated_at"].as_u64().unwrap() > 0));
}

#[test]
fn released_ports_go_back_to_the_pool() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    ports_of(&fx, "main");

    let out = fx.cwt().args(["ports", "main", "--release", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"]["released"], 2);

    let empty = fx.cwt().args(["ports", "--all", "--json"]).output().unwrap();
    assert!(ok_envelope(&empty.stdout)["data"].as_array().unwrap().is_empty());
}

#[test]
fn the_registry_lives_in_the_common_git_dir_so_every_worktree_sees_it() {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", CONFIG)], "add config");
    ports_of(&fx, "main");
    assert!(fx.root.join(".git/canopy/ports.json").is_file());

    // A linked worktree reads the same table rather than starting its own.
    let wt = fx.root.parent().unwrap().join("linked");
    fx.git(["worktree", "add", "-b", "linked", wt.as_str()]);
    let out = fx.cwt_in(&wt).args(["ports", "--all", "--json"]).output().unwrap();
    assert_eq!(ok_envelope(&out.stdout)["data"].as_array().unwrap().len(), 2);
}

#[test]
fn a_repo_with_no_declared_ports_allocates_nothing() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nservices:\n  a:\n    run: x\n");
    let out = fx.cwt().args(["ports", "main", "--json"]).output().unwrap();
    assert!(ok_envelope(&out.stdout)["data"].as_object().unwrap().is_empty());
    // Nothing declared means nothing written; an empty registry file would be noise.
    assert!(!fx.root.join(".git/canopy/ports.json").exists());
}

#[test]
fn ports_defaults_to_the_branch_you_are_standing_on() {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", CONFIG)], "add config");
    let wt = fx.root.parent().unwrap().join("feature");
    fx.git(["worktree", "add", "-b", "feat/here", wt.as_str()]);

    let explicit = ports_of(&fx, "feat/here");
    let implicit = ok_envelope(&fx.cwt_in(&wt).args(["ports", "--json"]).output().unwrap().stdout)["data"].clone();
    assert_eq!(explicit, implicit);
}

// -------------------------------------------------------------------------------------
// env
// -------------------------------------------------------------------------------------

fn dotenv(fx: &Fixture, branch: &str) -> String {
    let out = fx.cwt().args(["env", branch]).output().unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn env_carries_canopys_facts_and_the_allocated_ports() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    let ports = ports_of(&fx, "main");
    let text = dotenv(&fx, "main");

    assert!(text.contains("CANOPY_BRANCH=main"), "{text}");
    // The config names itself `demo`; that is the project's name, not the directory's.
    assert!(text.contains("CANOPY_PROJECT=demo"), "{text}");
    assert!(text.contains(&format!("CANOPY_PORT_WEB={}", ports["web"])), "{text}");
    assert!(text.contains(&format!("CANOPY_PORT_API={}", ports["api"])), "{text}");
}

#[test]
fn env_interpolates_ports_and_other_declared_variables() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    let web = ports_of(&fx, "main")["web"].as_u64().unwrap();
    let text = dotenv(&fx, "main");

    assert!(text.contains(&format!("PUBLIC_URL=http://127.0.0.1:{web}")), "{text}");
    // `${env.BASE}` is another variable in this file, not one from the shell.
    assert!(text.contains("DATA_DIR=/srv/demo/data"), "{text}");
}

#[test]
fn env_output_is_deterministic() {
    // A file that reorders itself shows up as a diff every provision.
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);
    assert_eq!(dotenv(&fx, "main"), dotenv(&fx, "main"));
}

#[test]
fn env_json_masks_secrets_but_the_file_does_not() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", CONFIG);

    let out = fx.cwt().args(["env", "main", "--json"]).output().unwrap();
    let vars = ok_envelope(&out.stdout)["data"].as_array().unwrap().clone();
    let token = vars.iter().find(|v| v["key"] == "API_TOKEN").expect("API_TOKEN present");
    assert!(token["secret"].as_bool().unwrap(), "a key named *_TOKEN is a secret");
    assert_ne!(token["value"], "hunter2", "masking is the point of the json view");

    // Masking is presentation. The file a service reads keeps the real value.
    assert!(dotenv(&fx, "main").contains("hunter2"));
}

#[test]
fn env_export_is_valid_shell() {
    let fx = Fixture::new();
    fx.write(
        "canopy.yaml",
        "version: 1\nenv:\n  SPACED: \"a b\"\n  QUOTED: \"it's\"\n  DOLLAR: \"a $HOME b\"\n  TICK: \"a `x` b\"\n  EMPTY: \"\"\nservices:\n  a:\n    run: x\n",
    );
    let out = fx.cwt().args(["env", "main", "--export"]).output().unwrap();
    let script = String::from_utf8(out.stdout).unwrap();

    // The assertion that matters: a shell must reproduce every value exactly, including the
    // ones containing characters a shell would otherwise act on.
    for (key, expected) in
        [("SPACED", "a b"), ("QUOTED", "it's"), ("DOLLAR", "a $HOME b"), ("TICK", "a `x` b"), ("EMPTY", "")]
    {
        let probe = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("{script}\nprintf %s \"${key}\""))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&probe.stdout), expected, "{key} did not survive the shell");
    }
}

#[test]
fn env_write_produces_the_file_named_by_the_config() {
    let fx = Fixture::new();
    fx.commit(&[("canopy.yaml", CONFIG)], "add config");
    let wt = fx.root.parent().unwrap().join("wt");
    fx.git(["worktree", "add", "-b", "feat/w", wt.as_str()]);

    let out = fx.cwt().args(["env", "feat/w", "--write", "--json"]).output().unwrap();
    let written = ok_envelope(&out.stdout)["data"]["written"].as_str().unwrap().to_owned();
    assert!(written.ends_with(".env.canopy"), "{written}");
    assert!(std::fs::read_to_string(&written).unwrap().contains("CANOPY_BRANCH=feat/w"));

    // Writing twice is byte-identical, so it never shows up as a spurious diff.
    let before = std::fs::read_to_string(&written).unwrap();
    fx.cwt().args(["env", "feat/w", "--write"]).output().unwrap();
    assert_eq!(std::fs::read_to_string(&written).unwrap(), before);
}

#[test]
fn env_file_false_writes_nothing_and_says_so() {
    let fx = Fixture::new();
    fx.write("canopy.yaml", "version: 1\nenv_file: false\nservices:\n  a:\n    run: x\n");
    let out = fx.cwt().args(["env", "main", "--write", "--json"]).output().unwrap();
    // Disabled is a choice, not a failure.
    assert!(out.status.success());
    assert!(ok_envelope(&out.stdout)["data"]["written"].is_null());
}

#[test]
fn env_works_without_a_config_at_all() {
    let fx = Fixture::new();
    let text = dotenv(&fx, "main");
    // Canopy's own facts are always available, even with nothing declared.
    assert!(text.contains("CANOPY_BRANCH=main"), "{text}");
}

#[test]
fn a_detached_worktree_has_no_branch_to_default_to() {
    let fx = Fixture::new();
    let head = fx.git(["rev-parse", "HEAD"]).trim().to_owned();
    let wt = fx.root.parent().unwrap().join("loose");
    fx.git(["worktree", "add", "--detach", wt.as_str(), &head]);

    let out = fx.cwt_in(&wt).args(["ports", "--json"]).output().unwrap();
    // Guessing a branch here would allocate ports to the wrong one.
    err_envelope(&out.stdout, "worktree_not_found");
}
