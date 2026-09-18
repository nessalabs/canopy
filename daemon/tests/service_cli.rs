//! M8 through the CLI: starting, reporting and stopping a worktree's services.
//!
//! These drive the real binary against real processes, because the promise being tested — that
//! a service outlives the command that started it — cannot be observed any other way.

mod fixture;

use fixture::{Fixture, err_envelope, ok_envelope};

/// A worktree whose services are `sh` loops we can see in `ps`.
fn prepared(services: &str) -> (Fixture, camino::Utf8PathBuf) {
    let fx = Fixture::new();
    let config = format!(
        "version: 1\nworktree:\n  path: \"{{{{ repo_path }}}}/../wt/{{{{ name }}}}\"\nports:\n  web: {{}}\nservices:\n{services}"
    );
    fx.commit(&[("canopy.yaml", &config)], "add config");
    fx.cwt().args(["new", "feat/x"]).output().unwrap();
    let worktree = fx.root.parent().unwrap().join("wt/feat-x");
    (fx, worktree)
}

fn run(fx: &Fixture, args: &[&str]) -> serde_json::Value {
    let out = fx.cwt().args(args).arg("--json").output().unwrap();
    assert!(out.status.success(), "{args:?} failed: {}", String::from_utf8_lossy(&out.stdout));
    ok_envelope(&out.stdout)["data"].clone()
}

/// A sleep duration unique to this test process, so `ps` can find our children and nobody
/// else's. A shell comment would be tidier but `sh` strips it before `ps` ever sees the
/// command line, which is exactly the kind of marker that silently matches nothing.
///
/// The tag is hashed rather than summed: `outlives` and `run-fg` add up to the same bytes, and
/// two tests sharing a duration count each other's sleepers — invisibly, until one of them
/// fails before its `down` and leaks a process into the other's assertion.
fn marker(tag: &str) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    tag.hash(&mut hasher);
    format!("{}", 1_000_000 + u64::from(std::process::id() % 1_000) * 1_000 + hasher.finish() % 1_000)
}

/// The command that sleeps for that distinctive duration.
fn sleeper(marker: &str) -> String {
    format!("sleep {marker}")
}

/// How many `sleep <marker>` processes are alive. Only the `sleep` itself is counted, not the
/// `sh -c` that started it: macOS's shell execs a lone command, so the wrapper disappears, but
/// dash on Linux stays as the parent with the same text on its command line — the service is
/// one process on one platform and two on the other, and this counts the same thing on both.
fn processes_matching(needle: &str) -> usize {
    let needle = &format!("sleep {needle}");
    let out = std::process::Command::new("ps").args(["-ax", "-o", "command"]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).lines().filter(|line| line.trim_start().starts_with(needle)).count()
}

fn stop_all(fx: &Fixture) {
    let _ = fx.cwt().args(["down", "feat/x"]).output();
}

#[test]
fn up_starts_a_service_and_ps_reports_it_running() {
    let tag = marker("basic");
    let sleep = sleeper(&tag);
    let (fx, _wt) = prepared(&format!("  web:\n    run: {sleep}\n"));

    let started = run(&fx, &["up", "feat/x", "--no-wait"]);
    assert_eq!(started[0]["name"], "web");
    assert_eq!(started[0]["state"], "running");
    let pid = started[0]["pid"].as_i64().expect("a running service has a pid");

    let listed = run(&fx, &["ps", "feat/x"]);
    assert_eq!(listed[0]["state"], "running");
    assert_eq!(listed[0]["pid"], pid, "ps must find the same process");
    assert!(listed[0]["uptime_ms"].as_u64().is_some());

    stop_all(&fx);
}

#[test]
fn up_is_idempotent() {
    let tag = marker("idempotent");
    let sleep = sleeper(&tag);
    let (fx, _wt) = prepared(&format!("  web:\n    run: {sleep}\n"));

    let first = run(&fx, &["up", "feat/x", "--no-wait"]);
    let second = run(&fx, &["up", "feat/x", "--no-wait"]);

    // Same pid, and only one process: a second `up` must not double-start.
    assert_eq!(first[0]["pid"], second[0]["pid"]);
    assert_eq!(processes_matching(&tag), 1, "a second up spawned another process");

    stop_all(&fx);
}

#[test]
fn the_service_outlives_the_command_that_started_it() {
    // The no-daemon promise. `canopywt up` has fully exited by the time this asserts.
    let tag = marker("outlives");
    let sleep = sleeper(&tag);
    let (fx, _wt) = prepared(&format!("  web:\n    run: {sleep}\n"));

    run(&fx, &["up", "feat/x", "--no-wait"]);
    assert_eq!(processes_matching(&tag), 1, "the service did not survive the parent");

    stop_all(&fx);
    assert_eq!(processes_matching(&tag), 0);
}

#[test]
fn down_kills_the_whole_process_group() {
    // A shell that backgrounds a child: killing only the shell would orphan the child for two
    // minutes. This is the bug process groups exist to prevent.
    let tag = marker("group");
    let (bg, fg) = (sleeper(&tag), sleeper(&tag));
    let (fx, _wt) = prepared(&format!("  web:\n    run: {bg} &\n      {fg}\n"));

    run(&fx, &["up", "feat/x", "--no-wait"]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while processes_matching(&tag) < 2 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert!(processes_matching(&tag) >= 2, "the children never started");

    run(&fx, &["down", "feat/x"]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while processes_matching(&tag) > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(processes_matching(&tag), 0, "a child survived down");
}

#[test]
fn a_command_that_fails_instantly_is_not_reported_running() {
    // Reporting `running` for something that already exited is the most annoying possible lie.
    let (fx, _wt) = prepared("  web:\n    run: exit 7\n");
    let started = run(&fx, &["up", "feat/x", "--no-wait"]);
    assert_ne!(started[0]["state"], "running", "{started}");
}

#[test]
fn services_start_in_dependency_order() {
    let (fx, wt) = prepared(
        "  api:\n    run: echo api >> ../order.txt\n    depends_on: [cache]\n  cache:\n    run: echo cache >> ../order.txt\n",
    );
    run(&fx, &["up", "feat/x", "--no-wait"]);

    let order_file = wt.parent().unwrap().join("order.txt");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::fs::read_to_string(&order_file).map(|t| t.lines().count() < 2).unwrap_or(true)
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let order = std::fs::read_to_string(&order_file).unwrap_or_default();
    assert!(order.starts_with("cache"), "a dependency must start first: {order:?}");

    stop_all(&fx);
}

#[test]
fn only_starts_the_named_service() {
    let web_tag = marker("only-web");
    let api_tag = marker("only-api");
    let (web, api) = (sleeper(&web_tag), sleeper(&api_tag));
    let (fx, _wt) = prepared(&format!("  web:\n    run: {web}\n  api:\n    run: {api}\n"));

    run(&fx, &["up", "feat/x", "--only", "api", "--no-wait"]);
    assert_eq!(processes_matching(&api_tag), 1);
    assert_eq!(processes_matching(&web_tag), 0, "an unnamed service was started");

    stop_all(&fx);
}

#[test]
fn autostart_false_is_left_alone() {
    let tag = marker("autostart");
    let sleep = sleeper(&tag);
    let (fx, _wt) = prepared(&format!("  web:\n    run: {sleep}\n    autostart: false\n"));
    run(&fx, &["up", "feat/x", "--no-wait"]);
    assert_eq!(processes_matching(&tag), 0, "autostart: false was started anyway");
    stop_all(&fx);
}

#[test]
fn a_docker_service_is_reported_unsupported_rather_than_silently_skipped() {
    // Pretending to start something we cannot start is worse than saying so.
    let (fx, _wt) = prepared("  web:\n    runtime: docker\n    run: true\n    docker:\n      image: nginx\n");
    let started = run(&fx, &["up", "feat/x", "--no-wait"]);
    assert_eq!(started[0]["state"], "unsupported", "{started}");
}

#[test]
fn the_run_command_sees_its_allocated_port() {
    let (fx, wt) = prepared("  web:\n    run: echo ${ports.web} > port.txt\n");
    run(&fx, &["up", "feat/x", "--no-wait"]);

    let file = wt.join("port.txt");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !file.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let written = std::fs::read_to_string(&file).unwrap_or_default();
    let allocated = run(&fx, &["ports", "feat/x"])["web"].as_u64().unwrap();
    assert_eq!(written.trim(), allocated.to_string(), "the run command was not interpolated");
}

#[test]
fn logs_capture_what_a_service_printed() {
    let (fx, _wt) = prepared("  web:\n    run: echo 'hello from the service'; echo 'and stderr' >&2; sleep 120\n");
    run(&fx, &["up", "feat/x", "--no-wait"]);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut lines: Vec<String> = Vec::new();
    while std::time::Instant::now() < deadline {
        lines = serde_json::from_value(run(&fx, &["logs", "web", "feat/x"])).unwrap_or_default();
        if lines.len() >= 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // Both streams land in the one log, which is what you want when reading why something died.
    assert!(lines.iter().any(|l| l.contains("hello from the service")), "{lines:?}");
    assert!(lines.iter().any(|l| l.contains("and stderr")), "{lines:?}");

    stop_all(&fx);
}

#[test]
fn down_on_a_worktree_with_nothing_running_is_not_an_error() {
    let (fx, _wt) = prepared("  web:\n    run: sleep 120\n");
    let out = fx.cwt().args(["down", "feat/x", "--json"]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
}

#[test]
fn ps_on_a_branch_with_no_checkout_says_so() {
    let (fx, _wt) = prepared("  web:\n    run: sleep 120\n");
    let out = fx.cwt().args(["ps", "feat/absent", "--json"]).output().unwrap();
    err_envelope(&out.stdout, "worktree_not_found");
}

#[test]
fn removing_a_worktree_stops_its_services_and_releases_its_ports() {
    // Otherwise a dev server keeps writing into a deleted directory, and the registry
    // accumulates rows for worktrees that no longer exist until the range is exhausted.
    let tag = marker("rm");
    let sleep = sleeper(&tag);
    let (fx, _wt) = prepared(&format!("  web:\n    run: {sleep}\n"));
    run(&fx, &["up", "feat/x", "--no-wait"]);
    run(&fx, &["ports", "feat/x"]);
    assert_eq!(processes_matching(&tag), 1);

    let removed = run(&fx, &["rm", "feat/x", "--force", "--delete-branch", "always"]);
    assert_eq!(removed["ports_released"], 1, "{removed}");
    assert_eq!(removed["services_stopped"], serde_json::json!(["web"]), "{removed}");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while processes_matching(&tag) > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(processes_matching(&tag), 0, "the service outlived its worktree");
    assert!(run(&fx, &["ports", "--all"]).as_array().unwrap().is_empty());
}

#[test]
fn run_supervises_in_the_foreground_and_shuts_down_cleanly() {
    // `run` is the only place restart policy lives, and the only one that blocks. The promise
    // it must keep is the mirror of `up`'s: nothing survives it.
    let bg = marker("run-bg");
    let fg = marker("run-fg");
    let (fx, _wt) = prepared(&format!("  grand:\n    run: {} &\n      {}\n", sleeper(&bg), sleeper(&fg)));

    let mut child = fx
        .cwt()
        .args(["run", "feat/x", "--no-restart"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn run");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while (processes_matching(&bg) == 0 || processes_matching(&fg) == 0) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if processes_matching(&bg) == 0 || processes_matching(&fg) == 0 {
        let _ = child.kill();
        let out = child.wait_with_output().expect("wait");
        panic!(
            "children never started.\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // SIGINT is what Ctrl-C sends; it must reach a supervisor that may be asleep between polls.
    unsafe_free_sigint(child.id());

    let status = wait_with_timeout(&mut child, std::time::Duration::from_secs(20)).expect("run exited");
    assert!(status.success(), "a clean shutdown is a clean exit");

    // The whole point: a backgrounded grandchild does not outlive the supervisor.
    //
    // The ceiling is generous because shutdown is SIGTERM and then SIGKILL a `stop_timeout`
    // later, and a busy machine stretches both. The poll returns the moment the children are
    // gone, so this costs nothing when the machine is idle — and a tight bound here fails for
    // load rather than for a child that actually survived.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while (processes_matching(&bg) > 0 || processes_matching(&fg) > 0) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(processes_matching(&bg), 0, "a backgrounded grandchild outlived the supervisor");
    assert_eq!(processes_matching(&fg), 0, "a child outlived the supervisor");
}

/// SIGINT without `unsafe`: `kill` the way a shell does it.
fn unsafe_free_sigint(pid: u32) {
    std::process::Command::new("kill").args(["-INT", &pid.to_string()]).status().expect("kill");
}

fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait().expect("try_wait") {
            Some(status) => return Some(status),
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                return None;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}
