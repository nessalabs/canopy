//! Machine-readable descriptions of `canopy.yaml`, for programs rather than people.
//!
//! Two artefacts, one source of truth — the types in [`super`]:
//!
//! - [`json_schema`] emits JSON Schema 2020-12, so an editor, a CI job or another tool can
//!   validate a `canopy.yaml` without owning a YAML parser or a table of defaults.
//! - with the `ts` feature, `export_typescript` writes TypeScript bindings. `@canopy/shared`
//!   hand-maintains zod schemas that have to match these structs by eyeball; a generated type
//!   removes that class of drift.
//!
//! The hand-written [`JsonSchema`] impls live here rather than beside their types because they
//! all exist for one reason — the file accepts a *wider* shape than the Rust type describes —
//! and that disagreement is easier to review when it is in one place.
//!
//! The schema deliberately does **not** set `additionalProperties: false`. The parser treats an
//! unknown key as a warning, never an error, because it may simply be newer than this binary;
//! a schema that rejected the file outright would contradict that.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, schema_for};

use super::{CanopyConfig, Duration, EnvFile, TcpTarget};

/// The JSON Schema for `canopy.yaml`, as a pretty-printed string.
///
/// JSON Schema 2020-12. Ends with a newline, so `… > canopy.schema.json` is a well-formed text
/// file rather than one git complains about.
pub fn json_schema() -> String {
    let mut text = serde_json::to_string_pretty(&schema_for!(CanopyConfig)).expect("a schema always serializes");
    text.push('\n');
    text
}

/// Writes the TypeScript bindings for every `canopy.yaml` type into `dir`, one file per type.
///
/// Behind a feature because `ts-rs` is a codegen tool: a program that links this crate to read a
/// config should not have to compile it. `tests/schema.rs` turns the feature on and calls this.
#[cfg(feature = "ts")]
pub fn export_typescript(dir: impl AsRef<std::path::Path>) -> Result<(), ts_rs::ExportError> {
    use ts_rs::TS;

    <CanopyConfig as TS>::export_all(&ts_rs::Config::new().with_out_dir(dir.as_ref()))
}

/// `"500ms"`, `"5s"`, `"2m"`.
///
/// Hand-written because [`Duration`] is a `u64` that serializes as a string: the derive would
/// describe the millisecond count, which is not what anyone writes in the file. The pattern is
/// [`Duration::parse`](super::Duration::parse)'s grammar, and `tests/schema.rs` drives the same
/// table of spellings through both.
impl JsonSchema for Duration {
    fn schema_name() -> Cow<'static, str> {
        "Duration".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "type": "string",
            "description": "A duration: digits followed by one of the units `ms`, `s` or `m` — `500ms`, `5s`, `2m`. \
                            A bare number is an error rather than a guess, and `h` is not a unit.",
            "pattern": r"^\d+(ms|s|m)$",
        })
    }
}

/// `env_file: .env.canopy` or `env_file: false`.
///
/// Hand-written for `oneOf`: `schemars` emits `anyOf` for every untagged enum, since variants
/// can overlap in general. These two cannot, and `oneOf` is what says so.
impl JsonSchema for EnvFile {
    fn schema_name() -> Cow<'static, str> {
        "EnvFile".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "description": "The dotenv written into each worktree, with every reference already resolved.",
            "oneOf": [
                {
                    "type": "string",
                    "description": "Path to write, relative to the worktree root. Defaults to `.env.canopy`.",
                },
                {
                    // `const: false` rather than a bare boolean, so an editor flags `env_file: true`
                    // at the same moment `config check` would: it looks like it means something
                    // and does not.
                    "type": "boolean",
                    "const": false,
                    "description": "`false` disables it — no dotenv is written.",
                },
            ],
        })
    }
}

/// `tcp: 5432` or `tcp: "${ports.api}"`.
///
/// Hand-written for the same reason as [`EnvFile`]: an untagged enum derives to `anyOf`, and a
/// number is never a string.
impl JsonSchema for TcpTarget {
    fn schema_name() -> Cow<'static, str> {
        "TcpTarget".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({
            "description": "A port on localhost to connect to.",
            "oneOf": [
                {
                    // The bounds are `u16`'s, not "a plausible port": a schema that rejected
                    // `tcp: 0` would reject a file the parser accepts.
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 65535,
                    "description": "A literal port number.",
                },
                {
                    "type": "string",
                    "description": "A `${ports.x}` reference, resolved per worktree.",
                },
            ],
        })
    }
}

/// Widens the derived [`SetupStep`](super::SetupStep) object into `oneOf: [string, object]`.
///
/// `setup: [npm ci]` is the overwhelmingly common case and the hand-written `Deserialize`
/// accepts it, but the derive only ever sees the struct — which is the normalised form, not the
/// form people write. Applied by `#[schemars(transform = …)]` so the object half stays
/// generated: the fields, their types and their doc comments are never restated here.
pub(super) fn a_step_may_be_a_bare_command(schema: &mut Schema) {
    let mut object = core::mem::take(schema);
    // The struct's doc comment describes the Rust type and the TypeScript binding it generates;
    // it would read oddly on one branch of a `oneOf` whose other branch is a bare string. The
    // prose for the schema is written below, on the key itself.
    object.remove("description");

    let object = object.to_value();
    *schema = schemars::json_schema!({
        "description": "A command run once when a worktree is provisioned. `- npm ci` and the object form mean the same thing.",
        "oneOf": [
            {
                "type": "string",
                "description": "The shell command to run, with every other key left at its default.",
            },
            object,
        ],
    });
}
