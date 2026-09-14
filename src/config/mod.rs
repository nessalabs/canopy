//! `canopy.yaml` — the whole configuration.
//!
//! Deliberately the *only* place settings live. A rule kept in some daemon's database is a rule
//! `canopywt` cannot honour when it runs on its own, so `worktree:` and `copy:` are part of the
//! file even though Canopy has historically kept them elsewhere.
//!
//! These types are the port of `packages/shared/src/schemas/environment.ts`. Where the zod
//! schema applies a default, the Rust type applies the same one, so a config that means one
//! thing to the daemon cannot mean another to this crate.

pub mod duration;
pub mod lint;
pub mod load;
pub mod parse;
pub mod schema;

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

pub use duration::Duration;
pub use lint::{Diagnostic, Severity, TemplateRef, lint, service_ports, service_runtime, start_order, template_refs};
pub use load::{ConfigSource, LocatedConfig, STARTER, locate};
pub use parse::{Parsed, parse_str};
pub use schema::json_schema;

/// Top-level keys we recognise. An unknown one is a warning, not an error — a newer
/// `canopywt` may have added a key this binary does not know, and refusing the whole file over
/// it would be worse than ignoring it.
pub const TOP_LEVEL_KEYS: &[&str] =
    &["version", "name", "defaults", "env", "ports", "databases", "setup", "services", "env_file", "worktree", "copy"];

/// An ordered map, so `services:` round-trips and diagnostics come out in a stable order.
pub type Map<V> = BTreeMap<String, V>;

fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------------------

/// # canopy.yaml
///
/// A repository's whole development environment: the ports each worktree gets, the commands
/// that provision it, the long-running services, and where the worktree itself goes.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct CanopyConfig {
    /// Only `1` exists. Present so a future format can be recognised rather than guessed at.
    // `const: 1` rather than a bare integer, so an editor flags `version: 2` at the same moment
    // `config check` would.
    #[schemars(extend("const" = 1))]
    pub version: u32,
    /// The project name, used by `${project.name}`. Defaults to the repository directory name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Settings every service inherits unless it overrides them.
    #[serde(default)]
    pub defaults: Defaults,
    /// Project-wide env, layered under every service and setup step.
    #[serde(default)]
    pub env: Map<String>,
    /// Named ports. Each worktree gets its own free number for each name.
    #[serde(default)]
    pub ports: Map<PortSpec>,
    /// Database forks. Parsed but not yet acted on; `config check` warns.
    #[serde(default)]
    pub databases: Map<DatabaseSpec>,
    /// Commands run once when a worktree is provisioned, in order.
    #[serde(default)]
    pub setup: Vec<SetupStep>,
    /// Long-running processes `canopywt up` starts and supervises.
    #[serde(default)]
    pub services: Map<ServiceSpec>,
    /// Dotenv written into each worktree with everything resolved; `false` disables it.
    #[serde(default)]
    pub env_file: EnvFile,
    /// Where worktrees go and what they branch from.
    #[serde(default)]
    pub worktree: WorktreeSpec,
    /// Gitignored files carried from the source checkout into a new worktree.
    #[serde(default)]
    pub copy: Vec<CopyRule>,
}

impl CanopyConfig {
    /// A config with nothing declared. What a repository without a `canopy.yaml` behaves like,
    /// so callers need not special-case its absence.
    pub fn empty() -> CanopyConfig {
        CanopyConfig {
            version: 1,
            name: None,
            defaults: Defaults::default(),
            env: Map::new(),
            ports: Map::new(),
            databases: Map::new(),
            setup: Vec::new(),
            services: Map::new(),
            env_file: EnvFile::default(),
            worktree: WorktreeSpec::default(),
            copy: Vec::new(),
        }
    }
}

/// What every service inherits before its own keys are applied.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct Defaults {
    #[serde(default)]
    pub runtime: Runtime,
    #[serde(default)]
    pub env: Map<String>,
}

impl Default for Defaults {
    fn default() -> Self {
        Defaults { runtime: Runtime::Host, env: Map::new() }
    }
}

/// `env_file: .env.canopy` (the default) or `env_file: false`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(untagged)]
pub enum EnvFile {
    /// Only `false` is meaningful; `true` is rejected by lint.
    Disabled(bool),
    Path(String),
}

impl Default for EnvFile {
    fn default() -> Self {
        EnvFile::Path(".env.canopy".to_owned())
    }
}

impl EnvFile {
    /// The path to write, or `None` when disabled.
    pub fn path(&self) -> Option<&str> {
        match self {
            EnvFile::Path(path) => Some(path),
            EnvFile::Disabled(_) => None,
        }
    }
}

// ---------------------------------------------------------------------------------------
// Worktrees and copying
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct WorktreeSpec {
    /// Where a worktree goes. `{{ repo }}`, `{{ repo_path }}`, `{{ branch }}`, `{{ name }}`,
    /// each optionally `| sanitize`. A relative result resolves against the repo.
    #[serde(default = "default_worktree_path")]
    pub path: String,
    /// What a new branch forks from when `--base` is not given. `None` means the repo's
    /// current default branch, discovered at the time it is needed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

fn default_worktree_path() -> String {
    // Sibling of the repo rather than inside it: a worktree nested under the checkout shows up
    // in every `git status`, every file watcher and every `rg`.
    "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}".to_owned()
}

impl Default for WorktreeSpec {
    fn default() -> Self {
        WorktreeSpec { path: default_worktree_path(), base: None }
    }
}

/// One gitignored path, or glob of paths, carried into a new worktree.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct CopyRule {
    /// Glob relative to the repo root (`.env`, `config/*.local.json`, `node_modules`).
    pub pattern: String,
    #[serde(default)]
    pub strategy: CopyStrategy,
}

/// How a copied path is materialised. `clone` is a copy-on-write clone where the filesystem
/// supports it (APFS, btrfs, XFS) and a plain copy where it does not — which is what makes
/// carrying a multi-gigabyte `node_modules` or `target` affordable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum CopyStrategy {
    #[default]
    Copy,
    Clone,
    Symlink,
}

// ---------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------

/// A named port. Every key is optional: `web: {}` is a complete declaration.
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct PortSpec {
    /// Used when free; otherwise allocation walks on from a hash of the branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred: Option<u16>,
    /// Restricts allocation to `[from, to]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<(u16, u16)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

// ---------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------

/// Where a service runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    #[default]
    Host,
    Docker,
    Compose,
}

/// What happens when a supervised service exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum RestartPolicy {
    Never,
    #[default]
    OnFailure,
    Always,
}

/// A long-running process. Needs either `run` or `compose`; lint enforces it.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct ServiceSpec {
    /// Shell command, run through `/bin/sh -c`. Required unless `compose:` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// Relative to the worktree root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Runtime>,
    #[serde(default)]
    pub env: Map<String>,
    /// Named ports this service listens on. Omitted means "infer from the run command and env",
    /// which is what [`service_ports`] does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ports: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<HealthCheck>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub restart: RestartPolicy,
    /// `false` registers the service without starting it with the worktree.
    #[serde(default = "default_true")]
    pub autostart: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker: Option<DockerSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose: Option<ComposeSpec>,
    #[serde(default = "default_stop_signal")]
    pub stop_signal: String,
    #[serde(default = "default_stop_timeout")]
    pub stop_timeout: Duration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn default_stop_signal() -> String {
    "SIGTERM".to_owned()
}

fn default_stop_timeout() -> Duration {
    Duration::from_secs(10)
}

/// Exactly one of `http`, `tcp` or `cmd` must be set; lint enforces it.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct HealthCheck {
    /// GET this URL; 2xx and 3xx are healthy. Templates allowed (`${ports.api}`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<String>,
    /// Connect to this port on localhost. A bare number or `${ports.x}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tcp: Option<TcpTarget>,
    /// Shell command run in the worktree with the service env; exit 0 is healthy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
    #[serde(default = "default_interval")]
    pub interval: Duration,
    #[serde(default = "default_interval")]
    pub timeout: Duration,
    /// Consecutive failures before the service counts as unhealthy.
    #[serde(default = "default_retries")]
    pub retries: u32,
    /// Grace period after start during which failures do not count.
    #[serde(default)]
    pub start_period: Duration,
}

fn default_interval() -> Duration {
    Duration::from_secs(3)
}

fn default_retries() -> u32 {
    10
}

/// `tcp: 5432` and `tcp: "${ports.api}"` are both valid.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(untagged)]
pub enum TcpTarget {
    Port(u16),
    Template(String),
}

impl TcpTarget {
    pub fn as_text(&self) -> String {
        match self {
            TcpTarget::Port(port) => port.to_string(),
            TcpTarget::Template(text) => text.clone(),
        }
    }
}

/// `runtime: docker` settings. Needs `image` or `dockerfile`; lint enforces it.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct DockerSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dockerfile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Extra `-v` mounts, `host:container[:mode]`.
    #[serde(default)]
    pub volumes: Vec<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default = "default_workdir")]
    pub workdir: String,
}

fn default_workdir() -> String {
    "/workspace".to_owned()
}

/// `runtime: compose` settings.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct ComposeSpec {
    #[serde(default = "default_compose_file")]
    pub file: String,
    /// Subset of compose services to bring up; empty means all.
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub profiles: Vec<String>,
}

fn default_compose_file() -> String {
    "docker-compose.yml".to_owned()
}

// ---------------------------------------------------------------------------------------
// Setup and databases
// ---------------------------------------------------------------------------------------

/// A setup step. `setup: [npm ci]` and the object form both land here — the bare string is the
/// overwhelmingly common case and making people write `- run:` for it would be noise.
///
/// Serialized — by `canopywt config show --json`, and so by the TypeScript binding — a step is
/// always the object form, since that is the normalised one.
// The derive only sees the struct, so `schema::a_step_may_be_a_bare_command` widens the result
// to the `oneOf` the hand-written `Deserialize` below actually accepts. A `///` line here would
// be published as the schema's description, which is why this note is not one.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
#[schemars(transform = schema::a_step_may_be_a_bare_command)]
pub struct SetupStep {
    /// Shell command, run through `/bin/sh -c` in the worktree.
    pub run: String,
    /// For logs and `--only`. Defaults to `step 1`, `step 2`, …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Relative to the worktree root; created if absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// On top of the resolved environment.
    // The hand-written `Deserialize` already defaults this; the attribute is what tells the
    // schema it is optional, which is otherwise the one place the two would disagree.
    #[schemars(default)]
    pub env: Map<String>,
    /// Skip when these files have the same content as in the source checkout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_changed: Option<Vec<String>>,
}

impl<'de> Deserialize<'de> for SetupStep {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Bare(String),
            Full {
                run: String,
                #[serde(default)]
                name: Option<String>,
                #[serde(default)]
                cwd: Option<String>,
                #[serde(default)]
                env: Map<String>,
                #[serde(default)]
                if_changed: Option<Vec<String>>,
            },
        }
        // serde's own message for a failed untagged match is "data did not match any variant of
        // untagged enum Raw" — it names an internal type and says nothing about the fix. The
        // common way to land here is `run: true`, where YAML reads a perfectly good shell
        // command as a boolean, so the message says what a step may be and how to quote it.
        let raw = Raw::deserialize(deserializer).map_err(|_| {
            serde::de::Error::custom(
                "a setup step is a command string, or a mapping with `run:`. \
                 A bare `true`, `no` or `1.0` is read as a boolean or a number — quote it: `run: \"true\"`",
            )
        })?;
        Ok(match raw {
            Raw::Bare(run) => SetupStep { run, name: None, cwd: None, env: Map::new(), if_changed: None },
            Raw::Full { run, name, cwd, env, if_changed } => SetupStep { run, name, cwd, env, if_changed },
        })
    }
}

impl SetupStep {
    /// A name for logs and `--only`: the declared one, else `step N` (1-based), matching the
    /// daemon's `normalizeSetupStep`.
    pub fn label(&self, index: usize) -> String {
        self.name.clone().unwrap_or_else(|| format!("step {}", index + 1))
    }
}

/// The database a fork is made from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "lowercase")]
pub enum DbAdapter {
    Postgres,
    Mysql,
    Sqlite,
    Redis,
}

/// A database fork. Recognised today, acted on in a later milestone.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct DatabaseSpec {
    pub adapter: DbAdapter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<DbSeed>,
    /// sqlite: the file copied for each fork.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Env var that receives the fork's URL; defaults to `<NAME>_URL`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Runtime>,
    #[serde(default)]
    pub options: Map<String>,
}

/// At most one of `dump`, `sql` or `command`; lint enforces it.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[cfg_attr(feature = "ts", derive(TS))]
pub struct DbSeed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dump: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// Shell command run once against the fresh template (migrations, seeders).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}
