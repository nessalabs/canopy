//! The machine-readable contract: the JSON Schema and the TypeScript bindings.
//!
//! The schema is only worth publishing if it agrees with the parser, and "agrees" has two
//! directions. A file the parser accepts must validate, or a consumer's editor lights up red on
//! a config that works. A file the schema rejects must fail `config check` too, or the schema is
//! stricter than the tool and the red is a lie. Both directions are tested here.

use std::collections::BTreeSet;

use canopy_worktree::config::{self, Duration, TOP_LEVEL_KEYS};
use jsonschema::Validator;
use rstest::rstest;
use serde_json::{Value, json};

/// Where `generated_typescript_covers_every_config_type` writes the bindings.
const TYPES_DIR: &str = "types";

/// Every type reachable from `CanopyConfig`. A new one must be added here — that is what stops
/// the bindings quietly covering less than the schema does.
const CONFIG_TYPES: &[&str] = &[
    "CanopyConfig",
    "ComposeSpec",
    "CopyRule",
    "CopyStrategy",
    "DatabaseSpec",
    "DbAdapter",
    "DbSeed",
    "Defaults",
    "DockerSpec",
    "Duration",
    "EnvFile",
    "HealthCheck",
    "PortSpec",
    "RestartPolicy",
    "Runtime",
    "ServiceSpec",
    "SetupStep",
    "TcpTarget",
    "WorktreeSpec",
];

fn schema() -> Value {
    serde_json::from_str(&config::json_schema()).expect("json_schema() emits JSON")
}

fn validator() -> Validator {
    jsonschema::validator_for(&schema()).expect("the generated schema is a valid JSON Schema")
}

/// The YAML as a JSON document — the *written* file, not the struct it deserializes into.
///
/// Validating the round-tripped struct would only prove `Serialize` and `JsonSchema` agree with
/// each other, which is the easy half. What matters is that the text someone types validates.
fn document(yaml: &str) -> Value {
    serde_saphyr::from_str(yaml).unwrap_or_else(|error| panic!("not YAML: {error}\n{yaml}"))
}

#[track_caller]
fn assert_validates(validator: &Validator, yaml: &str) {
    let instance = document(yaml);
    let errors: Vec<String> = validator.iter_errors(&instance).map(|e| format!("{}: {e}", e.instance_path())).collect();
    assert!(errors.is_empty(), "the parser accepts this but the schema does not: {errors:?}\n{yaml}");
}

// -------------------------------------------------------------------------------------
// The schema accepts everything the parser does
// -------------------------------------------------------------------------------------

/// The real configs, plus the file `canopywt config init` hands a new user.
#[rstest]
#[case("tests/data/canopy.dogfood.yaml", include_str!("data/canopy.dogfood.yaml"))]
#[case("config::STARTER", config::STARTER)]
fn every_valid_fixture_validates_against_the_schema(#[case] name: &str, #[case] yaml: &str) {
    let parsed = config::parse_str(yaml);
    assert!(parsed.is_valid(), "{name} does not parse: {:?}", parsed.errors().collect::<Vec<_>>());
    assert_validates(&validator(), yaml);
}

/// The shapes the fixtures happen not to use. Each one is a place the derived schema would have
/// been wrong, so each one is a place a hand-written impl has to be right.
#[rstest]
// A bare string setup step, which the hand-written `Deserialize` accepts and the derive does not.
#[case("version: 1\nsetup:\n  - npm ci\nservices:\n  app:\n    run: serve\n")]
// And the object form, in the same file as the bare one.
#[case(
    "version: 1\nsetup:\n  - npm ci\n  - run: npm run build\n    cwd: apps/web\nservices:\n  app:\n    run: serve\n"
)]
// `env_file: false`, the boolean branch of an untagged enum.
#[case("version: 1\nenv_file: false\nservices:\n  app:\n    run: serve\n")]
// A literal port, the integer branch of another one.
#[case("version: 1\nservices:\n  app:\n    run: serve\n    health:\n      tcp: 5432\n")]
// The same key as a template string.
#[case(
    "version: 1\nports:\n  web: {}\nservices:\n  app:\n    run: serve ${ports.web}\n    health:\n      tcp: \"${ports.web}\"\n"
)]
// Every duration unit, on every key that takes one.
#[case(
    "version: 1\nservices:\n  app:\n    run: serve\n    stop_timeout: 2m\n    health:\n      cmd: \"true\"\n      interval: 500ms\n      timeout: 5s\n      start_period: 0ms\n"
)]
// A port range, which is a fixed-length tuple rather than a list.
#[case(
    "version: 1\nports:\n  web:\n    range: [9000, 9100]\n    preferred: 9000\nservices:\n  app:\n    run: serve ${ports.web}\n"
)]
// Every enum spelling, including the kebab-case one.
#[case(
    "version: 1\ncopy:\n  - pattern: .env\n    strategy: symlink\nservices:\n  app:\n    run: serve\n    restart: always\n    runtime: host\n"
)]
fn every_shape_the_parser_accepts_validates_against_the_schema(#[case] yaml: &str) {
    let parsed = config::parse_str(yaml);
    assert!(parsed.is_valid(), "the case itself does not parse: {:?}", parsed.errors().collect::<Vec<_>>());
    assert_validates(&validator(), yaml);
}

// -------------------------------------------------------------------------------------
// …and rejects nothing the parser would let through
// -------------------------------------------------------------------------------------

#[rstest]
// A version that is not a number at all.
#[case("version: one\n")]
// The only version there is.
#[case("version: 2\nservices:\n  app:\n    run: serve\n")]
// Hours are not in the grammar; a file that worked here and failed in Canopy would be worse.
#[case("version: 1\nservices:\n  app:\n    run: serve\n    stop_timeout: 5h\n")]
// A bare number is ambiguous between milliseconds and seconds, so neither side guesses.
#[case("version: 1\nservices:\n  app:\n    run: serve\n    health:\n      cmd: \"true\"\n      interval: 5\n")]
// An unknown enum value, as opposed to an unknown *key*, which is only a warning.
#[case("version: 1\nservices:\n  app:\n    run: serve\n    restart: sometimes\n")]
#[case("version: 1\ncopy:\n  - pattern: .env\n    strategy: hardlink\n")]
#[case("version: 1\ndatabases:\n  main:\n    adapter: mongodb\n")]
// `env_file: true` looks like it means something and does not.
#[case("version: 1\nenv_file: true\nservices:\n  app:\n    run: serve\n")]
// Neither branch of an untagged enum.
#[case("version: 1\nservices:\n  app:\n    run: serve\n    health:\n      tcp: [5432]\n")]
// Neither branch of the setup step.
#[case("version: 1\nsetup:\n  - [npm, ci]\nservices:\n  app:\n    run: serve\n")]
// `run` is the one required key of the object form.
#[case("version: 1\nsetup:\n  - cwd: apps/web\nservices:\n  app:\n    run: serve\n")]
fn a_config_the_schema_rejects_is_also_rejected_by_the_parser(#[case] yaml: &str) {
    let instance = document(yaml);
    assert!(!validator().is_valid(&instance), "the schema accepts this: {yaml}");
    assert!(!config::parse_str(yaml).is_valid(), "the schema rejects this but the parser does not: {yaml}");
}

/// The one disagreement, pinned so it cannot change without someone noticing.
///
/// `serde-saphyr` coerces a quoted scalar to the field's type, so `version: "1"` parses as the
/// number 1. JSON has no such coercion, and a schema that called a string an integer would be
/// lying about JSON to describe a YAML quirk — so the schema is the stricter of the two here.
#[test]
fn a_quoted_number_is_where_the_schema_is_stricter_than_the_parser() {
    let yaml = "version: \"1\"\n";
    assert!(config::parse_str(yaml).is_valid(), "the parser coerces a quoted scalar");
    assert!(!validator().is_valid(&document(yaml)), "the schema does not");
}

// -------------------------------------------------------------------------------------
// Structure
// -------------------------------------------------------------------------------------

#[test]
fn the_schema_documents_every_top_level_key() {
    let schema = schema();
    let properties = schema["properties"].as_object().expect("an object schema has properties");

    let described: BTreeSet<&str> = properties.keys().map(String::as_str).collect();
    let expected: BTreeSet<&str> = TOP_LEVEL_KEYS.iter().copied().collect();
    assert_eq!(described, expected, "the schema and TOP_LEVEL_KEYS disagree about what may appear at the top level");

    // A key with no prose is a key a consumer has to guess at, which is the thing this file
    // exists to stop.
    for (key, value) in properties {
        let description = value["description"].as_str().unwrap_or_default();
        assert!(!description.is_empty(), "`{key}` has no description — give the field a doc comment");
    }

    assert_eq!(schema["title"], "canopy.yaml", "the doc-comment heading becomes the schema title");
    assert!(schema["description"].as_str().is_some_and(|d| !d.is_empty()));
    assert_eq!(schema["required"], json!(["version"]), "`version` is the only key a file must carry");
}

/// The same table `Duration::parse`'s own tests use, driven through the schema's `pattern`.
///
/// The two are separate implementations of one grammar, so a change to either that the other
/// does not follow shows up here rather than in a user's editor.
#[rstest]
#[case("500ms", true)]
#[case("0ms", true)]
#[case("5s", true)]
#[case("0s", true)]
#[case("2m", true)]
#[case("90s", true)]
#[case("5", false)]
#[case("5h", false)]
#[case("", false)]
#[case("s", false)]
#[case("ms", false)]
#[case("-5s", false)]
#[case("+5s", false)]
#[case("5 s", false)]
#[case("5.5s", false)]
#[case("five", false)]
#[case("5sec", false)]
fn the_duration_pattern_accepts_what_the_parser_accepts_and_rejects_what_it_rejects(
    #[case] text: &str,
    #[case] accepted: bool,
) {
    assert_eq!(Duration::parse(text).is_ok(), accepted, "the parser disagrees with the table for {text:?}");

    let instance = json!({"version": 1, "services": {"app": {"run": "serve", "stop_timeout": text}}});
    assert_eq!(validator().is_valid(&instance), accepted, "the schema disagrees with the parser for {text:?}");
}

#[test]
fn the_schema_is_stable() {
    // The schema is a published contract: a change to it should arrive as a reviewed diff, not
    // as a surprise in somebody's editor after an unrelated refactor.
    insta::assert_snapshot!(config::json_schema());
}

// -------------------------------------------------------------------------------------
// TypeScript
// -------------------------------------------------------------------------------------

#[test]
fn generated_typescript_covers_every_config_type() {
    // Cleared first, so this asserts on what *this* run emitted rather than on whatever a
    // previous one left behind — and so a type that stops being generated is noticed.
    match std::fs::remove_dir_all(TYPES_DIR) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("{TYPES_DIR}: {error}"),
    }

    // Emitting here rather than from a `#[ts(export)]` unit test: this test then holds whether
    // or not the lib's own test binary ran first, and `cargo test --test schema` works alone.
    config::schema::export_typescript(TYPES_DIR).expect("bindings are written to types/");

    for name in CONFIG_TYPES {
        let path = format!("{TYPES_DIR}/{name}.ts");
        let source = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
        assert!(source.contains(name), "{path} does not declare {name}");
    }

    // The shapes that are not the struct the derive sees. Without these the bindings would be
    // the eyeballed zod schemas over again, just in a different language.
    let duration = std::fs::read_to_string(format!("{TYPES_DIR}/Duration.ts")).unwrap();
    assert!(duration.contains("string"), "Duration serializes as `5s`, not as a millisecond count: {duration}");

    let env_file = std::fs::read_to_string(format!("{TYPES_DIR}/EnvFile.ts")).unwrap();
    assert!(env_file.contains("boolean") && env_file.contains("string"), "EnvFile is a path or `false`: {env_file}");

    let tcp = std::fs::read_to_string(format!("{TYPES_DIR}/TcpTarget.ts")).unwrap();
    assert!(tcp.contains("number") && tcp.contains("string"), "TcpTarget is a port or a template: {tcp}");
}
