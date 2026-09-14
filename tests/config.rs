//! M2: `canopy.yaml` parsing and linting.

use canopy_worktree::config::{self, CanopyConfig, EnvFile, Runtime, Severity, parse_str};

/// Parses and asserts the file is clean, returning the config.
fn valid(text: &str) -> CanopyConfig {
    let parsed = parse_str(text);
    assert!(parsed.is_valid(), "expected a valid config, got errors: {:?}", parsed.errors().collect::<Vec<_>>());
    parsed.config.unwrap()
}

/// Parses and asserts at least one error mentions `needle`.
fn error_mentioning(text: &str, needle: &str) {
    let parsed = parse_str(text);
    assert!(!parsed.is_valid(), "expected an error mentioning {needle:?}, but the config was valid");
    let messages: Vec<String> = parsed.errors().map(|d| format!("{}: {}", d.path, d.message)).collect();
    assert!(messages.iter().any(|m| m.contains(needle)), "no error mentioned {needle:?}; got {messages:?}");
}

fn warning_mentioning(text: &str, needle: &str) {
    let parsed = parse_str(text);
    let messages: Vec<String> = parsed.warnings().map(|d| format!("{}: {}", d.path, d.message)).collect();
    assert!(messages.iter().any(|m| m.contains(needle)), "no warning mentioned {needle:?}; got {messages:?}");
}

// -------------------------------------------------------------------------------------
// The real thing
// -------------------------------------------------------------------------------------

#[test]
fn parses_the_canopy_dogfood_config() {
    // Canopy's own canopy.yaml, verbatim. If this crate cannot read the file that the project
    // it replaces a component of actually ships, nothing else matters.
    let config = valid(include_str!("data/canopy.dogfood.yaml"));

    assert_eq!(config.version, 1);
    assert_eq!(config.name.as_deref(), Some("canopy"));
    assert_eq!(config.ports.len(), 2);
    assert!(config.ports.contains_key("api") && config.ports.contains_key("web"));

    assert_eq!(config.services.len(), 2);
    let web = &config.services["web"];
    assert_eq!(web.depends_on, ["daemon"]);
    assert_eq!(web.cwd.as_deref(), Some("apps/web"));
    assert_eq!(web.ports.as_deref(), Some(["web".to_owned()].as_slice()));
    assert_eq!(web.health.as_ref().unwrap().start_period.to_string(), "10s");
    assert_eq!(config.services["daemon"].health.as_ref().unwrap().start_period.to_string(), "15s");

    // One setup step, gated on the lockfile.
    assert_eq!(config.setup.len(), 1);
    assert_eq!(config.setup[0].name.as_deref(), Some("install"));
    assert_eq!(config.setup[0].run, "npm install");
    assert_eq!(config.setup[0].if_changed.as_deref(), Some(["package-lock.json".to_owned()].as_slice()));

    assert_eq!(config.env["CANOPY_HOME"], "${worktree.path}/.canopy-home");
    assert_eq!(config.env["CANOPY_PORT"], "${ports.api}");
}

#[test]
fn the_dogfood_config_has_no_warnings_either() {
    let parsed = parse_str(include_str!("data/canopy.dogfood.yaml"));
    let warnings: Vec<String> = parsed.warnings().map(|d| format!("{}: {}", d.path, d.message)).collect();
    assert!(warnings.is_empty(), "the shipped config should be exemplary, but: {warnings:?}");
}

// -------------------------------------------------------------------------------------
// Defaults
// -------------------------------------------------------------------------------------

#[test]
fn defaults_match_the_daemons() {
    let config = valid("version: 1\nservices:\n  web:\n    run: sleep 1\n");
    let web = &config.services["web"];

    // Each of these is a default the TypeScript schema applies; a difference here means a
    // config behaves one way in Canopy and another in canopywt.
    assert_eq!(web.restart, config::RestartPolicy::OnFailure);
    assert!(web.autostart);
    assert_eq!(web.stop_signal, "SIGTERM");
    assert_eq!(web.stop_timeout.to_string(), "10s");
    assert_eq!(config.defaults.runtime, Runtime::Host);
    assert_eq!(config.env_file.path(), Some(".env.canopy"));
    assert!(config.databases.is_empty() && config.setup.is_empty());
}

#[test]
fn health_check_defaults() {
    let config = valid(
        "version: 1\nports:\n  web: {}\nservices:\n  web:\n    run: x ${ports.web}\n    health:\n      tcp: \"${ports.web}\"\n",
    );
    let health = config.services["web"].health.as_ref().unwrap();
    assert_eq!(health.interval.to_string(), "3s");
    assert_eq!(health.timeout.to_string(), "3s");
    assert_eq!(health.retries, 10);
    assert_eq!(health.start_period.to_string(), "0ms");
}

#[test]
fn worktree_defaults_to_a_sibling_path() {
    let config = valid("version: 1\n");
    // A worktree nested inside the checkout shows up in every git status, file watcher and rg.
    assert_eq!(config.worktree.path, "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}");
    assert_eq!(config.worktree.base, None);
    assert!(config.copy.is_empty());
}

// -------------------------------------------------------------------------------------
// The polymorphic keys
// -------------------------------------------------------------------------------------

#[test]
fn setup_accepts_a_bare_string_or_an_object() {
    let config = valid("version: 1\nsetup:\n  - npm ci\n  - run: npm run build\n    name: build\n");
    assert_eq!(config.setup[0].run, "npm ci");
    // An unnamed step is addressed by position, 1-based, like the daemon's normalizeSetupStep.
    assert_eq!(config.setup[0].label(0), "step 1");
    assert_eq!(config.setup[1].run, "npm run build");
    assert_eq!(config.setup[1].label(1), "build");
}

#[test]
fn env_file_accepts_a_path_or_false() {
    assert_eq!(valid("version: 1\nenv_file: .env.local\n").env_file.path(), Some(".env.local"));
    let disabled = valid("version: 1\nenv_file: false\n");
    assert!(matches!(disabled.env_file, EnvFile::Disabled(false)));
    assert_eq!(disabled.env_file.path(), None);
}

#[test]
fn env_file_true_is_an_error_because_it_means_nothing() {
    error_mentioning("version: 1\nenv_file: true\n", "means nothing");
}

#[test]
fn tcp_health_accepts_a_number_or_a_template() {
    let numeric = valid("version: 1\nservices:\n  db:\n    run: x\n    health:\n      tcp: 5432\n");
    assert_eq!(numeric.services["db"].health.as_ref().unwrap().tcp.as_ref().unwrap().as_text(), "5432");

    let templated = valid(
        "version: 1\nports:\n  api: {}\nservices:\n  a:\n    run: x ${ports.api}\n    health:\n      tcp: \"${ports.api}\"\n",
    );
    assert_eq!(templated.services["a"].health.as_ref().unwrap().tcp.as_ref().unwrap().as_text(), "${ports.api}");
}

// -------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------

#[test]
fn an_empty_file_says_how_to_start() {
    let parsed = parse_str("   \n\n");
    assert!(!parsed.is_valid());
    assert!(parsed.errors().any(|d| d.message.contains("version: 1")));
}

#[test]
fn a_syntax_error_reports_a_position() {
    let parsed = parse_str("version: one\n");
    assert!(!parsed.is_valid());
    let error = parsed.errors().next().unwrap();
    // The caret snippet serde-saphyr renders is lovely in a terminal and useless in a JSON
    // field, so the position is lifted out structurally and the message stays one line.
    assert_eq!(error.line, Some(1));
    assert_eq!(error.column, Some(10));
    assert!(!error.message.contains('\n'), "message must be one line: {:?}", error.message);
    assert!(!error.message.starts_with("line "), "position should not be repeated in the text: {:?}", error.message);
}

#[test]
fn unknown_port_reference_is_an_error() {
    error_mentioning("version: 1\nservices:\n  web:\n    run: serve ${ports.wbe}\n", "unknown port");
}

#[test]
fn unknown_declared_port_is_an_error() {
    error_mentioning(
        "version: 1\nports:\n  web: {}\nservices:\n  a:\n    run: x\n    ports: [wbe]\n",
        "unknown port `wbe`",
    );
}

#[test]
fn unknown_database_reference_is_an_error() {
    error_mentioning(
        "version: 1\nservices:\n  web:\n    run: serve\n    env:\n      URL: ${db.main.url}\n",
        "unknown database",
    );
}

#[test]
fn a_service_with_nothing_to_run_is_an_error() {
    error_mentioning("version: 1\nservices:\n  web: {}\n", "needs `run:`");
}

#[test]
fn depends_on_an_unknown_service_is_an_error() {
    error_mentioning(
        "version: 1\nservices:\n  web:\n    run: x\n    depends_on: [api]\n",
        "depends_on unknown service",
    );
}

#[test]
fn a_service_depending_on_itself_is_an_error() {
    error_mentioning("version: 1\nservices:\n  web:\n    run: x\n    depends_on: [web]\n", "depends on itself");
}

#[test]
fn a_dependency_cycle_is_an_error_that_names_the_cycle() {
    let text = "version: 1\nservices:\n  a:\n    run: x\n    depends_on: [b]\n  b:\n    run: x\n    depends_on: [a]\n";
    error_mentioning(text, "depends_on cycle");
    // Naming the path is the whole value of the message — "there is a cycle" is not actionable.
    let parsed = parse_str(text);
    assert!(parsed.errors().any(|d| d.message.contains('→')), "the cycle should be spelled out");
}

#[test]
fn health_needs_exactly_one_probe() {
    error_mentioning("version: 1\nservices:\n  a:\n    run: x\n    health:\n      interval: 5s\n", "exactly one of");
    error_mentioning(
        "version: 1\nservices:\n  a:\n    run: x\n    health:\n      cmd: 'true'\n      tcp: 1234\n",
        "exactly one of",
    );
}

#[test]
fn docker_runtime_needs_an_image_or_dockerfile() {
    error_mentioning("version: 1\nservices:\n  a:\n    run: x\n    runtime: docker\n", "docker.image");
    // An empty docker block is as unusable as none at all.
    error_mentioning(
        "version: 1\nservices:\n  a:\n    run: x\n    runtime: docker\n    docker:\n      user: root\n",
        "docker.image",
    );
}

#[test]
fn either_an_image_or_a_dockerfile_satisfies_the_docker_runtime() {
    // The complement: requiring *both* would be just as wrong, and no test above notices.
    valid("version: 1\nservices:\n  a:\n    run: x\n    runtime: docker\n    docker:\n      image: node:22\n");
    valid("version: 1\nservices:\n  a:\n    run: x\n    runtime: docker\n    docker:\n      dockerfile: Dockerfile\n");
}

#[test]
fn docker_and_compose_defaults_are_filled_in() {
    let config = valid(
        "version: 1\nservices:\n  a:\n    run: x\n    runtime: docker\n    docker:\n      image: node:22\n  b:\n    compose:\n      services: [db]\n",
    );
    assert_eq!(config.services["a"].docker.as_ref().unwrap().workdir, "/workspace");
    assert_eq!(config.services["b"].compose.as_ref().unwrap().file, "docker-compose.yml");
}

#[test]
fn a_bad_duration_is_an_error() {
    error_mentioning("version: 1\nservices:\n  a:\n    run: x\n    stop_timeout: 5\n", "duration");
    error_mentioning("version: 1\nservices:\n  a:\n    run: x\n    stop_timeout: 5h\n", "duration");
}

#[test]
fn a_bad_resource_name_is_an_error() {
    error_mentioning("version: 1\nports:\n  Web: {}\n", "lowercase");
    error_mentioning("version: 1\nservices:\n  my.service:\n    run: x\n", "lowercase");
    error_mentioning("version: 1\nports:\n  _lead: {}\n", "lowercase");
    error_mentioning("version: 1\nports:\n  \"-lead\": {}\n", "lowercase");
}

#[test]
fn a_good_resource_name_may_contain_digits_underscores_and_dashes() {
    // The complement of the rule above. Without this, a validator that rejected `_` and `-`
    // outright would still pass every test.
    let config = valid(
        "version: 1\nports:\n  web: {}\n  web2: {}\n  my_port: {}\n  my-port: {}\n  9lives: {}\nservices:\n  a:\n    run: x ${ports.web} ${ports.web2} ${ports.my_port} ${ports.my-port} ${ports.9lives}\n",
    );
    assert_eq!(config.ports.len(), 5);
}

// -------------------------------------------------------------------------------------
// Warnings
// -------------------------------------------------------------------------------------

#[test]
fn an_unknown_key_is_a_warning_not_an_error() {
    // A key this binary does not know may simply be newer than it. Refusing the whole file
    // would be worse than ignoring one line.
    let parsed = parse_str("version: 1\nnonsense: 3\nservices:\n  a:\n    run: x\n");
    assert!(parsed.is_valid(), "unknown keys must not invalidate the config");
    warning_mentioning("version: 1\nnonsense: 3\nservices:\n  a:\n    run: x\n", "unknown key `nonsense`");
}

#[test]
fn a_misspelled_nested_key_is_caught_by_path() {
    // The payoff of checking at every depth: `helth` is the kind of typo that would otherwise
    // be silently dropped and debugged for half an hour.
    let parsed = parse_str("version: 1\nservices:\n  web:\n    run: x\n    helth:\n      tcp: 1\n");
    let warning = parsed.warnings().find(|d| d.message.contains("helth")).expect("nested typo warned");
    assert_eq!(warning.path, "services.web.helth");
}

#[test]
fn an_unreferenced_port_is_a_warning() {
    warning_mentioning(
        "version: 1\nports:\n  idle: {}\nservices:\n  a:\n    run: x\n",
        "not referenced by any service",
    );
}

#[test]
fn no_services_is_a_warning() {
    warning_mentioning("version: 1\n", "nothing will run");
}

#[test]
fn an_unknown_template_scope_is_a_warning() {
    warning_mentioning("version: 1\nservices:\n  a:\n    run: echo ${bogus.thing}\n", "unknown template scope");
}

#[test]
fn a_declared_database_may_be_referenced_without_error() {
    // The other half of "unknown database is an error". Without this, a lint that rejected
    // *every* ${db.…} reference would pass the whole suite.
    let parsed = parse_str(
        "version: 1\ndatabases:\n  main:\n    adapter: postgres\nservices:\n  a:\n    run: x\n    env:\n      URL: ${db.main.url}\n",
    );
    assert!(parsed.is_valid(), "a declared database should resolve: {:?}", parsed.errors().collect::<Vec<_>>());
}

#[test]
fn a_database_may_have_exactly_one_seed_source() {
    // One is fine; two is ambiguous.
    let one = parse_str(
        "version: 1\ndatabases:\n  main:\n    adapter: postgres\n    seed:\n      dump: ./seed.dump\nservices:\n  a:\n    run: x\n",
    );
    assert!(one.is_valid(), "one seed source is fine: {:?}", one.errors().collect::<Vec<_>>());

    error_mentioning(
        "version: 1\ndatabases:\n  main:\n    adapter: postgres\n    seed:\n      dump: ./seed.dump\n      sql: ./seed.sql\nservices:\n  a:\n    run: x\n",
        "one of `dump`",
    );
}

#[test]
fn databases_warn_that_they_are_not_supported_yet() {
    warning_mentioning(
        "version: 1\ndatabases:\n  main:\n    adapter: postgres\nservices:\n  a:\n    run: x\n",
        "not supported by this version",
    );
}

#[test]
fn a_localhost_health_url_warns_about_the_ipv6_trap() {
    // Canopy's own canopy.yaml carries a comment about being burned by this: vite binds
    // 127.0.0.1 while `localhost` resolves to ::1 first on macOS.
    warning_mentioning(
        "version: 1\nports:\n  web: {}\nservices:\n  a:\n    run: x ${ports.web}\n    health:\n      http: http://localhost:${ports.web}/\n",
        "::1",
    );
}

#[test]
fn tabs_are_warned_about_by_name() {
    // YAML's own message for a tab in indentation is obscure enough to be worth calling out.
    let parsed = parse_str("version: 1\nservices:\n\ta:\n\t  run: x\n");
    assert!(parsed.diagnostics.iter().any(|d| d.message.contains("tab")), "got {:?}", parsed.diagnostics);
}

#[test]
fn run_is_ignored_for_a_compose_service() {
    warning_mentioning(
        "version: 1\nservices:\n  a:\n    run: x\n    compose:\n      file: docker-compose.yml\n",
        "ignored for a compose service",
    );
}

// -------------------------------------------------------------------------------------
// Derived facts
// -------------------------------------------------------------------------------------

#[test]
fn service_ports_are_inferred_from_the_run_command() {
    let config = valid("version: 1\nports:\n  web: {}\nservices:\n  a:\n    run: vite --port ${ports.web}\n");
    assert_eq!(config::service_ports(&config.services["a"]), ["web"]);
}

#[test]
fn a_bare_env_port_reference_counts_but_an_embedded_one_does_not() {
    // The distinction that stops two services claiming the same port: `PORT: "${ports.web}"`
    // is this service listening, `API_URL: http://h:${ports.api}` is it talking to another.
    let config = valid(
        "version: 1\nports:\n  web: {}\n  api: {}\nservices:\n  a:\n    run: serve\n    env:\n      PORT: \"${ports.web}\"\n      API_URL: http://127.0.0.1:${ports.api}/\n  b:\n    run: api ${ports.api}\n",
    );
    assert_eq!(config::service_ports(&config.services["a"]), ["web"]);
}

#[test]
fn a_bare_env_port_reference_allows_the_full_name_alphabet() {
    let config = valid(
        "version: 1\nports:\n  my_port: {}\n  my-port: {}\nservices:\n  a:\n    run: serve\n    env:\n      A: \"${ports.my_port}\"\n      B: \"${ports.my-port}\"\n",
    );
    assert_eq!(config::service_ports(&config.services["a"]), ["my-port", "my_port"]);
}

#[test]
fn an_uppercase_env_reference_is_not_a_port_declaration() {
    let config = valid(
        "version: 1\nports:\n  web: {}\nservices:\n  a:\n    run: serve ${ports.web}\n    env:\n      P: \"${ports.WEB}\"\n",
    );
    // Only the real reference counts; the lookalike is left as literal text.
    assert_eq!(config::service_ports(&config.services["a"]), ["web"]);
}

#[test]
fn a_padded_bare_reference_still_counts() {
    let config = valid(
        "version: 1\nports:\n  web: {}\nservices:\n  a:\n    run: serve\n    env:\n      PORT: \"  ${ports.web}  \"\n",
    );
    assert_eq!(config::service_ports(&config.services["a"]), ["web"]);
}

#[test]
fn explicit_ports_override_inference() {
    let config = valid(
        "version: 1\nports:\n  web: {}\n  api: {}\nservices:\n  a:\n    run: serve ${ports.api}\n    ports: [web]\n",
    );
    assert_eq!(config::service_ports(&config.services["a"]), ["web"]);
}

#[test]
fn start_order_is_topological() {
    let config = valid(
        "version: 1\nservices:\n  web:\n    run: x\n    depends_on: [api]\n  api:\n    run: x\n    depends_on: [cache]\n  cache:\n    run: x\n",
    );
    assert_eq!(config::start_order(&config.services, None).unwrap(), ["cache", "api", "web"]);
}

#[test]
fn the_dogfood_config_starts_the_daemon_before_the_web_client() {
    let config = valid(include_str!("data/canopy.dogfood.yaml"));
    assert_eq!(config::start_order(&config.services, None).unwrap(), ["daemon", "web"]);
}

#[test]
fn template_refs_reads_all_three_shapes() {
    let refs = config::template_refs("${ports.web} and ${db.main.url} and ${worktree.path}");
    assert_eq!(refs.len(), 3);
    assert_eq!((refs[0].scope.as_str(), refs[0].name.as_str(), refs[0].field.as_deref()), ("ports", "web", None));
    assert_eq!((refs[1].scope.as_str(), refs[1].name.as_str(), refs[1].field.as_deref()), ("db", "main", Some("url")));
}

#[test]
fn a_reference_name_may_contain_digits_underscores_and_dashes() {
    // Each of these characters is a separate arm of the validator, and a mutation that drops
    // any one of them turns a legitimate reference into invisible literal text.
    for name in ["web", "web2", "my_port", "my-port", "a1_b-c2"] {
        let refs = config::template_refs(&format!("serve ${{ports.{name}}}"));
        assert_eq!(refs.len(), 1, "${{ports.{name}}} should be a reference");
        assert_eq!(refs[0].name, name);
    }
}

#[test]
fn an_env_reference_may_be_uppercase_because_variables_are() {
    // `${env.HOME}` is the obvious thing to write and what the documentation shows. Applying
    // the lowercase resource-name rule here would leave it as silent literal text.
    let refs = config::template_refs("token at ${env.HOME}/.token and ${env.XDG_CONFIG_HOME}");
    assert_eq!(refs.len(), 2);
    assert_eq!((refs[0].scope.as_str(), refs[0].name.as_str()), ("env", "HOME"));
    assert_eq!(refs[1].name, "XDG_CONFIG_HOME");
    // Lowercase still works; some real variables use it.
    assert_eq!(config::template_refs("${env.editor}")[0].name, "editor");
}

#[test]
fn an_env_reference_still_has_to_look_like_a_variable_name() {
    // A leading digit or a dash is not a shell variable, so it is not a reference either.
    assert!(config::template_refs("${env.9lives}").is_empty());
    assert!(config::template_refs("${env.my-var}").is_empty());
    assert!(config::template_refs("${env.}").is_empty());
}

#[test]
fn the_uppercase_exception_does_not_leak_to_other_scopes() {
    // Port, database and service names follow the resource-name rule, so an uppercase one is
    // literal text rather than a reference to something that cannot exist.
    assert!(config::template_refs("${ports.WEB}").is_empty());
    assert!(config::template_refs("${db.MAIN.url}").is_empty());
}

#[test]
fn an_uppercase_reference_is_not_a_reference() {
    // `${ports.WEB}` is shaped like a reference but is not one, and the difference matters:
    // treating it as a reference would report "unknown port WEB" for what is plain text.
    assert!(config::template_refs("serve ${ports.WEB}").is_empty());
    assert!(config::template_refs("serve ${Ports.web}").is_empty());
}

#[test]
fn a_reference_needs_both_a_scope_and_a_name() {
    assert!(config::template_refs("${.web}").is_empty(), "empty scope");
    assert!(config::template_refs("${ports.}").is_empty(), "empty name");
    assert!(config::template_refs("${ports}").is_empty(), "no dot at all");
}

#[test]
fn shell_expansions_are_not_template_refs() {
    // `${CANOPY_HOME}` and `$(cat …)` appear in real run commands; mistaking them for
    // references would produce a flood of bogus "unknown scope" warnings.
    assert!(config::template_refs("${CANOPY_HOME}/token").is_empty());
    assert!(config::template_refs("$(cat \"$CANOPY_HOME/token\")").is_empty());
    assert!(config::template_refs("${}").is_empty());
    assert!(config::template_refs("${a.b.c.d}").is_empty());
}

#[test]
fn counts_match_the_diagnostics_actually_produced() {
    // `version: 1` alone yields exactly two warnings: nothing will run, and no ports are used.
    let parsed = parse_str("version: 1\nports:\n  idle: {}\n");
    assert_eq!(parsed.warning_count(), 2, "got {:?}", parsed.diagnostics);
    assert_eq!(parsed.error_count(), 0);
    assert_eq!(parsed.warning_count(), parsed.warnings().count());
    assert_eq!(parsed.error_count(), parsed.errors().count());
}

#[test]
fn diagnostics_carry_a_severity_that_serializes_lowercase() {
    let parsed = parse_str("version: 1\n");
    let json = serde_json::to_value(&parsed.diagnostics).unwrap();
    assert_eq!(json[0]["severity"], "warning");
    assert!(json[0]["path"].is_string() && json[0]["message"].is_string());
}

#[test]
fn an_unsupported_version_stops_before_the_noise() {
    let parsed = parse_str("version: 2\nservices:\n  a: {}\n");
    // Every other rule assumes the v1 shape, so reporting them too would bury the one thing
    // the user needs to read.
    assert_eq!(parsed.error_count(), 1);
    assert!(parsed.errors().next().unwrap().message.contains("version 1"));
}

#[test]
fn severity_is_comparable_for_callers() {
    assert_ne!(Severity::Error, Severity::Warning);
}

// -------------------------------------------------------------------------------------
// Diagnostic construction and the edges of the reference grammar
// -------------------------------------------------------------------------------------

#[test]
fn a_diagnostic_can_be_given_a_position_after_the_fact() {
    // `at` is how a caller that knows where a finding came from attaches it — the lint pass
    // reports by path, and a consumer with span information can enrich it.
    let plain = config::Diagnostic::warning("services.web", "something");
    assert_eq!((plain.line, plain.column), (None, None));

    let placed = config::Diagnostic::error("services.web", "something").at(12, 5);
    assert_eq!((placed.line, placed.column), (Some(12), Some(5)));
    assert_eq!(placed.severity, Severity::Error);
}

#[test]
fn a_parser_message_without_a_position_is_still_reported() {
    // Positions are lifted out of the parser's own wording, so a message that does not carry
    // one must still become a diagnostic rather than being dropped or mis-parsed.
    struct Bare;
    impl std::fmt::Display for Bare {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("something went wrong with no position at all")
        }
    }
    let diagnostic = config::Diagnostic::from_yaml_error(&Bare);
    assert_eq!((diagnostic.line, diagnostic.column), (None, None));
    assert_eq!(diagnostic.message, "something went wrong with no position at all");
    assert_eq!(diagnostic.path, "<root>");
}

#[test]
fn a_half_written_position_is_not_mistaken_for_one() {
    // "line 3" with no column, and a column that is not a number: both must fall back to no
    // position rather than reporting a wrong one, which would point an editor at the wrong place.
    struct Says(&'static str);
    impl std::fmt::Display for Says {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    for text in ["line 3: something", "line three column four: something", "no position here"] {
        let diagnostic = config::Diagnostic::from_yaml_error(&Says(text));
        assert_eq!(diagnostic.line, None, "{text:?} should not yield a line");
        assert_eq!(diagnostic.column, None, "{text:?} should not yield a column");
    }
}

#[test]
fn an_unclosed_reference_is_literal_text_not_an_error() {
    // `run: echo ${ports.web` is a shell command with a stray brace, and a linter that choked
    // on it would refuse a file that runs perfectly well.
    assert!(config::template_refs("echo ${ports.web").is_empty());
    assert!(config::template_refs("cost: 100${").is_empty());
    // …and a reference after an unclosed one is not found either: there is no closing brace to
    // end the first, so everything after it is inside it.
    assert!(config::template_refs("${unclosed ${ports.web}").len() <= 1);
}

#[test]
fn a_three_segment_reference_needs_all_three_to_be_names() {
    // `${db.main.url}` is the shape; a third segment that is not a name makes the whole thing
    // literal rather than a reference to a field that cannot exist.
    assert_eq!(config::template_refs("${db.main.url}").len(), 1);
    assert!(config::template_refs("${db.main.URL}").is_empty());
    assert!(config::template_refs("${db.main.}").is_empty());
}

#[test]
fn an_empty_resource_name_is_not_a_name() {
    // The empty string reaches `is_resource_name` through a mapping key, and answering "yes"
    // would let a port with no name be declared.
    error_mentioning("version: 1\nports:\n  \"\": {}\n", "lowercase");
}

#[test]
fn a_setup_steps_own_env_is_checked_for_bad_references() {
    // A step's `env:` is as able to name a port that does not exist as its `run:` is.
    error_mentioning(
        "version: 1\nsetup:\n  - name: build\n    run: make\n    env:\n      URL: http://h:${ports.nope}\nservices:\n  a:\n    run: x\n",
        "unknown port",
    );
}

#[test]
fn a_bare_port_reference_must_be_the_whole_value() {
    // `PORT: "${ports.web} "` with padding still counts; `PORT: "x${ports.web}"` does not,
    // because that is a string containing a port rather than the port itself.
    let config = valid(
        "version: 1\nports:\n  web: {}\nservices:\n  a:\n    run: serve ${ports.web}\n    env:\n      PREFIXED: \"x${ports.web}\"\n",
    );
    assert_eq!(config::service_ports(&config.services["a"]), ["web"]);
}

#[test]
fn a_step_whose_command_yaml_read_as_a_boolean_says_how_to_quote_it() {
    // `run: true` is the shell command `true`, and YAML reads it as a boolean. serde's own
    // message names an internal type and offers no fix; this one says what a step may be.
    let parsed = parse_str("version: 1\nsetup:\n  - run: true\nservices:\n  a:\n    run: x\n");
    let message = parsed.errors().next().expect("a type error").message.clone();
    assert!(message.contains("quote it"), "{message}");
    assert!(!message.contains("untagged enum"), "the internal type should not reach the user: {message}");

    // Quoted, it is exactly the command the user meant.
    let quoted = valid("version: 1\nsetup:\n  - run: \"true\"\nservices:\n  a:\n    run: x\n");
    assert_eq!(quoted.setup[0].run, "true");
}

#[test]
fn the_same_advice_covers_the_other_yaml_surprises() {
    // `no` is a boolean and `1.0` is a float in YAML; both are plausible commands.
    for command in ["no", "1.0", "8080"] {
        let parsed = parse_str(&format!("version: 1\nsetup:\n  - run: {command}\nservices:\n  a:\n    run: x\n"));
        assert!(!parsed.is_valid(), "{command} unexpectedly parsed");
        assert!(parsed.errors().next().unwrap().message.contains("quote it"));
    }
}

#[test]
fn a_tab_in_the_indentation_is_warned_about() {
    // YAML's own message for this is obscure enough to be worth naming.
    let parsed = parse_str("version: 1\nservices:\n\ta:\n\t  run: x\n");
    assert!(parsed.diagnostics.iter().any(|d| d.message.contains("tab")), "{:?}", parsed.diagnostics);
}

#[test]
fn a_tab_inside_a_value_is_not_a_mistake() {
    // `A: "has<TAB>tab"` is legitimate content. Warning about it teaches people to ignore the
    // warning, which costs more than it saves.
    let parsed = parse_str("version: 1\nenv:\n  A: \"has\ttab\"\nservices:\n  a:\n    run: x\n");
    assert!(parsed.is_valid(), "{:?}", parsed.errors().collect::<Vec<_>>());
    assert!(
        !parsed.diagnostics.iter().any(|d| d.message.contains("tab")),
        "a tab inside a quoted value was reported as indentation: {:?}",
        parsed.diagnostics
    );
}

#[test]
fn a_tab_after_leading_spaces_is_still_indentation() {
    // Mixed indentation is the same mistake wearing a disguise.
    let parsed = parse_str("version: 1\nenv:\n  \tA: x\nservices:\n  b:\n    run: x\n");
    assert!(parsed.diagnostics.iter().any(|d| d.message.contains("tab")), "{:?}", parsed.diagnostics);
}
