//! Creating and removing worktrees.
//!
//! Thin on purpose: `git worktree add` and `git worktree remove` do the work, and we shell out
//! so the repository's own hooks, filters and config apply exactly as they would if the user
//! had typed the command. What this module adds is the path template, a dirty check worth
//! reading, and a branch-deletion policy.

use camino::{Utf8Path, Utf8PathBuf};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::paths::{self, PathVars};
use crate::repo::Repo;

/// What branch a new worktree should check out.
#[derive(Debug, Clone)]
pub enum BranchSpec {
    /// Create `name` from `base`.
    New { name: String, base: Option<String> },
    /// Check out a branch that already exists.
    Existing { name: String },
}

impl BranchSpec {
    pub fn name(&self) -> &str {
        match self {
            BranchSpec::New { name, .. } | BranchSpec::Existing { name } => name,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CreateOptions {
    /// Overrides the `worktree.path` template. Used by an embedder that owns its own layout.
    pub path: Option<Utf8PathBuf>,
    /// Directory name; defaults to the sanitized branch.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateOutcome {
    pub path: Utf8PathBuf,
    pub branch: String,
    /// Whether this call created the branch, as opposed to checking out an existing one.
    pub created_branch: bool,
    pub base: Option<String>,
}

/// What to do with the branch when its worktree is removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeleteBranch {
    /// Leave it alone.
    #[default]
    Never,
    /// Delete it only if git agrees its work is already merged.
    IfMerged,
    /// Delete it regardless.
    Always,
}

#[derive(Debug, Clone, Default)]
pub struct RemoveOptions {
    /// Remove even with uncommitted changes.
    pub force: bool,
    pub delete_branch: DeleteBranch,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoveOutcome {
    pub path: Utf8PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub branch_deleted: bool,
}

/// How dirty a checkout is, for a refusal message that says what is in the way.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct DirtyCounts {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub total: u32,
}

impl Repo {
    /// The path this branch's worktree would live at, per the config template.
    pub fn worktree_path_for(&self, template: &str, branch: &str, name: Option<&str>) -> Result<Utf8PathBuf> {
        let sanitized = paths::sanitize(branch);
        let name = name.unwrap_or(&sanitized);
        if name.is_empty() {
            return Err(Error::UnusableBranchName(branch.to_owned()));
        }
        let repo_name = self.name();
        // A bare repo has no checkout to resolve relative templates against, so the directory
        // holding the git dir stands in for it.
        let repo_path = self.root.clone().unwrap_or_else(|| self.common_dir.clone());
        Ok(paths::render(template, &PathVars { repo: &repo_name, repo_path: &repo_path, branch, name }))
    }

    /// Creates a worktree. The branch is the identity; the path follows from it.
    pub fn create_worktree(
        &self,
        template: &str,
        branch: &BranchSpec,
        options: &CreateOptions,
    ) -> Result<CreateOutcome> {
        let path = match &options.path {
            Some(path) => path.clone(),
            None => self.worktree_path_for(template, branch.name(), options.name.as_deref())?,
        };

        // Checked before git, so the message names the path rather than reporting a failure to
        // create a directory.
        if path.exists() {
            return Err(Error::WorktreeExists(path));
        }
        if let Some(existing) = self.worktrees()?.into_iter().find(|w| w.branch.as_deref() == Some(branch.name())) {
            return Err(Error::BranchAlreadyCheckedOut { branch: branch.name().to_owned(), path: existing.path });
        }

        let mut args = vec!["worktree".to_owned(), "add".to_owned()];
        let base = match branch {
            BranchSpec::New { name, base } => {
                args.push("-b".to_owned());
                args.push(name.clone());
                args.push(path.to_string());
                if let Some(base) = base {
                    args.push(base.clone());
                }
                base.clone()
            }
            BranchSpec::Existing { name } => {
                args.push(path.to_string());
                args.push(name.clone());
                None
            }
        };

        // `git worktree add` fires `post-checkout`, and the installed bridge is meant to notice
        // worktrees made by *other* people's git. Marking our own keeps it from recursing.
        self.git.with_env(crate::hook::NO_HOOK_ENV, "1").run(self.any_cwd(), &args).map_err(|error| match error {
            Error::GitFailed { stderr, .. } => Error::WorktreeCreateFailed(stderr),
            other => other,
        })?;

        Ok(CreateOutcome {
            path,
            branch: branch.name().to_owned(),
            created_branch: matches!(branch, BranchSpec::New { .. }),
            base,
        })
    }

    /// Removes the worktree for `target`, which may be a branch name or a path.
    ///
    /// A detached worktree has no branch, so addressing by path has to work.
    pub fn remove_worktree(&self, target: &str, options: &RemoveOptions) -> Result<RemoveOutcome> {
        let entries = self.worktrees()?;
        let wanted = Utf8Path::new(target);
        let entry = entries
            .iter()
            .find(|e| e.branch.as_deref() == Some(target))
            .or_else(|| entries.iter().find(|e| e.path == wanted))
            .ok_or_else(|| Error::WorktreeNotFound(target.to_owned()))?;

        // git lists the main checkout first, and removing it would take the repository with it.
        if entries.first().is_some_and(|first| first.path == entry.path) {
            return Err(Error::CannotRemoveMain(entry.path.clone()));
        }

        let path = entry.path.clone();
        let branch = entry.branch.clone();

        if path.exists() {
            // Our own check rather than git's, so the refusal can say how much is at stake.
            // `git worktree remove` also refuses, but only says "contains modified files".
            if !options.force {
                let dirty = self.dirty_counts(&path)?;
                if dirty.total > 0 {
                    return Err(Error::WorktreeDirty { path: path.clone(), counts: dirty });
                }
            }
            let mut args = vec!["worktree", "remove"];
            if options.force {
                args.push("--force");
            }
            let path_string = path.to_string();
            args.push(&path_string);
            self.git.run(self.any_cwd(), &args).map_err(|error| match error {
                Error::GitFailed { stderr, .. } => Error::WorktreeRemoveFailed(stderr),
                other => other,
            })?;
        }

        // git keeps stale administrative files behind otherwise, and the next `worktree add`
        // at the same path fails with a confusing message about a missing directory.
        let _ = self.git.run(self.any_cwd(), ["worktree", "prune"]);

        let branch_deleted = match (&branch, options.delete_branch) {
            (Some(branch), DeleteBranch::Always) => self.git.succeeds(self.any_cwd(), ["branch", "-D", branch]),
            // `-d` refuses an unmerged branch, and that refusal is the answer, not an error.
            (Some(branch), DeleteBranch::IfMerged) => self.git.succeeds(self.any_cwd(), ["branch", "-d", branch]),
            _ => false,
        };

        Ok(RemoveOutcome { path, branch, branch_deleted })
    }

    /// Counts uncommitted changes in a checkout.
    ///
    /// Untracked files count. `git worktree remove` ignores some of them, and a worktree whose
    /// only content is an uncommitted `.env` is exactly the case where silent deletion hurts.
    pub fn dirty_counts(&self, worktree: &Utf8Path) -> Result<DirtyCounts> {
        let raw = self.git.run_bytes(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])?;
        Ok(parse_status_counts(&raw))
    }
}

/// Counts the entries of `git status --porcelain=v1 -z`.
///
/// Separated from the command so the parsing can be tested on input git would only produce in
/// situations that are awkward to arrange — a rename, whose origin path follows as a second
/// NUL-terminated field and would otherwise be miscounted as another entry with its first two
/// bytes read as a status code.
pub fn parse_status_counts(raw: &[u8]) -> DirtyCounts {
    let mut counts = DirtyCounts::default();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(field) = fields.next() {
        // `XY <path>`: anything shorter is not an entry. git does not emit one, but reading
        // past the end of a truncated stream would panic rather than report nothing.
        if field.len() < 3 {
            continue;
        }
        let index = field[0];
        let worktree_status = field[1];
        if index == b'?' {
            counts.untracked += 1;
        } else {
            if index != b' ' {
                counts.staged += 1;
            }
            if worktree_status != b' ' {
                counts.unstaged += 1;
            }
            // A rename or copy carries its origin path as the next field.
            if matches!(index, b'R' | b'C') {
                fields.next();
            }
        }
    }
    counts.total = counts.staged + counts.unstaged + counts.untracked;
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `XY <path>`, NUL-terminated, the way `git status --porcelain=v1 -z` writes it.
    fn stream(entries: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in entries {
            out.extend_from_slice(entry.as_bytes());
            out.push(0);
        }
        out
    }

    #[test]
    fn counts_each_kind_of_change() {
        let raw = stream(&["?? new.txt", " M edited.txt", "A  added.txt", "MM both.txt"]);
        let counts = parse_status_counts(&raw);
        assert_eq!(counts.untracked, 1);
        // `A ` is staged only, ` M` unstaged only, `MM` both — so one file can be two changes.
        assert_eq!(counts.staged, 2);
        assert_eq!(counts.unstaged, 2);
        assert_eq!(counts.total, 5);
    }

    #[test]
    fn a_rename_is_one_change_not_two() {
        // The origin path follows as its own NUL-terminated field. Reading it as another entry
        // would double-count the rename *and* read "ol" as a status code.
        let raw = stream(&["R  new-name.txt", "old-name.txt"]);
        let counts = parse_status_counts(&raw);
        assert_eq!(counts.staged, 1);
        assert_eq!(counts.total, 1, "the origin path was counted as an entry");
    }

    #[test]
    fn a_copy_carries_its_origin_the_same_way() {
        let raw = stream(&["C  copy.txt", "source.txt"]);
        assert_eq!(parse_status_counts(&raw).total, 1);
    }

    #[test]
    fn a_rename_among_other_entries_does_not_swallow_them() {
        let raw = stream(&["?? first.txt", "R  new.txt", "old.txt", " M last.txt"]);
        let counts = parse_status_counts(&raw);
        assert_eq!(counts.untracked, 1);
        assert_eq!(counts.staged, 1);
        assert_eq!(counts.unstaged, 1, "the entry after a rename's origin was skipped");
        assert_eq!(counts.total, 3);
    }

    #[test]
    fn a_clean_checkout_counts_nothing() {
        assert_eq!(parse_status_counts(b"").total, 0);
    }

    #[test]
    fn a_truncated_stream_reports_what_it_could_read() {
        // git does not emit a field this short, but reading past the end of one would panic
        // rather than report nothing — and a panic here would take a `rm` down mid-flight.
        let raw = stream(&["?? real.txt", "X", ""]);
        assert_eq!(parse_status_counts(&raw).total, 1);
    }

    #[test]
    fn an_unmerged_entry_counts_on_both_sides() {
        // `UU` is a conflict: staged and unstaged at once, and very much uncommitted work.
        let counts = parse_status_counts(&stream(&["UU conflicted.txt"]));
        assert_eq!(counts.staged, 1);
        assert_eq!(counts.unstaged, 1);
        assert_eq!(counts.total, 2);
    }
}
