//! Repository discovery and the worktree list.
//!
//! `git worktree list` is the registry. Nothing this crate persists is ever consulted to answer
//! "what worktrees exist" or "where is branch X" — that keeps `canopywt` honest when a worktree
//! is created, moved or removed by plain git behind its back.

use camino::{Utf8Path, Utf8PathBuf};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::Git;

/// A repository as seen from some working directory.
#[derive(Debug, Clone)]
pub struct Repo {
    /// Top level of the checkout we were invoked from (absent for a bare repo).
    pub root: Option<Utf8PathBuf>,
    /// The *common* git dir — shared by the main checkout and every linked worktree, so it is
    /// the one path that identifies the repository no matter which worktree you stand in.
    pub common_dir: Utf8PathBuf,
    /// The git dir of *this* worktree (`<common>/worktrees/<name>` for a linked one).
    pub git_dir: Utf8PathBuf,
    git: Git,
}

impl Repo {
    /// Discovers the repository containing `cwd`.
    pub fn discover(git: Git, cwd: &Utf8Path) -> Result<Repo> {
        // Two calls, not one. `--show-toplevel` cannot be batched with the others: in a bare
        // repo it fails the *whole* rev-parse with "this operation must be run in a work tree",
        // which would make every bare repo look like an error instead of a repo without a
        // checkout.
        let out = git.run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"]).map_err(
            |error| match error {
                // git says "not a git repository"; say which directory, which git does not.
                Error::GitFailed { ref stderr, .. } if stderr.contains("not a git repository") => {
                    Error::NotARepository(cwd.to_owned())
                }
                other => other,
            },
        )?;
        let mut lines = out.lines();
        let common_dir = next_path(&mut lines, cwd)?;
        let git_dir = next_path(&mut lines, cwd)?;

        // We already know this is a repository, so the only thing a failure here can mean is
        // "no work tree" — a bare repo, or a worktree whose checkout has been deleted.
        let root = git
            .run(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
            .ok()
            .and_then(|out| out.lines().next().filter(|l| !l.is_empty()).map(Utf8PathBuf::from));

        Ok(Repo { root, common_dir, git_dir, git })
    }

    /// True when this repo has no main checkout of its own.
    pub fn is_bare(&self) -> bool {
        self.root.is_none()
    }

    /// A stable name for the repository: the common dir's parent directory, or the bare repo's
    /// own directory with `.git` stripped. Used as the default `{{ repo }}` and as the project
    /// component of derived names.
    pub fn name(&self) -> String {
        let base = if self.common_dir.file_name() == Some(".git") {
            self.common_dir.parent().unwrap_or(&self.common_dir)
        } else {
            self.common_dir.as_path()
        };
        base.file_name().unwrap_or("repo").trim_end_matches(".git").to_owned()
    }

    /// Every worktree git currently knows about, main checkout first.
    pub fn worktrees(&self) -> Result<Vec<WorktreeEntry>> {
        let raw = self.git.run_bytes(self.any_cwd(), ["worktree", "list", "--porcelain", "-z"])?;
        parse_worktree_list(&raw)
    }

    /// A directory we can run git from. The common dir always exists, even when the repo is
    /// bare or the checkout we were invoked from has been deleted underneath us.
    fn any_cwd(&self) -> &Utf8Path {
        self.root.as_deref().unwrap_or(&self.common_dir)
    }
}

fn next_path<'a>(lines: &mut impl Iterator<Item = &'a str>, cwd: &Utf8Path) -> Result<Utf8PathBuf> {
    lines.next().filter(|l| !l.is_empty()).map(Utf8PathBuf::from).ok_or_else(|| Error::NotARepository(cwd.to_owned()))
}

/// One entry of `git worktree list --porcelain`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorktreeEntry {
    pub path: Utf8PathBuf,
    /// Absent for a worktree that has never been checked out, and for a bare entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// Short branch name (`refs/heads/` stripped). `None` means detached or bare.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    /// `Some(reason)` when locked; the reason may be empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prunable: Option<String>,
}

/// Parses `git worktree list --porcelain -z`.
///
/// The `-z` form NUL-terminates every attribute line and emits an extra empty record between
/// worktrees, so the stream is a flat list of attributes split by NUL with empty entries acting
/// as separators. Parsing bytes rather than a `String` lets a single non-UTF-8 path be reported
/// as such instead of corrupting the whole listing.
pub fn parse_worktree_list(raw: &[u8]) -> Result<Vec<WorktreeEntry>> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeEntry> = None;

    for field in raw.split(|b| *b == 0) {
        if field.is_empty() {
            // Record separator (and the trailing NUL of the final record).
            if let Some(entry) = current.take() {
                out.push(entry);
            }
            continue;
        }
        let text =
            std::str::from_utf8(field).map_err(|_| Error::NonUtf8Path(String::from_utf8_lossy(field).into_owned()))?;
        let (key, value) = match text.split_once(' ') {
            Some((key, value)) => (key, value),
            None => (text, ""),
        };
        match key {
            "worktree" => {
                if let Some(entry) = current.take() {
                    out.push(entry);
                }
                current = Some(WorktreeEntry {
                    path: Utf8PathBuf::from(value),
                    head: None,
                    branch: None,
                    bare: false,
                    detached: false,
                    locked: None,
                    prunable: None,
                });
            }
            // Every other key belongs to the worktree already opened. A stream that starts with
            // something else is malformed; ignoring it beats panicking on a future git version
            // that adds a header we do not know about.
            _ => {
                let Some(entry) = current.as_mut() else { continue };
                match key {
                    "HEAD" => entry.head = Some(value.to_owned()),
                    "branch" => entry.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_owned()),
                    "bare" => entry.bare = true,
                    "detached" => entry.detached = true,
                    "locked" => entry.locked = Some(value.to_owned()),
                    "prunable" => entry.prunable = Some(value.to_owned()),
                    _ => {}
                }
            }
        }
    }
    if let Some(entry) = current.take() {
        out.push(entry);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a `-z` stream the way git does: every attribute NUL-terminated, an extra NUL
    /// between records.
    fn stream(records: &[&[&str]]) -> Vec<u8> {
        let mut out = Vec::new();
        for record in records {
            for field in *record {
                out.extend_from_slice(field.as_bytes());
                out.push(0);
            }
            out.push(0);
        }
        out
    }

    #[test]
    fn parses_a_single_worktree_on_a_branch() {
        let raw = stream(&[&["worktree /repo", "HEAD abc123", "branch refs/heads/main"]]);
        let got = parse_worktree_list(&raw).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "/repo");
        assert_eq!(got[0].head.as_deref(), Some("abc123"));
        // `refs/heads/` is stripped: everything downstream wants the short name.
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert!(!got[0].detached);
        assert!(!got[0].bare);
    }

    #[test]
    fn parses_several_worktrees_in_order() {
        let raw = stream(&[
            &["worktree /repo", "HEAD aaa", "branch refs/heads/main"],
            &["worktree /wt/feat", "HEAD bbb", "branch refs/heads/feat/x"],
        ]);
        let got = parse_worktree_list(&raw).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].path, "/repo");
        assert_eq!(got[1].path, "/wt/feat");
        // A branch name containing a slash must survive intact.
        assert_eq!(got[1].branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn detached_has_no_branch() {
        let raw = stream(&[&["worktree /wt/loose", "HEAD ccc", "detached"]]);
        let got = parse_worktree_list(&raw).unwrap();
        assert!(got[0].detached);
        assert_eq!(got[0].branch, None);
        assert_eq!(got[0].head.as_deref(), Some("ccc"));
    }

    #[test]
    fn bare_has_neither_head_nor_branch() {
        let raw = stream(&[&["worktree /repo.git", "bare"]]);
        let got = parse_worktree_list(&raw).unwrap();
        assert!(got[0].bare);
        assert_eq!(got[0].head, None);
        assert_eq!(got[0].branch, None);
    }

    #[test]
    fn locked_and_prunable_carry_their_reason() {
        let raw = stream(&[
            &["worktree /wt/a", "HEAD aaa", "detached", "locked on a removable drive"],
            &["worktree /wt/b", "HEAD bbb", "detached", "prunable gitdir file points to non-existent location"],
        ]);
        let got = parse_worktree_list(&raw).unwrap();
        assert_eq!(got[0].locked.as_deref(), Some("on a removable drive"));
        assert_eq!(got[1].prunable.as_deref(), Some("gitdir file points to non-existent location"));
    }

    #[test]
    fn locked_without_a_reason_is_still_locked() {
        // git emits a bare `locked` when no reason was given; `Some("")` must not collapse
        // to `None`, or a locked worktree would look unlocked.
        let raw = stream(&[&["worktree /wt/a", "HEAD aaa", "detached", "locked"]]);
        let got = parse_worktree_list(&raw).unwrap();
        assert_eq!(got[0].locked.as_deref(), Some(""));
    }

    #[test]
    fn empty_input_is_an_empty_list() {
        assert_eq!(parse_worktree_list(b"").unwrap(), Vec::new());
    }

    #[test]
    fn trailing_nuls_do_not_produce_a_phantom_entry() {
        // The real stream ends with the record separator, so splitting on NUL leaves empty
        // trailing fields. They must not open an entry.
        let mut raw = stream(&[&["worktree /repo", "HEAD aaa", "branch refs/heads/main"]]);
        raw.push(0);
        raw.push(0);
        assert_eq!(parse_worktree_list(&raw).unwrap().len(), 1);
    }

    #[test]
    fn a_record_with_no_trailing_separator_is_still_returned() {
        // Defensive: a truncated stream should yield what it did contain rather than silently
        // dropping the last worktree.
        let raw = b"worktree /repo\0HEAD aaa\0branch refs/heads/main\0".to_vec();
        let got = parse_worktree_list(&raw).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn unknown_attributes_are_ignored_not_fatal() {
        // A future git may add attributes. Ignoring them keeps us forward-compatible.
        let raw = stream(&[&["worktree /repo", "HEAD aaa", "branch refs/heads/main", "somethingnew value"]]);
        let got = parse_worktree_list(&raw).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn a_path_with_a_space_survives() {
        let raw = stream(&[&["worktree /repo/my worktree", "HEAD aaa", "branch refs/heads/main"]]);
        let got = parse_worktree_list(&raw).unwrap();
        assert_eq!(got[0].path, "/repo/my worktree");
    }

    #[test]
    fn a_non_utf8_path_is_an_error_not_a_corrupted_string() {
        let mut raw = b"worktree /repo/".to_vec();
        raw.extend_from_slice(&[0xff, 0xfe]);
        raw.push(0);
        raw.push(0);
        let error = parse_worktree_list(&raw).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::Io);
    }
}
