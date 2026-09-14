//! The `post-checkout` bridge: noticing a worktree that plain git created.
//!
//! `canopywt new` is not the only way a worktree appears. Somebody types `git worktree add`, or
//! their editor does it for them, and the result is a checkout with no ports, no env file and no
//! services — which looks like `canopywt` is broken rather than like it was never asked.
//!
//! git fires `post-checkout` at the end of `git worktree add`, with the new worktree as the
//! working directory. The problem is that it fires the same hook for every ordinary
//! `git checkout`, every `git clone`, and every `git checkout -- file`, and this hook runs from
//! the *shared* hooks directory: linked worktrees do not get one each, so whatever is installed
//! here runs for the whole repository. Two rules follow, and they are the whole module:
//!
//! - **[`classify`] is pure and pessimistic.** Four independent facts have to line up before we
//!   call something a worktree add; anything else is silently none of our business.
//! - **The installed script always exits 0.** git cannot abort a checkout on a `post-checkout`
//!   hook's say-so anyway, so a non-zero exit buys nothing — and with one shared hooks
//!   directory, a hook that starts failing fails every checkout in every worktree at once.

use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;

use camino::{Utf8Path, Utf8PathBuf};
use serde::Serialize;

use crate::error::ErrorCode;

/// Set by `canopywt new` around its own `git worktree add`, so the hook it fires does not call
/// back into the command that is already doing the work.
///
/// Being set at all is the signal, whatever the value: this is our own recursion guard rather
/// than a user setting, and nobody exports it by accident.
pub const NO_HOOK_ENV: &str = "CANOPYWT_NO_HOOK";

/// `$1` for the first checkout into a brand new worktree: git has no previous HEAD to name.
/// This is the fact that separates a worktree add from an ordinary branch switch.
pub const NULL_REF: &str = "0000000000000000000000000000000000000000";

/// How we recognise a script as ours. Written as a comment line of its own, and deliberately
/// absent from [`snippet`]: a hook somebody merged into by hand is not one we may delete.
pub const MARKER: &str = "canopywt hook post-checkout";

/// The only hook this module installs.
pub const HOOK_NAME: &str = "post-checkout";

/// `rwxr-xr-x`. git ignores a hook that is not executable, silently.
const MODE: u32 = 0o755;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum HookError {
    /// A `post-checkout` that somebody else wrote. Never merged into automatically: the file is
    /// a program, and an automatic edit of somebody's program is how a repository ends up with a
    /// checkout that does two contradictory things.
    #[error("{path} already exists and was not written by canopywt — add this to it by hand:\n{snippet}")]
    Foreign { path: Utf8PathBuf, snippet: String },

    #[error("{path}: {source}")]
    Io {
        path: Utf8PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl HookError {
    /// The stable code a caller branches on. A foreign hook is `setup_failed` rather than a new
    /// code of its own: installing the bridge is a setup step that could not be carried out, and
    /// the `--json` envelope's code list is an API that does not grow for one command.
    pub fn code(&self) -> ErrorCode {
        match self {
            HookError::Foreign { .. } => ErrorCode::SetupFailed,
            HookError::Io { .. } => ErrorCode::Io,
        }
    }
}

// ---------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------

/// What a `post-checkout` invocation turned out to be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "trigger", rename_all = "snake_case")]
pub enum Trigger {
    WorktreeAdded,
    /// Carries why, because a hook that does nothing and says nothing is impossible to debug.
    NotAWorktreeAdd {
        reason: String,
    },
}

/// Decides, from git's three `post-checkout` arguments plus the working directory and the
/// environment, whether this is `git worktree add` finishing.
///
/// Pure, and testable without git, because every one of these four facts is cheap to state and
/// expensive to get wrong: this hook runs on every checkout in the repository, and the cost of a
/// false positive is `canopywt` provisioning an environment over somebody's branch switch.
///
/// - `flag` is `1` for a branch checkout; `0` means `git checkout -- file`, which moved no HEAD.
/// - `old` is the previous HEAD, and the null ref only when there was none — a fresh worktree.
/// - `.git` in a linked worktree is a *file* pointing at `<common>/worktrees/<name>`. A clone
///   fires the same hook with the null ref and flag 1, and is told apart by having a real `.git`
///   directory.
/// - `no_hook` is [`NO_HOOK_ENV`], which `canopywt new` sets so its own `git worktree add`
///   cannot recurse into this.
pub fn classify(old: &str, new: &str, flag: &str, cwd: &Utf8Path, no_hook: bool) -> Trigger {
    if no_hook {
        return not_one(format!("{NO_HOOK_ENV} is set — canopywt is already doing this"));
    }
    if flag != "1" {
        return not_one(format!("the checkout flag is {flag:?}, not \"1\" — a file checkout, not a branch checkout"));
    }
    if old != NULL_REF {
        return not_one(format!("HEAD moved from {old} to {new} — an ordinary checkout, not a new worktree"));
    }
    // `is_file` and not `exists`: a `.git` *directory* here is a clone or the main checkout,
    // which is the one other thing that arrives with the null ref and flag 1.
    if !cwd.join(".git").is_file() {
        return not_one(format!("{cwd}/.git is not a gitfile — not a linked worktree"));
    }
    Trigger::WorktreeAdded
}

fn not_one(reason: String) -> Trigger {
    Trigger::NotAWorktreeAdd { reason }
}

// ---------------------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------------------

/// Where the hook goes. `hooks_dir` is handed in because git's answer (`core.hooksPath`, else
/// `<common>/hooks`) is git's to give, not ours to guess.
pub fn hook_path(hooks_dir: &Utf8Path) -> Utf8PathBuf {
    hooks_dir.join(HOOK_NAME)
}

/// Writes the bridge, executable, and returns where it landed.
///
/// Idempotent over a script of ours — re-installing after the binary moves is the normal way to
/// repair it — and refuses anything else, handing back the [`snippet`] to paste instead.
pub fn install(hooks_dir: &Utf8Path, binary: &str) -> Result<Utf8PathBuf, HookError> {
    let path = hook_path(hooks_dir);
    if let Some(existing) = read(&path)?
        && !is_ours(&existing)
    {
        return Err(HookError::Foreign { path, snippet: snippet(binary) });
    }
    fs::create_dir_all(hooks_dir).map_err(|source| HookError::Io { path: hooks_dir.to_owned(), source })?;
    fs::write(&path, script(binary)).map_err(|source| HookError::Io { path: path.clone(), source })?;
    // git skips a hook it cannot execute and says nothing about it, which is the worst way for
    // this to fail: everything looks installed and nothing ever runs.
    fs::set_permissions(path.as_std_path(), fs::Permissions::from_mode(MODE))
        .map_err(|source| HookError::Io { path: path.clone(), source })?;
    Ok(path)
}

/// Removes the hook if it is ours. `false` means there was nothing of ours to remove — a hook
/// somebody else wrote is left exactly where it is.
pub fn uninstall(hooks_dir: &Utf8Path) -> Result<bool, HookError> {
    let path = hook_path(hooks_dir);
    match read(&path)? {
        Some(existing) if is_ours(&existing) => {
            fs::remove_file(&path).map_err(|source| HookError::Io { path: path.clone(), source })?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Whether the bridge is installed. An unreadable hooks directory answers `false`: the question
/// is "will a worktree add reach us", and the honest answer there is no.
pub fn is_installed(hooks_dir: &Utf8Path) -> bool {
    matches!(read(&hook_path(hooks_dir)), Ok(Some(existing)) if is_ours(&existing))
}

/// The script we write.
///
/// `exit 0` on its own line rather than `exec`: with `exec`, a binary that has been moved or
/// uninstalled leaves `/bin/sh` exiting 127, and this hook runs for every checkout in every
/// worktree of the repository. The invocation stays in the foreground so its stderr still
/// reaches the terminal — a bridge that fails should be visible, just not fatal.
pub fn script(binary: &str) -> String {
    format!(
        "#!/bin/sh
# {MARKER}
#
# Installed by `canopywt hook install`; remove it with `canopywt hook uninstall`.
#
# This hooks directory is shared by every linked worktree, so a hook that fails here fails
# every checkout in the repository. It therefore always exits 0 — and git could not abort a
# checkout on our say-so anyway.
{} hook {HOOK_NAME} \"$@\"
exit 0
",
        quote(binary)
    )
}

/// What to paste into a `post-checkout` somebody else already wrote.
///
/// Carries no [`MARKER`]: a file we did not write must never start looking like one we may
/// delete. `|| true` because their hook may run under `set -e`.
pub fn snippet(binary: &str) -> String {
    format!(
        "# let canopywt notice a worktree created by plain `git worktree add`\n{} hook {HOOK_NAME} \"$@\" || true\n",
        quote(binary)
    )
}

/// Single-quoted for `/bin/sh`, with embedded quotes broken out. A path with a space or an
/// apostrophe in it is somebody's real home directory, not a hypothetical.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Ours only when [`MARKER`] stands on a comment line of its own — the shape [`script`] writes
/// and [`snippet`] deliberately does not, so a hook that merely *mentions* canopywt is left
/// alone.
fn is_ours(script: &str) -> bool {
    let marker = format!("# {MARKER}");
    script.lines().any(|line| line.trim() == marker)
}

/// The hook's current contents, or `None` when there is no hook.
///
/// Read lossily: a `post-checkout` that is not UTF-8 is certainly not ours, and the only
/// question asked of these bytes is whether our marker is in them.
fn read(path: &Utf8Path) -> Result<Option<String>, HookError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(source) => Err(HookError::Io { path: path.to_owned(), source }),
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use rstest::rstest;
    use tempfile::TempDir;

    use super::*;

    const HEAD: &str = "a950fe0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
    const BINARY: &str = "/usr/local/bin/canopywt";

    fn temp() -> (TempDir, Utf8PathBuf) {
        let dir = TempDir::new().expect("temp dir");
        let path = Utf8PathBuf::from_path_buf(dir.path().to_path_buf()).expect("utf-8 temp dir");
        (dir, path)
    }

    /// What `.git` in the working directory is.
    #[derive(Debug, Clone, Copy)]
    enum DotGit {
        /// A gitfile: what a linked worktree has.
        File,
        /// A real git dir: what a clone and the main checkout have.
        Dir,
        Missing,
    }

    fn cwd_with(dot_git: DotGit) -> (TempDir, Utf8PathBuf) {
        let (dir, path) = temp();
        match dot_git {
            DotGit::File => fs::write(path.join(".git"), "gitdir: /repo/.git/worktrees/feat\n").expect("write gitfile"),
            DotGit::Dir => fs::create_dir(path.join(".git")).expect("create git dir"),
            DotGit::Missing => {}
        }
        (dir, path)
    }

    // -----------------------------------------------------------------------------------
    // classify
    // -----------------------------------------------------------------------------------

    /// One case per guard, each failing exactly one of them. `expected` is the substring the
    /// reason must carry, or `None` for the one case that is a worktree add.
    #[rstest]
    #[case::worktree_add(NULL_REF, "1", DotGit::File, false, None)]
    #[case::our_own_git_worktree_add(NULL_REF, "1", DotGit::File, true, Some(NO_HOOK_ENV))]
    #[case::file_checkout(NULL_REF, "0", DotGit::File, false, Some("file checkout"))]
    #[case::ordinary_checkout(HEAD, "1", DotGit::File, false, Some("ordinary checkout"))]
    #[case::clone(NULL_REF, "1", DotGit::Dir, false, Some("not a gitfile"))]
    #[case::no_git_at_all(NULL_REF, "1", DotGit::Missing, false, Some("not a gitfile"))]
    fn classify_cases(
        #[case] old: &str,
        #[case] flag: &str,
        #[case] dot_git: DotGit,
        #[case] no_hook: bool,
        #[case] expected: Option<&str>,
    ) {
        let (_dir, cwd) = cwd_with(dot_git);

        let trigger = classify(old, HEAD, flag, &cwd, no_hook);

        match expected {
            None => assert_eq!(trigger, Trigger::WorktreeAdded),
            Some(needle) => match trigger {
                Trigger::NotAWorktreeAdd { reason } => assert!(reason.contains(needle), "{reason:?}"),
                Trigger::WorktreeAdded => panic!("expected {needle:?} to disqualify this checkout"),
            },
        }
    }

    #[test]
    fn the_reason_names_the_refs_that_disqualified_an_ordinary_checkout() {
        // The reason is the only thing a user has to go on when the bridge does not fire.
        let (_dir, cwd) = cwd_with(DotGit::File);

        let Trigger::NotAWorktreeAdd { reason } = classify(HEAD, "b1c2d3e", "1", &cwd, false) else {
            panic!("an ordinary checkout is not a worktree add");
        };

        assert!(reason.contains(HEAD), "{reason:?}");
        assert!(reason.contains("b1c2d3e"), "{reason:?}");
    }

    #[test]
    fn a_worktree_add_is_recognised_in_a_real_repository() {
        // The confirmed fact this module rests on, checked against git rather than assumed:
        // `git worktree add` leaves a gitfile behind, and the main checkout does not.
        let (_dir, base) = temp();
        let root = base.join("repo");
        fs::create_dir_all(&root).expect("create repo");
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("README.md"), "# fixture\n").expect("write README");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "initial"]);
        let worktree = base.join("wt");
        git(&root, &["worktree", "add", worktree.as_str(), "-b", "feat"]);

        assert_eq!(classify(NULL_REF, HEAD, "1", &worktree, false), Trigger::WorktreeAdded);
        assert!(matches!(classify(NULL_REF, HEAD, "1", &root, false), Trigger::NotAWorktreeAdd { .. }));
    }

    /// git with a pinned environment: without it these tests pass or fail according to the
    /// developer's own global config.
    fn git(cwd: &Utf8Path, args: &[&str]) {
        let home = cwd.join("home");
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .env("HOME", home.as_str())
            .env("XDG_CONFIG_HOME", home.join(".config").as_str())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", home.join("gitconfig-absent").as_str())
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00+0000")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00+0000")
            .env("TZ", "UTC");
        let output = command.output().expect("spawn git");
        assert!(output.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    // -----------------------------------------------------------------------------------
    // install
    // -----------------------------------------------------------------------------------

    #[test]
    fn install_writes_an_executable_script() {
        let (_dir, hooks) = temp();

        let path = install(&hooks, BINARY).expect("install");

        assert_eq!(path, hooks.join("post-checkout"));
        let text = fs::read_to_string(&path).expect("read hook");
        assert!(text.starts_with("#!/bin/sh\n"), "{text}");
        assert!(text.contains(&format!("'{BINARY}' hook post-checkout \"$@\"")), "{text}");
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        // git skips a hook it cannot execute, silently.
        assert_eq!(mode & 0o777, 0o755, "{mode:o}");
        assert!(is_installed(&hooks));
    }

    #[test]
    fn install_creates_a_hooks_directory_that_is_not_there() {
        let (_dir, base) = temp();
        let hooks = base.join("hooks");

        install(&hooks, BINARY).expect("install");

        assert!(is_installed(&hooks));
    }

    #[test]
    fn install_refuses_a_hook_somebody_else_wrote_and_says_what_to_paste() {
        let (_dir, hooks) = temp();
        let existing = "#!/bin/sh\nexec ./my-own-hook \"$@\"\n";
        fs::write(hook_path(&hooks), existing).expect("write foreign hook");

        let error = install(&hooks, BINARY).unwrap_err();

        let HookError::Foreign { path, snippet } = &error else { panic!("expected Foreign, got {error:?}") };
        assert_eq!(path, &hook_path(&hooks));
        assert!(snippet.contains(&format!("'{BINARY}' hook post-checkout \"$@\"")), "{snippet}");
        assert!(error.to_string().contains(snippet.as_str()), "the error must carry the snippet to paste");
        assert_eq!(error.code(), ErrorCode::SetupFailed);
        assert_eq!(fs::read_to_string(hook_path(&hooks)).expect("read"), existing, "their hook must be untouched");
        assert!(!is_installed(&hooks));
    }

    #[test]
    fn the_snippet_does_not_make_their_hook_look_like_ours() {
        // Somebody pastes it in; `uninstall` must still refuse to delete their file.
        let (_dir, hooks) = temp();
        fs::write(hook_path(&hooks), format!("#!/bin/sh\n{}", snippet(BINARY))).expect("write merged hook");

        assert!(!is_installed(&hooks));
        assert!(!uninstall(&hooks).expect("uninstall"));
        assert!(hook_path(&hooks).exists());
    }

    #[test]
    fn installing_ours_again_is_a_no_op_that_repoints_the_binary() {
        let (_dir, hooks) = temp();

        install(&hooks, BINARY).expect("install");
        let first = fs::read_to_string(hook_path(&hooks)).expect("read");
        install(&hooks, BINARY).expect("re-install");
        assert_eq!(fs::read_to_string(hook_path(&hooks)).expect("read"), first);

        // The repair path: the binary moved, so the same command rewrites the line.
        install(&hooks, "/opt/canopywt").expect("re-install elsewhere");
        let text = fs::read_to_string(hook_path(&hooks)).expect("read");
        assert!(text.contains("'/opt/canopywt' hook post-checkout"), "{text}");
        assert!(!text.contains(BINARY), "{text}");
    }

    // -----------------------------------------------------------------------------------
    // uninstall
    // -----------------------------------------------------------------------------------

    #[test]
    fn uninstall_removes_ours() {
        let (_dir, hooks) = temp();
        install(&hooks, BINARY).expect("install");

        assert!(uninstall(&hooks).expect("uninstall"));
        assert!(!hook_path(&hooks).exists());
        assert!(!is_installed(&hooks));
    }

    #[test]
    fn uninstall_leaves_a_foreign_hook_where_it_is() {
        let (_dir, hooks) = temp();
        let existing = "#!/bin/sh\necho not ours\n";
        fs::write(hook_path(&hooks), existing).expect("write foreign hook");

        assert!(!uninstall(&hooks).expect("uninstall"));
        assert_eq!(fs::read_to_string(hook_path(&hooks)).expect("read"), existing);
    }

    #[test]
    fn uninstall_with_no_hook_at_all_is_not_an_error() {
        let (_dir, hooks) = temp();

        assert!(!uninstall(&hooks).expect("uninstall"));
        assert!(!is_installed(&hooks));
    }

    #[test]
    fn a_hook_that_is_not_text_is_not_ours() {
        // A compiled hook is somebody else's program; the only question asked of the bytes is
        // whether our marker is in them.
        let (_dir, hooks) = temp();
        fs::write(hook_path(&hooks), [0x7f, b'E', b'L', b'F', 0xff, 0xfe]).expect("write binary hook");

        assert!(!is_installed(&hooks));
        assert!(!uninstall(&hooks).expect("uninstall"));
        assert!(matches!(install(&hooks, BINARY), Err(HookError::Foreign { .. })));
    }

    #[test]
    fn an_unreadable_hook_is_an_io_error_not_a_verdict() {
        // A directory where the hook should be: `install` must not silently write over it, and
        // `is_installed` must not claim we are wired up.
        let (_dir, hooks) = temp();
        fs::create_dir_all(hook_path(&hooks)).expect("create dir in the hook's place");

        let error = install(&hooks, BINARY).unwrap_err();
        assert!(matches!(error, HookError::Io { .. }), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
        assert!(!is_installed(&hooks));
        assert!(uninstall(&hooks).is_err());
    }

    // -----------------------------------------------------------------------------------
    // The script itself
    // -----------------------------------------------------------------------------------

    /// Runs the installed hook the way git would.
    fn run_hook(hooks: &Utf8Path, args: [&str; 3]) -> std::process::Output {
        Command::new("/bin/sh").arg(hook_path(hooks).as_str()).args(args).output().expect("run the hook")
    }

    #[test]
    fn the_script_exits_zero_even_when_the_binary_is_not_there() {
        // One shared hooks directory: a hook that starts failing fails every checkout in the
        // repository, and git could not abort one on our say-so anyway.
        let (_dir, hooks) = temp();
        install(&hooks, "/nonexistent/canopywt").expect("install");

        let output = run_hook(&hooks, [NULL_REF, HEAD, "1"]);

        assert_eq!(output.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&output.stderr));
        // Not silent, though: the failure still reaches the terminal.
        assert!(!output.stderr.is_empty(), "a broken bridge must still say so");
    }

    #[test]
    fn the_script_exits_zero_when_the_binary_fails() {
        let (_dir, hooks) = temp();
        install(&hooks, "/usr/bin/false").expect("install");

        assert_eq!(run_hook(&hooks, [NULL_REF, HEAD, "1"]).status.code(), Some(0));
    }

    #[test]
    fn the_script_hands_git_arguments_through_unchanged() {
        let (_dir, hooks) = temp();
        install(&hooks, "/bin/echo").expect("install");

        let output = run_hook(&hooks, [NULL_REF, HEAD, "1"]);

        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), format!("hook post-checkout {NULL_REF} {HEAD} 1"));
    }

    #[test]
    fn a_binary_path_with_a_space_or_a_quote_in_it_still_runs() {
        // Somebody's home directory, not a hypothetical.
        let (_dir, base) = temp();
        let odd = base.join("o'brien tools");
        fs::create_dir_all(&odd).expect("create dir");
        let binary = odd.join("canopywt");
        fs::write(&binary, "#!/bin/sh\necho \"ran $*\"\n").expect("write binary");
        fs::set_permissions(binary.as_std_path(), fs::Permissions::from_mode(0o755)).expect("chmod");
        let hooks = base.join("hooks");
        install(&hooks, binary.as_str()).expect("install");

        let output = run_hook(&hooks, [NULL_REF, HEAD, "1"]);

        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            format!("ran hook post-checkout {NULL_REF} {HEAD} 1")
        );
    }

    #[test]
    fn the_marker_is_a_comment_line_of_its_own() {
        // A hook that merely mentions canopywt is somebody else's; only the line we write makes
        // a file ours to delete.
        assert!(is_ours(&script(BINARY)));
        assert!(!is_ours(&snippet(BINARY)));
        assert!(!is_ours("#!/bin/sh\nexec canopywt hook post-checkout \"$@\"\n"));
        assert!(is_ours(&format!("#!/bin/sh\n  # {MARKER}  \n")));
    }
}
