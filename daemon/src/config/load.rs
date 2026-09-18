//! Finding the `canopy.yaml` that applies.
//!
//! Search order, most specific first — the port of `packages/daemon/src/env/config/load.ts`:
//!
//! 1. **The worktree you are in.** A branch may change what it runs; that change travels with
//!    the branch, and while you are on it, it wins.
//! 2. **The repository's main checkout.** The committed, shared answer.
//! 3. **`$XDG_CONFIG_HOME/canopywt/<repo>/canopy.yaml`.** For a repo that should not carry a
//!    `canopy.yaml` of its own — someone else's project you want to run this way anyway.
//!    Searched last, so a committed file always wins.

use camino::{Utf8Path, Utf8PathBuf};
use serde::Serialize;

use super::{Parsed, parse_str};
use crate::error::Result;

/// Both spellings, because both are in the wild.
pub const FILE_NAMES: &[&str] = &["canopy.yaml", "canopy.yml"];

/// Where a config came from — worth reporting, since "which file am I actually editing" is a
/// question a user asks the moment more than one could exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigSource {
    Worktree,
    MainCheckout,
    UserConfig,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocatedConfig {
    pub path: Utf8PathBuf,
    pub source: ConfigSource,
}

/// The config file that applies to `worktree_root`, or `None` when there is none anywhere.
pub fn locate(worktree_root: &Utf8Path, main_checkout: Option<&Utf8Path>, repo_name: &str) -> Option<LocatedConfig> {
    if let Some(path) = first_existing(worktree_root) {
        return Some(LocatedConfig { path, source: ConfigSource::Worktree });
    }
    if let Some(main) = main_checkout
        && main != worktree_root
        && let Some(path) = first_existing(main)
    {
        return Some(LocatedConfig { path, source: ConfigSource::MainCheckout });
    }
    let user_dir = user_config_dir()?.join(repo_name);
    first_existing(&user_dir).map(|path| LocatedConfig { path, source: ConfigSource::UserConfig })
}

fn first_existing(dir: &Utf8Path) -> Option<Utf8PathBuf> {
    FILE_NAMES.iter().map(|name| dir.join(name)).find(|path| path.is_file())
}

/// `$XDG_CONFIG_HOME/canopywt`, falling back to `~/.config/canopywt`.
pub fn user_config_dir() -> Option<Utf8PathBuf> {
    user_config_dir_from(std::env::var("XDG_CONFIG_HOME").ok(), std::env::var("HOME").ok())
}

/// The pure half, so the rule can be tested without mutating the process environment —
/// which parallel tests cannot do safely.
fn user_config_dir_from(xdg: Option<String>, home: Option<String>) -> Option<Utf8PathBuf> {
    // An empty variable is treated as unset, which is what the XDG spec requires and what
    // a `XDG_CONFIG_HOME=` line in a shell profile actually means.
    if let Some(xdg) = xdg.filter(|value| !value.is_empty()) {
        return Some(Utf8PathBuf::from(xdg).join("canopywt"));
    }
    let home = home.filter(|value| !value.is_empty())?;
    Some(Utf8PathBuf::from(home).join(".config").join("canopywt"))
}

/// Reads and parses a specific file.
pub fn load_file(path: &Utf8Path) -> Result<Parsed> {
    Ok(parse_str(&std::fs::read_to_string(path)?))
}

/// A starter file, written by `canopywt config init`.
///
/// Commented rather than minimal: the first question after "how do I start" is always "what
/// else can go in here", and the answer belongs next to the example.
pub const STARTER: &str = r#"version: 1
# name: my-app

# Named ports. Every worktree gets its own free number; reference them as ${ports.web}.
ports:
  web: {}

# Where worktrees go. {{ repo }}, {{ repo_path }}, {{ branch }}, each with | sanitize.
# worktree:
#   path: "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"
#   base: main

# Gitignored files carried into a new worktree. `clone` is copy-on-write where the
# filesystem supports it, which is what makes carrying node_modules affordable.
copy:
  - pattern: .env
  - pattern: .env.local
# - pattern: node_modules
#   strategy: clone

# Run once when a worktree is provisioned, with the resolved env already in place.
setup:
  - run: npm ci
    if_changed: [package-lock.json]

services:
  web:
    run: npm run dev -- --port ${ports.web}
    # 127.0.0.1, not localhost: on macOS localhost resolves to ::1 first, and a service
    # bound to IPv4 would look unhealthy while running perfectly.
    health:
      tcp: "${ports.web}"
    restart: on-failure

env_file: .env.canopy
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_starter_file_is_valid_and_clean() {
        // A scaffold that trips the linter teaches the wrong thing on day one.
        let parsed = parse_str(STARTER);
        assert!(parsed.is_valid(), "starter has errors: {:?}", parsed.errors().collect::<Vec<_>>());
        let warnings: Vec<&str> = parsed.warnings().map(|d| d.message.as_str()).collect();
        assert!(warnings.is_empty(), "starter has warnings: {warnings:?}");
    }

    #[test]
    fn user_config_dir_prefers_xdg() {
        let got = user_config_dir_from(Some("/xdg".to_owned()), Some("/home/me".to_owned()));
        assert_eq!(got.unwrap(), "/xdg/canopywt");
    }

    #[test]
    fn user_config_dir_falls_back_to_home() {
        let got = user_config_dir_from(None, Some("/home/me".to_owned()));
        assert_eq!(got.unwrap(), "/home/me/.config/canopywt");
    }

    #[test]
    fn an_empty_variable_counts_as_unset() {
        // `XDG_CONFIG_HOME=` in a shell profile means "unset", not "the root directory".
        assert_eq!(
            user_config_dir_from(Some(String::new()), Some("/home/me".to_owned())).unwrap(),
            "/home/me/.config/canopywt"
        );
        assert_eq!(user_config_dir_from(None, Some(String::new())), None);
    }

    #[test]
    fn no_home_and_no_xdg_means_no_user_config() {
        assert_eq!(user_config_dir_from(None, None), None);
    }

    #[test]
    fn the_starter_declares_a_service_and_a_port_that_match() {
        let config = parse_str(STARTER).config.unwrap();
        assert_eq!(super::super::service_ports(&config.services["web"]), ["web"]);
    }
}
