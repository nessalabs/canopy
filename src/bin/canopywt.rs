//! `canopywt` — the CLI.
//!
//! Deliberately thin: parse, call one library method, print. Anything that looks like logic
//! belongs in the library, where the other consumers of this crate can reach it.

use std::io::Write;
use std::process::ExitCode;

use camino::Utf8PathBuf;
use canopy_worktree::error::Result;
use canopy_worktree::wire::Envelope;
use canopy_worktree::{Canopy, Error};
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "canopywt", version, about = "Git worktree dev environments driven by canopy.yaml")]
struct Cli {
    /// Run as if started in this directory.
    #[arg(short = 'C', global = true, value_name = "PATH")]
    directory: Option<Utf8PathBuf>,

    /// Print one JSON envelope on stdout instead of human output.
    #[arg(long, global = true)]
    json: bool,

    /// Suppress progress on stderr. Results still go to stdout.
    #[arg(long, short, global = true)]
    quiet: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Show what repository this is and where its pieces live.
    Info,
    /// List every worktree git knows about.
    List,
    /// Read and validate canopy.yaml.
    #[command(subcommand)]
    Config(ConfigCommand),
    /// Print where a branch's worktree would live. The branch need not exist.
    Path {
        branch: String,
        /// Directory name; defaults to the sanitized branch.
        #[arg(long)]
        name: Option<String>,
    },
    /// Create a worktree for a branch.
    New {
        branch: String,
        /// Branch to fork from. Implies creating the branch.
        #[arg(long)]
        base: Option<String>,
        /// Check out an existing branch instead of creating one.
        #[arg(long, conflicts_with = "base")]
        existing: bool,
        /// Put the worktree here, ignoring the `worktree.path` template.
        #[arg(long)]
        path: Option<Utf8PathBuf>,
        /// Directory name; defaults to the sanitized branch.
        #[arg(long)]
        name: Option<String>,
    },
    /// Show the ports allocated to a branch, allocating them if needed.
    Ports {
        /// Defaults to the branch of the worktree you are in.
        branch: Option<String>,
        /// Show the whole registry instead of one branch.
        #[arg(long, conflicts_with = "branch")]
        all: bool,
        /// Hand a branch's ports back to the pool.
        #[arg(long, conflicts_with_all = ["all"])]
        release: bool,
    },
    /// Show the resolved environment for a branch's worktree.
    Env {
        /// Defaults to the branch of the worktree you are in.
        branch: Option<String>,
        /// Print `export K='v'` lines for `eval`.
        #[arg(long, conflicts_with = "write")]
        export: bool,
        /// Write the file named by `env_file:` into the worktree.
        #[arg(long)]
        write: bool,
    },
    /// Start a worktree's services.
    Up {
        /// Defaults to the branch of the worktree you are in.
        branch: Option<String>,
        /// Start only these services. Repeatable.
        #[arg(long)]
        only: Vec<String>,
        /// Return as soon as each service is spawned, without waiting for its health check.
        #[arg(long)]
        no_wait: bool,
    },
    /// Stop a worktree's services.
    Down {
        branch: Option<String>,
        #[arg(long)]
        only: Vec<String>,
    },
    /// Show what is running for a worktree.
    Ps { branch: Option<String> },
    /// Show a service's log.
    Logs {
        service: String,
        branch: Option<String>,
        /// Keep printing as new lines arrive.
        #[arg(long, short)]
        follow: bool,
        /// How many existing lines to show first.
        #[arg(long, short = 'n', default_value_t = 200)]
        lines: usize,
    },
    /// Carry gitignored files into a worktree, per the `copy:` rules.
    Copy {
        /// Defaults to the branch of the worktree you are in.
        branch: Option<String>,
        /// The checkout to copy from. Defaults to the main checkout.
        #[arg(long)]
        from: Option<Utf8PathBuf>,
        /// Report the plan and write nothing.
        #[arg(long)]
        dry_run: bool,
        /// Use these rules instead of the config's `copy:`, as `pattern` or `pattern=strategy`
        /// where strategy is copy, clone or symlink. Repeatable. For an embedder that keeps its
        /// own rules, the way `--path` exists for one that owns its own layout.
        #[arg(long = "rule")]
        rules: Vec<String>,
    },
    /// Run the `setup:` steps for a worktree.
    Setup {
        /// Defaults to the branch of the worktree you are in.
        branch: Option<String>,
        /// Run every step, even ones `if_changed` would skip.
        #[arg(long, short)]
        force: bool,
        /// Run only these steps, by name. Repeatable.
        #[arg(long)]
        only: Vec<String>,
        /// Give up on any single step after this long, e.g. `5m`.
        #[arg(long)]
        timeout: Option<String>,
        /// Add or override an environment variable, as `KEY=VALUE`. Repeatable. For an embedder
        /// whose environment is richer than this crate can resolve — Canopy's database URLs,
        /// say — the way `--rule` exists for one that keeps its own copy rules.
        #[arg(long = "env")]
        env_overrides: Vec<String>,
    },
    /// Report anything wrong with this repository's canopywt state.
    Doctor,
    /// Sweep what `doctor` reports as debris. Removes only what it can prove is dead.
    Gc {
        /// Truncate logs larger than this many bytes.
        #[arg(long)]
        log_cap: Option<u64>,
    },
    /// The git post-checkout bridge, so a worktree made by plain `git worktree add` is noticed.
    #[command(subcommand)]
    Hook(HookCommand),
    /// Remove a worktree, by branch name or path.
    Rm {
        target: String,
        /// Remove even with uncommitted changes, discarding them.
        #[arg(long, short)]
        force: bool,
        /// What to do with the branch afterwards.
        #[arg(long, value_enum, default_value = "never")]
        delete_branch: DeleteBranchArg,
    },
}

#[derive(Subcommand, Debug)]
enum HookCommand {
    /// Install the post-checkout hook. Refuses to overwrite one that is not ours.
    Install,
    /// Remove it. Leaves a hook that is not ours alone.
    Uninstall,
    /// Whether it is installed.
    Status,
    /// Called by the installed hook. Always exits 0 — git cannot abort a checkout anyway, and
    /// the hooks directory is shared, so a failure here would break every worktree at once.
    PostCheckout { old: String, new: String, flag: String },
}

#[derive(clap::ValueEnum, Clone, Copy, Debug)]
enum DeleteBranchArg {
    /// Leave the branch alone.
    Never,
    /// Delete it only if git agrees its work is already merged.
    IfMerged,
    /// Delete it regardless.
    Always,
}

impl From<DeleteBranchArg> for canopy_worktree::DeleteBranch {
    fn from(value: DeleteBranchArg) -> Self {
        match value {
            DeleteBranchArg::Never => canopy_worktree::DeleteBranch::Never,
            DeleteBranchArg::IfMerged => canopy_worktree::DeleteBranch::IfMerged,
            DeleteBranchArg::Always => canopy_worktree::DeleteBranch::Always,
        }
    }
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    /// Validate the config and report errors and warnings.
    Check {
        /// Validate text on stdin instead of the file on disk — for an editor validating a
        /// buffer that has not been saved.
        #[arg(long)]
        stdin: bool,
    },
    /// Print the effective config, with every default filled in.
    Show,
    /// Print the path of the canopy.yaml in effect, and where it was found.
    Path,
    /// Print a starter canopy.yaml on stdout. Never writes; redirect it yourself.
    Init,
    /// Print the JSON Schema for canopy.yaml.
    Schema,
}

impl Command {
    /// The `command` field of the envelope. Stable; consumers match on it.
    fn name(&self) -> &'static str {
        match self {
            Command::Info => "info",
            Command::List => "list",
            Command::Config(ConfigCommand::Check { .. }) => "config check",
            Command::Config(ConfigCommand::Show) => "config show",
            Command::Config(ConfigCommand::Path) => "config path",
            Command::Config(ConfigCommand::Init) => "config init",
            Command::Config(ConfigCommand::Schema) => "config schema",
            Command::Path { .. } => "path",
            Command::New { .. } => "new",
            Command::Ports { .. } => "ports",
            Command::Env { .. } => "env",
            Command::Up { .. } => "up",
            Command::Down { .. } => "down",
            Command::Ps { .. } => "ps",
            Command::Logs { .. } => "logs",
            Command::Copy { .. } => "copy",
            Command::Setup { .. } => "setup",
            Command::Doctor => "doctor",
            Command::Gc { .. } => "gc",
            Command::Hook(HookCommand::Install) => "hook install",
            Command::Hook(HookCommand::Uninstall) => "hook uninstall",
            Command::Hook(HookCommand::Status) => "hook status",
            Command::Hook(HookCommand::PostCheckout { .. }) => "hook post-checkout",
            Command::Rm { .. } => "rm",
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let name = cli.command.name();
    match run(&cli) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            if cli.json {
                // A failure is still a well-formed envelope on stdout: a consumer parses one
                // shape whatever happened, and reads `ok` to find out which.
                let envelope = Envelope::err(name, &error);
                println!("{}", serde_json::to_string(&envelope).expect("envelope is serializable"));
            } else {
                let _ = writeln!(std::io::stderr(), "canopywt: {error}");
            }
            ExitCode::from(error.code().exit_code())
        }
    }
}

/// Returns the process exit code. Commands that report a *verdict* rather than a fault —
/// `config check` on an invalid file — print their own envelope and return a non-zero code,
/// so exactly one envelope reaches stdout either way.
fn run(cli: &Cli) -> Result<u8> {
    // `config init` is the one command that must work before there is a repository: it is
    // what you run to create the file, possibly in a directory you have just made.
    if let Command::Config(ConfigCommand::Init) = cli.command {
        print!("{}", canopy_worktree::config::STARTER);
        return Ok(0);
    }
    // Like `init`, the schema describes the format rather than a repository, so it must work
    // before there is one — it is what you point an editor at while writing the first file.
    if let Command::Config(ConfigCommand::Schema) = cli.command {
        println!("{}", canopy_worktree::config::schema::json_schema().trim_end());
        return Ok(0);
    }

    let cwd = match &cli.directory {
        Some(dir) => dir.clone(),
        None => current_dir()?,
    };
    let canopy = Canopy::open(&cwd)?;

    match cli.command {
        Command::Info => {
            let info = canopy.info()?;
            if cli.json {
                emit("info", &info);
            } else {
                println!("name        {}", info.name);
                println!("root        {}", info.root.as_ref().map(|p| p.as_str()).unwrap_or("(bare)"));
                println!("common dir  {}", info.common_dir);
                println!("git dir     {}", info.git_dir);
                println!("worktrees   {}", info.worktrees);
            }
        }
        Command::List => {
            let worktrees = canopy.list()?;
            if cli.json {
                emit("list", &worktrees);
            } else {
                for entry in &worktrees {
                    let what = match (&entry.branch, entry.bare, entry.detached) {
                        (Some(branch), _, _) => branch.clone(),
                        (None, true, _) => "(bare)".to_owned(),
                        (None, _, true) => format!("(detached {})", short(entry.head.as_deref())),
                        _ => "(no branch)".to_owned(),
                    };
                    println!("{:<24} {}", what, entry.path);
                }
            }
        }
        Command::Config(ref config_command) => return run_config(cli, &canopy, config_command),

        Command::Path { ref branch, ref name } => {
            let path = canopy.path_for(branch, name.as_deref())?;
            if cli.json {
                emit("path", &serde_json::json!({ "branch": branch, "path": path }));
            } else {
                println!("{path}");
            }
        }

        Command::New { ref branch, ref base, existing, ref path, ref name } => {
            let spec = if existing {
                canopy_worktree::BranchSpec::Existing { name: branch.clone() }
            } else {
                // Without an explicit base, fork from the repository's default branch. Falling
                // back to "wherever HEAD happens to be" would silently branch off whatever the
                // main checkout was last left on.
                canopy_worktree::BranchSpec::New {
                    name: branch.clone(),
                    base: base.clone().or_else(|| canopy.default_base()),
                }
            };
            let options = canopy_worktree::CreateOptions { path: path.clone(), name: name.clone() };
            let outcome = canopy.create(&spec, &options)?;
            if cli.json {
                emit("new", &outcome);
            } else {
                let from = outcome.base.as_deref().map(|b| format!(" from {b}")).unwrap_or_default();
                let verb = if outcome.created_branch { "created" } else { "checked out" };
                println!("{verb} {}{from}", outcome.branch);
                println!("{}", outcome.path);
            }
        }

        Command::Ports { ref branch, all, release } => {
            if all {
                let path = canopy.ports_path();
                let registry = canopy_worktree::ports::Registry::load(&path)?;
                let rows: Vec<_> = registry.rows().to_vec();
                if cli.json {
                    emit("ports", &rows);
                } else if rows.is_empty() {
                    println!("no ports allocated");
                } else {
                    for row in &rows {
                        println!("{:<24} {:<12} {}", row.branch, row.name, row.port);
                    }
                }
            } else {
                let branch = resolve_branch(&canopy, branch.as_deref())?;
                if release {
                    let removed = canopy.release_ports(&branch)?;
                    if cli.json {
                        emit("ports", &serde_json::json!({ "branch": branch, "released": removed }));
                    } else {
                        println!("released {removed} port(s) for {branch}");
                    }
                } else {
                    let table = canopy.ports_for(&branch)?;
                    if cli.json {
                        emit("ports", &table);
                    } else {
                        for (name, port) in &table {
                            println!("{name:<12} {port}");
                        }
                    }
                }
            }
        }

        Command::Env { ref branch, export, write } => {
            let branch = resolve_branch(&canopy, branch.as_deref())?;
            let worktree = worktree_path_for_branch(&canopy, &branch)?;
            let table = canopy.env_for(&branch, &worktree)?;
            if write {
                let default_config = canopy_worktree::config::CanopyConfig::empty();
                let config = canopy.config().and_then(|(_, p)| p.config.as_ref()).unwrap_or(&default_config);
                let written = canopy_worktree::env::write_env_file(config, &worktree, &table)?;
                match written {
                    Some(path) if cli.json => emit("env", &serde_json::json!({ "written": path })),
                    Some(path) => println!("wrote {path}"),
                    // `env_file: false` is a choice, not a failure.
                    None if cli.json => emit("env", &serde_json::json!({ "written": null })),
                    None => println!("env_file is disabled; nothing written"),
                }
            } else if cli.json {
                // Secrets are masked for display; the file and `--export` keep the real values.
                emit("env", &table.masked());
            } else if export {
                print!("{}", table.to_export());
            } else {
                print!("{}", table.to_dotenv());
            }
        }

        Command::Up { ref branch, ref only, no_wait } => {
            let (branch, worktree, state, env, facts_owner) = service_context(&canopy, branch.as_deref())?;
            let default_config = canopy_worktree::config::CanopyConfig::empty();
            let config = canopy.config().and_then(|(_, p)| p.config.as_ref()).unwrap_or(&default_config);
            let facts = facts_owner.facts();
            let ctx = canopy_worktree::ServiceContext { worktree: &worktree, state: &state, env: &env, facts: &facts };
            let only = selection(only);
            let statuses = canopy_worktree::service::up(&config.services, only.as_ref(), &ctx, !no_wait)?;
            report_services(cli, "up", &statuses);
            let _ = branch;
        }

        Command::Down { ref branch, ref only } => {
            let (_, worktree, state, env, facts_owner) = service_context(&canopy, branch.as_deref())?;
            let default_config = canopy_worktree::config::CanopyConfig::empty();
            let config = canopy.config().and_then(|(_, p)| p.config.as_ref()).unwrap_or(&default_config);
            let facts = facts_owner.facts();
            let ctx = canopy_worktree::ServiceContext { worktree: &worktree, state: &state, env: &env, facts: &facts };
            let only = selection(only);
            let statuses = canopy_worktree::service::down(&config.services, only.as_ref(), &ctx)?;
            report_services(cli, "down", &statuses);
        }

        Command::Ps { ref branch } => {
            let (_, worktree, state, env, facts_owner) = service_context(&canopy, branch.as_deref())?;
            let default_config = canopy_worktree::config::CanopyConfig::empty();
            let config = canopy.config().and_then(|(_, p)| p.config.as_ref()).unwrap_or(&default_config);
            let facts = facts_owner.facts();
            let ctx = canopy_worktree::ServiceContext { worktree: &worktree, state: &state, env: &env, facts: &facts };
            let statuses = canopy_worktree::service::status(&config.services, None, &ctx)?;
            report_services(cli, "ps", &statuses);
        }

        Command::Logs { ref service, ref branch, follow, lines } => {
            let branch = resolve_branch(&canopy, branch.as_deref())?;
            let state = canopy.state_dir(&branch);
            if follow {
                // Ctrl-C has to land even on a service that has gone quiet, so the stop
                // condition is checked on every poll, not only between lines.
                let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
                let flag = running.clone();
                let _ = ctrlc_flag(flag);
                let mut out = |line: &str| println!("{line}");
                canopy_worktree::service::follow(
                    &state,
                    service,
                    lines,
                    canopy_worktree::service::FOLLOW_POLL,
                    &mut out,
                    &|| running.load(std::sync::atomic::Ordering::Relaxed),
                )?;
            } else {
                let tail = canopy_worktree::service::logs(&state, service, lines)?;
                if cli.json {
                    emit("logs", &tail);
                } else {
                    for line in &tail {
                        println!("{line}");
                    }
                }
            }
        }

        Command::Copy { ref branch, ref from, dry_run, ref rules } => {
            let branch = resolve_branch(&canopy, branch.as_deref())?;
            let target = worktree_path_for_branch(&canopy, &branch)?;
            if !target.exists() {
                return Err(Error::WorktreeNotFound(format!("{branch} has no checkout at {target}")));
            }
            // The main checkout is what a worktree was made from, so it is where its
            // gitignored files come from unless told otherwise.
            let source = match from {
                Some(path) => path.clone(),
                None => canopy.repo().root.clone().ok_or_else(|| {
                    Error::WorktreeNotFound("a bare repository has no checkout to copy from".to_owned())
                })?,
            };
            let default_config = canopy_worktree::config::CanopyConfig::empty();
            let config = canopy.config().and_then(|(_, p)| p.config.as_ref()).unwrap_or(&default_config);
            // `--rule` wins over the config's `copy:`, for an embedder that keeps its own rules
            // — the same reason `--path` exists for one that owns its own layout.
            let overrides = parse_rules(rules)?;
            let rules = if overrides.is_empty() { &config.copy } else { &overrides };
            let options = canopy_worktree::copy::CopyOptions { dry_run, source: source.clone() };
            let outcome = canopy_worktree::copy::copy_ignored(
                &canopy_worktree::git::Git::default(),
                &source,
                &target,
                rules,
                &options,
            )?;

            if cli.json {
                emit("copy", &outcome);
            } else {
                for entry in &outcome.entries {
                    println!(
                        "{:<10} {} ({} bytes, {}ms)",
                        format!("{:?}", entry.result).to_lowercase(),
                        entry.path,
                        entry.bytes,
                        entry.millis
                    );
                }
                for failure in &outcome.failures {
                    println!("failed     {} — {}", failure.path, failure.message);
                }
                if outcome.entries.is_empty() && outcome.failures.is_empty() {
                    println!("nothing to copy");
                }
            }
        }

        Command::Setup { ref branch, force, ref only, ref timeout, ref env_overrides } => {
            let branch = resolve_branch(&canopy, branch.as_deref())?;
            let worktree = worktree_path_for_branch(&canopy, &branch)?;
            if !worktree.exists() {
                return Err(Error::WorktreeNotFound(format!("{branch} has no checkout at {worktree}")));
            }
            let default_config = canopy_worktree::config::CanopyConfig::empty();
            let config = canopy.config().and_then(|(_, p)| p.config.as_ref()).unwrap_or(&default_config);
            let timeout = match timeout {
                Some(text) => Some(canopy_worktree::config::Duration::parse(text).map_err(|error| Error::Module {
                    code: canopy_worktree::ErrorCode::ConfigInvalid,
                    message: error.to_string(),
                })?),
                None => None,
            };
            let mut env = canopy.env_for(&branch, &worktree)?.to_map();
            // Layered last, so an embedder's value wins over anything resolved here.
            for (key, value) in parse_env(env_overrides)? {
                env.insert(key, value);
            }
            let options = canopy_worktree::SetupOptions {
                worktree: &worktree,
                // The main checkout is what a worktree was made from, so it is what
                // `if_changed` compares against.
                source: canopy.repo().root.as_deref(),
                env: &env,
                force,
                only: (!only.is_empty()).then(|| only.clone()),
                timeout,
            };

            // Streamed to stderr as it happens: a four-minute `npm ci` that prints nothing
            // until it finishes looks like a hang. stdout stays clean for the envelope.
            let quiet = cli.quiet;
            let mut on_line = |_stream: canopy_worktree::Stream, text: &str| {
                if !quiet {
                    let _ = writeln!(std::io::stderr(), "{text}");
                }
            };
            let outcome = canopy_worktree::run_setup(&config.setup, &options, &mut on_line)?;

            if cli.json {
                // A verdict, like `config check`: the run happened, and the answer may be no.
                // `data` carries every step either way, so a caller reads one shape.
                let failure = outcome.steps.iter().find_map(|step| match &step.result {
                    canopy_worktree::StepResult::Failed { status, .. } => Some((step.name.clone(), status.clone())),
                    _ => None,
                });
                let error = failure.map(|(name, status)| canopy_worktree::wire::ErrorBody {
                    code: canopy_worktree::ErrorCode::SetupFailed.as_str(),
                    message: format!("setup step {name} failed ({status})"),
                    details: None,
                });
                let envelope = Envelope::verdict("setup", outcome.ok, &outcome, error);
                println!("{}", serde_json::to_string(&envelope).expect("envelope is serializable"));
            } else {
                for step in &outcome.steps {
                    println!("{}", describe_step(step));
                }
            }
            // A failed step is a failed command, so CI does not have to read the summary.
            return Ok(if outcome.ok { 0 } else { 1 });
        }

        Command::Doctor => {
            let report = canopy_worktree::doctor::diagnose(canopy.repo(), &canopy.state_root(), &canopy.ports_path())?;
            // Only an error fails the command. A warning is debris `gc` sweeps as a matter of
            // course, and exiting non-zero for it would make `doctor` useless in CI — the place
            // you actually want it to mean "someone has to look at this".
            let errors =
                report.findings.iter().filter(|f| f.severity == canopy_worktree::FindingSeverity::Error).count();

            if cli.json {
                let error = (errors > 0).then(|| canopy_worktree::wire::ErrorBody {
                    code: canopy_worktree::ErrorCode::RepositoryUnhealthy.as_str(),
                    message: format!("{errors} finding(s) need attention"),
                    details: None,
                });
                let envelope = Envelope::verdict("doctor", errors == 0, &report, error);
                println!("{}", serde_json::to_string(&envelope).expect("envelope is serializable"));
            } else if report.findings.is_empty() {
                println!("no problems found");
            } else {
                for finding in &report.findings {
                    println!(
                        "{:<8} {:<26} {}",
                        format!("{:?}", finding.severity).to_lowercase(),
                        finding.check,
                        finding.message
                    );
                }
                if errors == 0 {
                    println!("\nnothing here needs a person: `canopywt gc` sweeps all of it");
                }
            }
            return Ok(if errors == 0 { 0 } else { 1 });
        }

        Command::Gc { log_cap } => {
            let state_root = canopy.state_root();
            let ports = canopy.ports_path();
            let swept = match log_cap {
                Some(cap) => canopy_worktree::doctor::gc_with(canopy.repo(), &state_root, &ports, cap)?,
                None => canopy_worktree::doctor::gc(canopy.repo(), &state_root, &ports)?,
            };
            if cli.json {
                emit("gc", &swept);
            } else {
                println!(
                    "released {} port(s), removed {} record(s) and {} state dir(s), truncated {} log(s)",
                    swept.ports_released, swept.records_removed, swept.state_dirs_removed, swept.logs_truncated
                );
            }
        }

        Command::Hook(ref hook_command) => return run_hook(cli, &canopy, hook_command),

        Command::Rm { ref target, force, delete_branch } => {
            // Stop anything still running before the checkout goes, or a dev server keeps
            // writing into a directory that no longer exists.
            let stopped = stop_services_for(&canopy, target).unwrap_or_default();
            let options = canopy_worktree::RemoveOptions { force, delete_branch: delete_branch.into() };
            let outcome = canopy.remove(target, &options)?;
            // Hand the ports back. Without this the registry accumulates rows for worktrees
            // that no longer exist and slowly exhausts the range.
            let released =
                outcome.branch.as_deref().map(|branch| canopy.release_ports(branch)).transpose()?.unwrap_or(0);
            let state = outcome.branch.as_deref().map(|branch| canopy.state_dir(branch));
            if let Some(state) = state.filter(|path| path.exists()) {
                // The records and logs describe a worktree that is gone.
                let _ = std::fs::remove_dir_all(&state);
            }
            if cli.json {
                emit(
                    "rm",
                    &serde_json::json!({
                        "path": outcome.path,
                        "branch": outcome.branch,
                        "branch_deleted": outcome.branch_deleted,
                        "ports_released": released,
                        "services_stopped": stopped,
                    }),
                );
            } else {
                println!("removed {}", outcome.path);
                if outcome.branch_deleted {
                    println!("deleted branch {}", outcome.branch.as_deref().unwrap_or("?"));
                }
                if released > 0 {
                    println!("released {released} port(s)");
                }
            }
        }
    }
    Ok(0)
}

fn run_config(cli: &Cli, canopy: &Canopy, command: &ConfigCommand) -> Result<u8> {
    match command {
        // Both are handled before the repo is opened: they describe the format, not a repo.
        ConfigCommand::Init | ConfigCommand::Schema => unreachable!("handled earlier"),

        ConfigCommand::Path => {
            let Some((located, _)) = canopy.config() else {
                return Err(Error::ConfigNotFound(searched_description(canopy)));
            };
            if cli.json {
                emit("config path", located);
            } else {
                println!("{}  ({})", located.path, source_label(located.source));
            }
        }

        ConfigCommand::Show => {
            let Some((_, parsed)) = canopy.config() else {
                return Err(Error::ConfigNotFound(searched_description(canopy)));
            };
            let Some(config) = &parsed.config else {
                return Err(Error::ConfigInvalid(parsed.error_count()));
            };
            if cli.json {
                emit("config show", config);
            } else {
                // The human form of "show" is the YAML you would have written with every
                // default spelled out, which is the question people actually have.
                print!("{}", serde_json::to_string_pretty(config).expect("config is serializable"));
                println!();
            }
        }

        ConfigCommand::Check { stdin } => {
            let (label, parsed) = if *stdin {
                let mut text = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)?;
                ("<stdin>".to_owned(), canopy_worktree::parse_str(&text))
            } else {
                let Some((located, parsed)) = canopy.config() else {
                    return Err(Error::ConfigNotFound(searched_description(canopy)));
                };
                (located.path.to_string(), parsed.clone())
            };

            let report = CheckReport {
                path: &label,
                valid: parsed.is_valid(),
                errors: parsed.error_count(),
                warnings: parsed.warning_count(),
                diagnostics: &parsed.diagnostics,
            };

            if cli.json {
                // One envelope, whatever the verdict. `ok` is the verdict and `data` always
                // carries the diagnostics, so a caller reads warnings off a passing file the
                // same way it reads errors off a failing one.
                let envelope = Envelope::verdict(
                    "config check",
                    parsed.is_valid(),
                    &report,
                    (!parsed.is_valid()).then(|| canopy_worktree::wire::ErrorBody {
                        code: canopy_worktree::ErrorCode::ConfigInvalid.as_str(),
                        message: format!("canopy.yaml has {} error(s)", parsed.error_count()),
                        details: None,
                    }),
                );
                println!("{}", serde_json::to_string(&envelope).expect("envelope is serializable"));
            } else {
                for diagnostic in &parsed.diagnostics {
                    let severity = match diagnostic.severity {
                        canopy_worktree::Severity::Error => "error",
                        canopy_worktree::Severity::Warning => "warning",
                    };
                    let position = match (diagnostic.line, diagnostic.column) {
                        (Some(line), Some(column)) => format!("{label}:{line}:{column}"),
                        _ => label.clone(),
                    };
                    println!("{position}: {severity}: {}: {}", diagnostic.path, diagnostic.message);
                }
                println!(
                    "{}: {} error(s), {} warning(s)",
                    if parsed.is_valid() { "ok" } else { "invalid" },
                    parsed.error_count(),
                    parsed.warning_count()
                );
            }
            // Exit 1 on an invalid config so CI does not have to parse the summary line. The
            // envelope has already been printed, which is why this returns a code rather than
            // an error.
            return Ok(if parsed.is_valid() { 0 } else { 1 });
        }
    }
    Ok(0)
}

#[derive(serde::Serialize)]
struct CheckReport<'a> {
    path: &'a str,
    valid: bool,
    errors: usize,
    warnings: usize,
    diagnostics: &'a [canopy_worktree::Diagnostic],
}

fn source_label(source: canopy_worktree::ConfigSource) -> &'static str {
    match source {
        canopy_worktree::ConfigSource::Worktree => "this worktree",
        canopy_worktree::ConfigSource::MainCheckout => "the main checkout",
        canopy_worktree::ConfigSource::UserConfig => "your user config",
    }
}

/// Where we looked, so "no config" is actionable rather than just a refusal.
fn searched_description(canopy: &Canopy) -> String {
    let root = canopy.repo().root.as_ref().map(|p| p.to_string()).unwrap_or_else(|| "(bare repo)".to_owned());
    format!(
        "looked in {root}, the main checkout, and your user config; `canopywt config init > canopy.yaml` writes a starter"
    )
}

/// `KEY=VALUE`, the spelling `--env` takes. An empty value is legal; an absent `=` is not.
fn parse_env(raw: &[String]) -> Result<Vec<(String, String)>> {
    raw.iter()
        .map(|text| {
            let (key, value) = text.split_once('=').ok_or_else(|| Error::Module {
                code: canopy_worktree::ErrorCode::ConfigInvalid,
                message: format!("--env needs KEY=VALUE, got {text:?}"),
            })?;
            if key.is_empty() {
                return Err(Error::Module {
                    code: canopy_worktree::ErrorCode::ConfigInvalid,
                    message: "--env needs a name before the =".to_owned(),
                });
            }
            Ok((key.to_owned(), value.to_owned()))
        })
        .collect()
}

/// `pattern` or `pattern=strategy`, the spelling `--rule` takes.
fn parse_rules(raw: &[String]) -> Result<Vec<canopy_worktree::config::CopyRule>> {
    raw.iter()
        .map(|text| {
            let (pattern, strategy) = match text.split_once('=') {
                Some((pattern, strategy)) => (pattern, strategy),
                None => (text.as_str(), "copy"),
            };
            let strategy = match strategy {
                "copy" => canopy_worktree::config::CopyStrategy::Copy,
                "clone" => canopy_worktree::config::CopyStrategy::Clone,
                "symlink" => canopy_worktree::config::CopyStrategy::Symlink,
                other => {
                    return Err(Error::Module {
                        code: canopy_worktree::ErrorCode::ConfigInvalid,
                        message: format!("unknown copy strategy {other:?}; use copy, clone or symlink"),
                    });
                }
            };
            if pattern.is_empty() {
                return Err(Error::Module {
                    code: canopy_worktree::ErrorCode::ConfigInvalid,
                    message: "a copy rule needs a pattern".to_owned(),
                });
            }
            Ok(canopy_worktree::config::CopyRule { pattern: pattern.to_owned(), strategy })
        })
        .collect()
}

/// Everything the service commands need, with the borrowed pieces kept alive by the caller.
struct FactsOwner {
    name: String,
    worktree: Utf8PathBuf,
    branch: String,
    project: String,
    project_path: Utf8PathBuf,
    ports: std::collections::BTreeMap<String, u16>,
}

impl FactsOwner {
    fn facts(&self) -> canopy_worktree::env::Facts<'_> {
        canopy_worktree::env::Facts {
            worktree_name: &self.name,
            worktree_path: &self.worktree,
            branch: &self.branch,
            project: &self.project,
            project_path: &self.project_path,
            ports: &self.ports,
        }
    }
}

type ServiceSetup = (String, Utf8PathBuf, Utf8PathBuf, canopy_worktree::EnvTable, FactsOwner);

/// Resolves the branch, its checkout, its state directory and its environment in one place,
/// since every service command needs all four.
fn service_context(canopy: &Canopy, given: Option<&str>) -> Result<ServiceSetup> {
    let branch = resolve_branch(canopy, given)?;
    let worktree = worktree_path_for_branch(canopy, &branch)?;
    if !worktree.exists() {
        return Err(Error::WorktreeNotFound(format!("{branch} has no checkout at {worktree}")));
    }
    let state = canopy.state_dir(&branch);
    std::fs::create_dir_all(&state)?;
    let env = canopy.env_for(&branch, &worktree)?;
    let owner = FactsOwner {
        name: worktree.file_name().unwrap_or(&branch).to_owned(),
        worktree: worktree.clone(),
        branch: branch.clone(),
        project: canopy.repo().name(),
        project_path: canopy.repo().root.clone().unwrap_or_else(|| canopy.repo().common_dir.clone()),
        ports: canopy.ports_for(&branch)?,
    };
    Ok((branch, worktree, state, env, owner))
}

/// git's answer for the hooks directory, which honours `core.hooksPath`. Guessing
/// `.git/hooks` would install into a directory git is not reading.
fn hooks_dir(canopy: &Canopy) -> Result<Utf8PathBuf> {
    let cwd = canopy.repo().root.clone().unwrap_or_else(|| canopy.repo().common_dir.clone());
    let out = canopy_worktree::git::Git::default()
        .run(&cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])?;
    Ok(Utf8PathBuf::from(out.trim()))
}

fn run_hook(cli: &Cli, canopy: &Canopy, command: &HookCommand) -> Result<u8> {
    match command {
        HookCommand::Install => {
            let dir = hooks_dir(canopy)?;
            let binary = std::env::current_exe()
                .ok()
                .and_then(|path| Utf8PathBuf::from_path_buf(path).ok())
                .map(|path| path.to_string())
                .unwrap_or_else(|| "canopywt".to_owned());
            let path = canopy_worktree::hook::install(&dir, &binary)?;
            if cli.json {
                emit("hook install", &serde_json::json!({ "path": path }));
            } else {
                println!("installed {path}");
            }
        }
        HookCommand::Uninstall => {
            let dir = hooks_dir(canopy)?;
            let removed = canopy_worktree::hook::uninstall(&dir)?;
            if cli.json {
                emit("hook uninstall", &serde_json::json!({ "removed": removed }));
            } else {
                println!("{}", if removed { "removed" } else { "nothing of ours was installed" });
            }
        }
        HookCommand::Status => {
            let dir = hooks_dir(canopy)?;
            let installed = canopy_worktree::hook::is_installed(&dir);
            if cli.json {
                emit(
                    "hook status",
                    &serde_json::json!({ "installed": installed, "path": canopy_worktree::hook::hook_path(&dir) }),
                );
            } else {
                println!("{}", if installed { "installed" } else { "not installed" });
            }
        }
        HookCommand::PostCheckout { old, new, flag } => {
            let cwd = canopy.repo().root.clone().unwrap_or_else(|| canopy.repo().common_dir.clone());
            let no_hook = std::env::var_os(canopy_worktree::hook::NO_HOOK_ENV).is_some();
            let trigger = canopy_worktree::hook::classify(old, new, flag, &cwd, no_hook);
            if cli.json {
                emit("hook post-checkout", &trigger);
            } else if let canopy_worktree::hook::Trigger::WorktreeAdded = trigger {
                println!("canopywt: new worktree at {cwd}");
            }
            // Never anything but 0. git cannot abort a checkout, the hooks directory is shared
            // across every worktree, and a hook that fails here breaks all of them at once.
            return Ok(0);
        }
    }
    Ok(0)
}

/// Stops whatever is still running for a worktree that is about to be removed. Best effort:
/// a worktree whose config has gone, or which never started anything, must still be removable.
fn stop_services_for(canopy: &Canopy, target: &str) -> Result<Vec<String>> {
    let Ok((_, worktree, state, env, owner)) = service_context(canopy, Some(target)) else {
        return Ok(Vec::new());
    };
    let default_config = canopy_worktree::config::CanopyConfig::empty();
    let config = canopy.config().and_then(|(_, p)| p.config.as_ref()).unwrap_or(&default_config);
    let facts = owner.facts();
    let ctx = canopy_worktree::ServiceContext { worktree: &worktree, state: &state, env: &env, facts: &facts };
    let statuses = canopy_worktree::service::down(&config.services, None, &ctx)?;
    Ok(statuses.into_iter().map(|status| status.name).collect())
}

/// `--only a --only b` as a set, or `None` for "everything".
fn selection(only: &[String]) -> Option<std::collections::BTreeSet<String>> {
    (!only.is_empty()).then(|| only.iter().cloned().collect())
}

/// Best-effort Ctrl-C handling for `logs --follow`: without it the flag never flips and the
/// follow loop only ends when the terminal closes.
fn ctrlc_flag(flag: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Result<()> {
    // No signal-handling crate: a plain SIGINT default already terminates the process, so this
    // is only about leaving the terminal tidy. Nothing to install.
    let _ = flag;
    Ok(())
}

fn report_services(cli: &Cli, command: &str, statuses: &[canopy_worktree::ServiceStatus]) {
    if cli.json {
        emit(command, &statuses);
        return;
    }
    if statuses.is_empty() {
        println!("no services");
        return;
    }
    for status in statuses {
        let pid = status.pid.map(|pid| pid.to_string()).unwrap_or_else(|| "-".to_owned());
        let detail = status.detail.as_deref().map(|d| format!("  {d}")).unwrap_or_default();
        println!("{:<16} {:<10} {:<8}{detail}", status.name, format!("{:?}", status.state).to_lowercase(), pid);
    }
}

/// One line per step, for the human view.
fn describe_step(step: &canopy_worktree::StepOutcome) -> String {
    match &step.result {
        canopy_worktree::StepResult::Ran { millis } => format!("ran      {} ({millis}ms)", step.name),
        canopy_worktree::StepResult::Skipped { reason } => format!("skipped  {} — {reason}", step.name),
        canopy_worktree::StepResult::Failed { status, millis, .. } => {
            format!("FAILED   {} ({status}, {millis}ms)", step.name)
        }
    }
}

/// The branch to act on: the one given, else the branch of the worktree we are standing in.
fn resolve_branch(canopy: &Canopy, given: Option<&str>) -> Result<String> {
    if let Some(branch) = given {
        return Ok(branch.to_owned());
    }
    let root = canopy.repo().root.as_deref().ok_or_else(|| Error::WorktreeNotFound("(bare repository)".to_owned()))?;
    canopy
        .list()?
        .into_iter()
        .find(|entry| entry.path == root)
        .and_then(|entry| entry.branch)
        // A detached worktree has no branch to default to, so the user has to say.
        .ok_or_else(|| Error::WorktreeNotFound("the current worktree has no branch; name one".to_owned()))
}

/// Where a branch's worktree is, preferring the one that exists over the templated guess.
fn worktree_path_for_branch(canopy: &Canopy, branch: &str) -> Result<Utf8PathBuf> {
    if let Some(entry) = canopy.list()?.into_iter().find(|entry| entry.branch.as_deref() == Some(branch)) {
        return Ok(entry.path);
    }
    canopy.path_for(branch, None)
}

fn emit<T: serde::Serialize>(command: &str, data: &T) {
    let envelope = Envelope::ok(command, data, Vec::new());
    println!("{}", serde_json::to_string(&envelope).expect("envelope is serializable"));
}

fn short(head: Option<&str>) -> String {
    head.unwrap_or("unknown").chars().take(8).collect()
}

/// The process cwd as UTF-8. A non-UTF-8 cwd is rejected here rather than corrupted later.
fn current_dir() -> Result<Utf8PathBuf> {
    let dir = std::env::current_dir()?;
    Utf8PathBuf::from_path_buf(dir).map_err(|p| Error::NonUtf8Path(p.to_string_lossy().into_owned()))
}
