//! The checks a type cannot express.
//!
//! Port of `lintConfig` in `packages/shared/src/canopy-yaml.ts`, rule for rule, so a file the
//! daemon accepts is accepted here and vice versa. Errors mean "this cannot run"; warnings mean
//! "this will run, and probably not the way you meant".

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::{CanopyConfig, EnvFile, Runtime, ServiceSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// One finding, addressed to a place in the file.
///
/// `path` is a dotted key path (`services.web.ports`) rather than a byte offset, so it is
/// meaningful even for a rule derived from several places at once. `line`/`column` are filled
/// in where the parser gave us a position, which lets an editor underline rather than list.
#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: Severity,
    /// Dotted path to the offending key, or `<root>` for a whole-file finding.
    pub path: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

impl Diagnostic {
    pub fn error(path: &str, message: impl Into<String>) -> Diagnostic {
        Diagnostic {
            severity: Severity::Error,
            path: path.to_owned(),
            message: message.into(),
            line: None,
            column: None,
        }
    }

    pub fn warning(path: &str, message: impl Into<String>) -> Diagnostic {
        Diagnostic {
            severity: Severity::Warning,
            path: path.to_owned(),
            message: message.into(),
            line: None,
            column: None,
        }
    }

    /// A parser failure, with the position it reported.
    ///
    /// serde-saphyr renders a multi-line snippet with a caret; that is lovely in a terminal and
    /// wrong in a JSON field, so the first line becomes the message and the position is lifted
    /// out into `line`/`column` where a consumer can use it.
    pub fn from_yaml_error(error: &impl std::fmt::Display) -> Diagnostic {
        let text = error.to_string();
        let first = text.lines().next().unwrap_or(&text).trim_start_matches("error: ").to_owned();
        let (line, column) = parse_position(&first);
        // Strip the redundant "line N column M: " prefix once it is captured structurally.
        let message = match (line, column) {
            (Some(l), Some(c)) => first.strip_prefix(&format!("line {l} column {c}: ")).unwrap_or(&first).to_owned(),
            _ => first,
        };
        Diagnostic { severity: Severity::Error, path: "<root>".to_owned(), message, line, column }
    }

    pub fn at(mut self, line: u32, column: u32) -> Diagnostic {
        self.line = Some(line);
        self.column = Some(column);
        self
    }
}

/// Reads `line 3 column 12: …` out of a parser message.
fn parse_position(text: &str) -> (Option<u32>, Option<u32>) {
    let rest = match text.strip_prefix("line ") {
        Some(rest) => rest,
        None => return (None, None),
    };
    let (line, rest) = match rest.split_once(" column ") {
        Some(pair) => pair,
        None => return (None, None),
    };
    let column = rest.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("");
    (line.parse().ok(), column.parse().ok())
}

/// A `${scope.name.field}` reference found in a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateRef {
    pub scope: String,
    pub name: String,
    pub field: Option<String>,
}

/// Every `${…}` reference in `text`.
///
/// Hand-written rather than a regex dependency: the grammar is `${scope.name}` or
/// `${scope.name.field}` with lowercase-ish identifiers, and a malformed one is simply not a
/// reference (it stays in the string verbatim, which is what interpolation does too).
pub fn template_refs(text: &str) -> Vec<TemplateRef> {
    let mut refs = Vec::new();
    let mut rest = text;
    // Index arithmetic would say the same thing, but every offset is a place to be off by one
    // and there is no way to write a test that proves you were not.
    while let Some((_, after_open)) = rest.split_once("${") {
        let Some((inner, tail)) = after_open.split_once('}') else { break };
        rest = tail;
        if let Some(reference) = parse_ref(inner) {
            refs.push(reference);
        }
    }
    refs
}

/// The inside of a `${…}`, if it is a reference at all.
///
/// Scopes and most names are lowercase `[a-z0-9_-]`, matching the rule for port, database and
/// service names. `${CANOPY_HOME}` and `${ports.WEB}` are shaped like references but are not
/// ones — they are shell expansions or literal text, and reporting "unknown port WEB" for them
/// would be worse than useless.
///
/// `${env.PATH}` is the exception: environment variable names are uppercase by universal
/// convention, so the `env` scope accepts them. Without this `${env.HOME}` — the obvious thing
/// to write, and what the documentation shows — would silently stay literal text.
fn parse_ref(inner: &str) -> Option<TemplateRef> {
    let mut parts = inner.split('.');
    let scope = parts.next().filter(|part| is_ref_segment(part))?;
    let name_rule = if scope == ENV_SCOPE { is_env_name } else { is_ref_segment };
    let name = parts.next().filter(|part| name_rule(part))?;
    let field = match parts.next() {
        Some(field) => Some(field.to_owned()).filter(|part| is_ref_segment(part))?.into(),
        None => None,
    };
    // More than three segments is not our grammar.
    if parts.next().is_some() {
        return None;
    }
    Some(TemplateRef { scope: scope.to_owned(), name: name.to_owned(), field })
}

/// The scope whose names follow the environment's conventions rather than ours.
pub const ENV_SCOPE: &str = "env";

fn is_ref_segment(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// An environment variable name: the POSIX set, which is uppercase, digits and `_`, plus
/// lowercase because plenty of real variables use it.
fn is_env_name(part: &str) -> bool {
    !part.is_empty()
        && !part.as_bytes()[0].is_ascii_digit()
        && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Named ports a service listens on.
///
/// Explicit `ports:` wins. Otherwise: every `${ports.x}` in the run command, plus env values
/// that are a *bare* port reference. `API_URL: http://h:${ports.api}` is deliberately excluded —
/// a port embedded in a URL points at some *other* service, and counting it would have two
/// services claiming the same port.
pub fn service_ports(service: &ServiceSpec) -> Vec<String> {
    if let Some(ports) = &service.ports {
        return ports.clone();
    }
    let mut names = BTreeSet::new();
    if let Some(run) = &service.run {
        for reference in template_refs(run) {
            if reference.scope == "ports" {
                names.insert(reference.name);
            }
        }
    }
    for value in service.env.values() {
        if let Some(name) = bare_port_ref(value) {
            names.insert(name);
        }
    }
    names.into_iter().collect()
}

/// `"${ports.web}"` and nothing else (surrounding whitespace allowed).
fn bare_port_ref(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let inner = trimmed.strip_prefix("${")?.strip_suffix('}')?;
    let name = inner.strip_prefix("ports.")?;
    let ok = !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    ok.then(|| name.to_owned())
}

/// The effective runtime for a service, given the file's defaults.
pub fn service_runtime(service: &ServiceSpec, config: &CanopyConfig) -> Runtime {
    if service.compose.is_some() {
        return Runtime::Compose;
    }
    service.runtime.unwrap_or(config.defaults.runtime)
}

/// Topological start order. `Err` names the cycle.
pub fn start_order(
    services: &BTreeMap<String, ServiceSpec>,
    include: Option<&BTreeSet<String>>,
) -> Result<Vec<String>, String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Visiting,
        Done,
    }
    let names: Vec<&String> = services.keys().filter(|name| include.is_none_or(|set| set.contains(*name))).collect();
    let selected: BTreeSet<&String> = names.iter().copied().collect();
    let mut state: BTreeMap<&str, Mark> = BTreeMap::new();
    let mut order = Vec::new();

    fn visit<'a>(
        name: &'a str,
        services: &'a BTreeMap<String, ServiceSpec>,
        selected: &BTreeSet<&'a String>,
        state: &mut BTreeMap<&'a str, Mark>,
        order: &mut Vec<String>,
        trail: &mut Vec<&'a str>,
    ) -> Result<(), String> {
        match state.get(name) {
            Some(Mark::Done) => return Ok(()),
            Some(Mark::Visiting) => {
                trail.push(name);
                return Err(format!("depends_on cycle: {}", trail.join(" → ")));
            }
            None => {}
        }
        state.insert(name, Mark::Visiting);
        trail.push(name);
        // `name` came from `services.keys()`, so the lookup cannot miss; flattening says that
        // without an arm that never runs.
        {
            for dep in services.get(name).into_iter().flat_map(|service| &service.depends_on) {
                // A dependency outside the selected subset is not an ordering constraint;
                // an unknown one is lint's problem, not ordering's.
                if !selected.contains(dep) {
                    continue;
                }
                visit(dep, services, selected, state, order, trail)?;
            }
        }
        trail.pop();
        state.insert(name, Mark::Done);
        order.push(name.to_owned());
        Ok(())
    }

    for name in names {
        visit(name, services, &selected, &mut state, &mut order, &mut Vec::new())?;
    }
    Ok(order)
}

/// Every semantic rule, in the order a reader would want them.
pub fn lint(config: &CanopyConfig) -> Vec<Diagnostic> {
    let mut out = Vec::new();

    if config.version != 1 {
        out.push(Diagnostic::error(
            "version",
            format!("unsupported version {} — this tool understands version 1", config.version),
        ));
        // Every other rule assumes the v1 shape; reporting them too would be noise.
        return out;
    }

    let port_names: BTreeSet<&String> = config.ports.keys().collect();
    let db_names: BTreeSet<&String> = config.databases.keys().collect();
    let service_names: BTreeSet<&String> = config.services.keys().collect();

    let check_refs = |out: &mut Vec<Diagnostic>, where_: &str, text: &str| {
        for reference in template_refs(text) {
            match reference.scope.as_str() {
                "ports" if !port_names.contains(&reference.name) => {
                    out.push(Diagnostic::error(where_, format!("unknown port `${{ports.{}}}`", reference.name)));
                }
                "db" if !db_names.contains(&reference.name) => {
                    let field = reference.field.as_deref().unwrap_or("url");
                    out.push(Diagnostic::error(
                        where_,
                        format!("unknown database `${{db.{}.{field}}}`", reference.name),
                    ));
                }
                "ports" | "db" | "worktree" | "project" | "env" => {}
                other => out.push(Diagnostic::warning(where_, format!("unknown template scope `${{{other}.…}}`"))),
            }
        }
    };

    for name in config.ports.keys() {
        if !is_resource_name(name) {
            out.push(Diagnostic::error(&format!("ports.{name}"), NAME_RULE));
        }
    }

    for (key, value) in config.defaults.env.iter().chain(config.env.iter()) {
        check_refs(&mut out, &format!("env.{key}"), value);
    }

    for (name, service) in &config.services {
        let where_ = format!("services.{name}");
        if !is_resource_name(name) {
            out.push(Diagnostic::error(&where_, NAME_RULE));
        }
        let runtime = service_runtime(service, config);

        if service.run.is_none() && service.compose.is_none() {
            out.push(Diagnostic::error(&where_, "needs `run:` (or `compose:`)"));
        }
        if runtime == Runtime::Docker
            && service.docker.as_ref().is_none_or(|d| d.image.is_none() && d.dockerfile.is_none())
        {
            out.push(Diagnostic::error(&where_, "runtime `docker` needs `docker.image` or `docker.dockerfile`"));
        }
        if service.compose.is_some() && service.run.is_some() {
            out.push(Diagnostic::warning(&where_, "`run:` is ignored for a compose service"));
        }

        check_refs(&mut out, &format!("{where_}.run"), service.run.as_deref().unwrap_or(""));
        for (key, value) in &service.env {
            check_refs(&mut out, &format!("{where_}.env.{key}"), value);
        }
        if let Some(health) = &service.health {
            let set =
                [health.http.is_some(), health.tcp.is_some(), health.cmd.is_some()].iter().filter(|x| **x).count();
            if set != 1 {
                out.push(Diagnostic::error(&format!("{where_}.health"), "exactly one of `http`, `tcp` or `cmd`"));
            }
            if let Some(http) = &health.http {
                check_refs(&mut out, &format!("{where_}.health.http"), http);
                // Burned once for real: vite binds 127.0.0.1 while `localhost` resolves to ::1
                // first on macOS, so the check fails against a service that is up.
                if http.contains("//localhost") {
                    out.push(Diagnostic::warning(
                        &format!("{where_}.health.http"),
                        "`localhost` resolves to ::1 before 127.0.0.1 on macOS — use 127.0.0.1 if the service binds IPv4",
                    ));
                }
            }
            if let Some(tcp) = &health.tcp {
                check_refs(&mut out, &format!("{where_}.health.tcp"), &tcp.as_text());
            }
            if let Some(cmd) = &health.cmd {
                check_refs(&mut out, &format!("{where_}.health.cmd"), cmd);
            }
        }
        for port in service.ports.iter().flatten() {
            if !port_names.contains(port) {
                out.push(Diagnostic::error(&format!("{where_}.ports"), format!("unknown port `{port}`")));
            }
        }
        for dep in &service.depends_on {
            if dep == name {
                out.push(Diagnostic::error(&where_, "depends on itself"));
            } else if !service_names.contains(dep) {
                out.push(Diagnostic::error(&where_, format!("depends_on unknown service `{dep}`")));
            }
        }
    }

    if let Err(cycle) = start_order(&config.services, None) {
        out.push(Diagnostic::error("services", cycle));
    }

    for (name, db) in &config.databases {
        let where_ = format!("databases.{name}");
        out.push(Diagnostic::warning(&where_, "databases are not supported by this version of canopywt — ignored"));
        if db.seed.as_ref().is_some_and(|s| [&s.dump, &s.sql, &s.command].iter().filter(|v| v.is_some()).count() > 1) {
            out.push(Diagnostic::error(&format!("{where_}.seed"), "use one of `dump`, `sql` or `command`"));
        }
    }

    for (index, step) in config.setup.iter().enumerate() {
        let where_ = format!("setup.{}", step.label(index));
        check_refs(&mut out, &where_, &step.run);
        for (key, value) in &step.env {
            check_refs(&mut out, &format!("{where_}.env.{key}"), value);
        }
    }

    if let EnvFile::Disabled(true) = config.env_file {
        out.push(Diagnostic::error("env_file", "use a path or `false`; `true` means nothing"));
    }

    if config.services.is_empty() {
        out.push(Diagnostic::warning("services", "no services — nothing will run"));
    }
    let exposed: BTreeSet<String> = config.services.values().flat_map(service_ports).collect();
    for port in &port_names {
        if !exposed.contains(*port) {
            out.push(Diagnostic::warning(&format!("ports.{port}"), "not referenced by any service"));
        }
    }

    out
}

const NAME_RULE: &str =
    "names may contain lowercase letters, digits, `_` and `-`, and must start with a letter or digit";

/// The `ResourceName` rule: safe in env var names, paths and container names alike.
fn is_resource_name(name: &str) -> bool {
    let mut chars = name.bytes();
    let Some(first) = chars.next() else { return false };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}
