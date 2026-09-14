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
            Command::Path { .. } => "path",
            Command::New { .. } => "new",
            Command::Ports { .. } => "ports",
            Command::Env { .. } => "env",
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

        Command::Rm { ref target, force, delete_branch } => {
            let options = canopy_worktree::RemoveOptions { force, delete_branch: delete_branch.into() };
            let outcome = canopy.remove(target, &options)?;
            if cli.json {
                emit("rm", &outcome);
            } else {
                println!("removed {}", outcome.path);
                if outcome.branch_deleted {
                    println!("deleted branch {}", outcome.branch.as_deref().unwrap_or("?"));
                }
            }
        }
    }
    Ok(0)
}

fn run_config(cli: &Cli, canopy: &Canopy, command: &ConfigCommand) -> Result<u8> {
    match command {
        // Handled before the repo is opened.
        ConfigCommand::Init => unreachable!("config init is handled earlier"),

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
