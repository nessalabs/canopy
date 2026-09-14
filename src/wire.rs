//! The `--json` contract.
//!
//! Every command prints exactly one [`Envelope`] to stdout, success or failure. A consumer
//! tests `ok` and reads `data` or `error`; it never has to inspect the exit code or parse
//! human text. Progress and diagnostics go to *stderr*, so stdout stays pure JSON even when
//! a command is chatty.

use serde::Serialize;

use crate::error::{Error, ErrorCode};

/// Bumped only for a breaking change to the envelope itself, never for new `data` fields.
pub const ENVELOPE_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
pub struct Envelope<T> {
    pub v: u32,
    pub ok: bool,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    /// Always present, even when empty: a consumer can read `.warnings[]` unconditionally.
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl<T: Serialize> Envelope<T> {
    pub fn ok(command: &str, data: T, warnings: Vec<String>) -> Self {
        Envelope { v: ENVELOPE_VERSION, ok: true, command: command.to_owned(), data: Some(data), error: None, warnings }
    }
}

impl Envelope<()> {
    pub fn err(command: &str, error: &Error) -> Self {
        Envelope {
            v: ENVELOPE_VERSION,
            ok: false,
            command: command.to_owned(),
            data: None,
            error: Some(ErrorBody {
                code: error.code().as_str(),
                message: error.to_string(),
                details: error.details(),
            }),
            warnings: Vec::new(),
        }
    }
}

/// Exit status for a failed command; `0` is the caller's business.
pub fn exit_code_for(error: &Error) -> i32 {
    error.code().exit_code()
}

/// Usage errors (bad flags) never reach [`Envelope`] — clap handles them and exits 2.
pub const EXIT_USAGE: i32 = 2;

#[allow(dead_code)]
fn _codes_are_reachable() {
    // Keeps `ErrorCode::ALL` honest: if a variant is added to the enum but not to ALL, the
    // `error_codes_are_exhaustive` test catches it at runtime.
    let _ = ErrorCode::ALL;
}
