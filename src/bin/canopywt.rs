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
}

impl Command {
    /// The `command` field of the envelope. Stable; consumers match on it.
    fn name(&self) -> &'static str {
        match self {
            Command::Info => "info",
            Command::List => "list",
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let name = cli.command.name();
    match run(&cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if cli.json {
                // A failure is still a well-formed envelope on stdout: a consumer parses one
                // shape whatever happened, and reads `ok` to find out which.
                let envelope = Envelope::err(name, &error);
                println!("{}", serde_json::to_string(&envelope).expect("envelope is serializable"));
            } else {
                let _ = writeln!(std::io::stderr(), "canopywt: {error}");
            }
            ExitCode::from(canopy_worktree::wire::exit_code_for(&error) as u8)
        }
    }
}

fn run(cli: &Cli) -> Result<()> {
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
    }
    Ok(())
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
