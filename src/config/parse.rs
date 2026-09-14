//! Turning `canopy.yaml` text into a validated [`CanopyConfig`].
//!
//! Three passes, in this order:
//!
//! 1. **Deserialize.** A failure here is a syntax or type error and stops everything — there is
//!    no config to lint.
//! 2. **Unknown keys.** Collected as *warnings*, never errors, at every depth. A key this
//!    binary does not know may simply be newer than it; refusing the whole file over
//!    `services.web.helth` would be worse than saying "you probably meant `health`".
//! 3. **Lint.** The semantic rules a type cannot express: unresolvable `${…}` references,
//!    `depends_on` cycles, a service with nothing to run.
//!
//! The result carries diagnostics whether or not it carries a config, so a caller can render
//! warnings for a file that is perfectly valid.

use serde::Serialize;

use super::{CanopyConfig, Diagnostic, Severity, lint};

/// The outcome of reading a `canopy.yaml`.
#[derive(Debug, Clone, Serialize)]
pub struct Parsed {
    /// `None` when the file could not be understood, or when lint found an error. A caller
    /// that has a config can act on it without checking anything else.
    pub config: Option<CanopyConfig>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Parsed {
    pub fn is_valid(&self) -> bool {
        self.config.is_some()
    }

    pub fn errors(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter().filter(|d| d.severity == Severity::Error)
    }

    pub fn warnings(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter().filter(|d| d.severity == Severity::Warning)
    }

    pub fn error_count(&self) -> usize {
        self.errors().count()
    }

    pub fn warning_count(&self) -> usize {
        self.warnings().count()
    }
}

/// Parses and lints `canopy.yaml` text. Pure: no I/O, so the same call serves a file on disk,
/// a buffer someone is typing, and a test fixture.
pub fn parse_str(text: &str) -> Parsed {
    if text.trim().is_empty() {
        return Parsed {
            config: None,
            diagnostics: vec![Diagnostic::error("<root>", "the file is empty — start with `version: 1`")],
        };
    }

    let mut unknown = Vec::new();
    let result: Result<CanopyConfig, _> = serde_saphyr::with_deserializer_from_str(text, |de| {
        serde_ignored::deserialize(de, |path| unknown.push(path.to_string()))
    });

    let config = match result {
        Ok(config) => config,
        Err(error) => {
            return Parsed { config: None, diagnostics: vec![Diagnostic::from_yaml_error(&error)] };
        }
    };

    let mut diagnostics: Vec<Diagnostic> = unknown
        .into_iter()
        .map(|path| {
            let leaf = path.rsplit('.').next().unwrap_or(&path).to_owned();
            Diagnostic::warning(&path, format!("unknown key `{leaf}` — ignored"))
        })
        .collect();

    // A tab in YAML indentation is legal inside a scalar and illegal as indentation; the
    // parser's message for it is obscure enough to be worth calling out separately.
    if text.lines().any(|line| line.starts_with(['\t', ' ']) && line.contains('\t')) {
        diagnostics.push(Diagnostic::warning("<root>", "tab characters found — YAML indentation must use spaces"));
    }

    diagnostics.extend(lint(&config));
    let valid = !diagnostics.iter().any(|d| d.severity == Severity::Error);
    Parsed { config: valid.then_some(config), diagnostics }
}
