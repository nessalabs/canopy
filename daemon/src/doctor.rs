//! What is wrong with this repository's canopywt state, and what can safely be swept.
//!
//! Two entry points that have to agree with each other. [`diagnose`] looks and reports; it
//! changes nothing, so it is safe to run from a prompt, a status bar or a cron job. [`gc`]
//! sweeps the subset of those findings that can be *proved* dead, and nothing else.
//!
//! The proof obligation is the whole module. Everything here is state that outlives a process:
//! a port row written by a `canopywt up` that never came back, a `sleep 3600` still serving a
//! branch someone removed last week. Deleting the wrong one of those does not lose a cache, it
//! loses the only handle on a running process — so a record whose pid is alive is never touched,
//! a state directory git still lists is never removed, and a log is truncated rather than
//! deleted, because a caller may be tailing it right now.
//!
//! Severity says who has to act. [`Severity::Warning`] is debris — `gc` clears it, and it costs
//! nothing to leave. [`Severity::Error`] is something only a person can settle: a corrupt
//! registry, a port a stranger holds, a worktree git lists that is not on disk.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;

use camino::{Utf8Path, Utf8PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::ErrorCode;
use crate::paths::sanitize;
use crate::ports::{Allocation, BindProbe, HostProbe, Registry};
use crate::proc::{self, ProcessState};
use crate::repo::{Repo, WorktreeEntry};
use crate::service;

/// How large a service log may get before [`diagnose`] mentions it and [`gc`] truncates it.
///
/// 8 MiB is a few hours of a chatty dev server and still opens instantly in an editor. The cap
/// exists because nothing else rotates these files: a worktree left up over a weekend is the
/// normal way a repository quietly fills a disk.
pub const LOG_CAP: u64 = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/// Module-local, like [`crate::ports::PortError`]: these are the internals of one command
/// rather than new kinds of failure, so they map onto codes the `--json` envelope already
/// publishes instead of adding to them.
///
/// Note what is *not* here: a corrupt registry, an unreadable record, a missing worktree. Those
/// are findings, not errors. A diagnosis that refused to report because the thing it diagnoses
/// is broken would be useless exactly when it is needed.
#[derive(Debug, thiserror::Error)]
pub enum DoctorError {
    /// `git worktree list` failed — without it nothing below can be judged, because git's list
    /// is what "still exists" means here.
    #[error(transparent)]
    Git(#[from] crate::error::Error),

    #[error(transparent)]
    Ports(#[from] crate::ports::PortError),

    #[error("{path}: {source}")]
    Io {
        path: Utf8PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl DoctorError {
    /// The stable code a caller branches on. The two wrapped errors already chose one; keeping
    /// their choice is the point of wrapping rather than flattening.
    pub fn code(&self) -> ErrorCode {
        match self {
            DoctorError::Git(error) => error.code(),
            DoctorError::Ports(error) => error.code(),
            DoctorError::Io { .. } => ErrorCode::Io,
        }
    }
}

// ---------------------------------------------------------------------------------------
// What a caller gets back
// ---------------------------------------------------------------------------------------

/// Who has to act on a finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Debris. [`gc`] clears it and nothing breaks if it stays.
    Warning,
    /// Only a person can settle it; [`gc`] deliberately will not touch it.
    Error,
}

/// One thing that is wrong.
///
/// `check` is the stable half — a caller filters and counts on it, never on `message`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Finding {
    pub check: String,
    pub severity: Severity,
    pub message: String,
    /// The machine-readable particulars: which branch, which port, which file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

/// Everything [`diagnose`] found.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    pub findings: Vec<Finding>,
    /// True only when nothing at all was found. A warning still makes this false: `ok` answers
    /// "is there anything to do here?", and the severity says who does it.
    pub ok: bool,
}

/// What [`gc`] swept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Swept {
    pub ports_released: usize,
    pub records_removed: usize,
    pub state_dirs_removed: usize,
    /// Truncated in place, never deleted — a `canopywt logs -f` holds an open descriptor.
    pub logs_truncated: usize,
}

// ---------------------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------------------

/// "Does this filesystem clone blocks instead of copying them?"
///
/// A seam for the same reason [`BindProbe`] is one: a test cannot choose the filesystem it runs
/// on, and the difference between a clone and a copy is the difference between a provision that
/// takes a second and one that takes a minute.
pub trait CloneProbe: Send + Sync {
    fn clone_file(&self, from: &Utf8Path, to: &Utf8Path) -> std::io::Result<()>;
}

/// The real thing: APFS `clonefile`, Linux `FICLONE`, and an error where there is neither.
pub struct HostClone;

impl CloneProbe for HostClone {
    fn clone_file(&self, from: &Utf8Path, to: &Utf8Path) -> std::io::Result<()> {
        reflink_copy::reflink(from, to)
    }
}

/// The knobs [`diagnose`] turns. Borrowed rather than owned so a caller can hand in the probes
/// it already has.
pub struct Options<'a> {
    /// Decides whether a registry port is actually bindable.
    pub bind: &'a dyn BindProbe,
    /// Decides whether `copy: strategy: clone` will clone or quietly fall back to a byte copy.
    pub clone: &'a dyn CloneProbe,
    /// Bytes. See [`LOG_CAP`].
    pub log_cap: u64,
}

// ---------------------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------------------

/// Diagnoses the repository with the real probes and [`LOG_CAP`].
///
/// `state_root` is the directory holding one state directory per worktree (named by
/// [`sanitize`]d branch), `ports` the port registry file. Both are handed in rather than derived:
/// this module has no opinion about where Canopy keeps its files, and a function that computes
/// its own paths cannot be tested.
pub fn diagnose(repo: &Repo, state_root: &Utf8Path, ports: &Utf8Path) -> Result<Report, DoctorError> {
    let bind = HostProbe::detect();
    diagnose_with(repo, state_root, ports, &Options { bind: &bind, clone: &HostClone, log_cap: LOG_CAP })
}

/// [`diagnose`] with the probes and the log cap supplied.
pub fn diagnose_with(
    repo: &Repo,
    state_root: &Utf8Path,
    ports: &Utf8Path,
    options: &Options<'_>,
) -> Result<Report, DoctorError> {
    let worktrees = repo.worktrees()?;
    let mut findings = check_worktrees(&worktrees);

    match read_registry(ports) {
        Ok(rows) => {
            findings.extend(check_stale_rows(&rows, &worktrees));
            findings.extend(check_duplicate_ports(&rows));
            findings.extend(check_foreign_ports(&rows, state_root, options.bind));
        }
        Err(detail) => findings.push(Finding {
            check: "port_registry_unreadable".to_owned(),
            severity: Severity::Error,
            message: format!("the port registry at {ports} cannot be read: {detail}"),
            detail: Some(json!({ "path": ports, "detail": detail })),
        }),
    }

    findings.extend(check_state_dirs(state_root, &worktrees)?);
    findings.extend(check_records(state_root)?);
    findings.extend(check_logs(state_root, options.log_cap)?);
    // The common dir rather than the checkout: it is on the same volume as the worktree the
    // copy would land in, and scribbling a probe file inside a working tree would show up in
    // somebody's `git status` and in every file watcher pointed at it.
    findings.extend(check_reflink(&repo.common_dir, options.clone));

    Ok(Report { ok: findings.is_empty(), findings })
}

/// A worktree git lists whose directory is gone — usually a `rm -rf` where a
/// `git worktree remove` was meant. Left for a person: only `git worktree prune` (or a
/// deliberate `canopywt rm`) should retire a worktree, never a sweep.
fn check_worktrees(worktrees: &[WorktreeEntry]) -> Vec<Finding> {
    worktrees
        .iter()
        .filter(|entry| !entry.path.exists())
        .map(|entry| Finding {
            check: "worktree_missing".to_owned(),
            severity: Severity::Error,
            message: format!("git lists a worktree at {} that is not on disk", entry.path),
            detail: Some(json!({ "path": entry.path, "branch": entry.branch })),
        })
        .collect()
}

/// Rows for a branch git no longer has a worktree for: a removal that released nothing.
fn check_stale_rows(rows: &[Allocation], worktrees: &[WorktreeEntry]) -> Vec<Finding> {
    let live = live_branches(worktrees);
    let mut stale: BTreeMap<&str, Vec<&Allocation>> = BTreeMap::new();
    for row in rows.iter().filter(|row| !live.contains(row.branch.as_str())) {
        stale.entry(&row.branch).or_default().push(row);
    }
    stale
        .into_iter()
        .map(|(branch, held)| Finding {
            check: "port_row_stale".to_owned(),
            severity: Severity::Warning,
            message: format!("the port registry holds {} port(s) for {branch}, which has no worktree", held.len()),
            detail: Some(json!({
                "branch": branch,
                "ports": held.iter().map(|row| json!({ "name": row.name, "port": row.port })).collect::<Vec<_>>(),
            })),
        })
        .collect()
}

/// Two rows on one number. The registry exists to make this impossible, so seeing it means the
/// file has been edited or merged by hand — and whichever service starts second will not bind.
fn check_duplicate_ports(rows: &[Allocation]) -> Vec<Finding> {
    let mut by_port: BTreeMap<u16, Vec<&Allocation>> = BTreeMap::new();
    for row in rows {
        by_port.entry(row.port).or_default().push(row);
    }
    by_port
        .into_iter()
        .filter(|(_, holders)| holders.len() > 1)
        .map(|(port, holders)| Finding {
            check: "port_duplicate".to_owned(),
            severity: Severity::Error,
            message: format!(
                "port {port} is held by {} — the registry is corrupt",
                holders.iter().map(|row| format!("{}/{}", row.branch, row.name)).collect::<Vec<_>>().join(" and ")
            ),
            detail: Some(json!({
                "port": port,
                "holders": holders.iter().map(|row| json!({ "branch": row.branch, "name": row.name })).collect::<Vec<_>>(),
            })),
        })
        .collect()
}

/// A row whose port will not bind, held by nothing we started.
///
/// The evidence is indirect on purpose: a record says which process it is, never which port it
/// listens on, so "ours" means the owning branch has a live service. That is the honest reading
/// — if the branch has nothing running, the thing holding its port belongs to somebody else, and
/// releasing the row would only hand the collision to the next branch along.
fn check_foreign_ports(rows: &[Allocation], state_root: &Utf8Path, bind: &dyn BindProbe) -> Vec<Finding> {
    let mut live: BTreeMap<&str, bool> = BTreeMap::new();
    let mut findings = Vec::new();
    for row in rows.iter().filter(|row| !bind.is_free(row.port)) {
        let ours = *live.entry(&row.branch).or_insert_with(|| has_live_record(state_root, &row.branch));
        if ours {
            continue;
        }
        findings.push(Finding {
            check: "port_foreign".to_owned(),
            severity: Severity::Error,
            message: format!(
                "port {} is allocated to {}/{} but something we did not start is holding it",
                row.port, row.branch, row.name
            ),
            detail: Some(json!({ "port": row.port, "branch": row.branch, "name": row.name })),
        });
    }
    findings
}

/// A state directory for a worktree git no longer knows about — the other half of
/// [`check_worktrees`].
fn check_state_dirs(state_root: &Utf8Path, worktrees: &[WorktreeEntry]) -> Result<Vec<Finding>, DoctorError> {
    let known = known_state_dirs(worktrees);
    Ok(state_dirs(state_root)?
        .into_iter()
        .filter(|dir| !known.contains(dir.file_name().unwrap_or_default()))
        .map(|dir| Finding {
            check: "state_dir_orphan".to_owned(),
            severity: Severity::Warning,
            message: format!("{dir} is state for a worktree git no longer lists"),
            detail: Some(json!({ "path": dir })),
        })
        .collect())
}

/// Records pointing at a process that is gone, or at a pid somebody else is wearing now.
fn check_records(state_root: &Utf8Path) -> Result<Vec<Finding>, DoctorError> {
    let mut findings = Vec::new();
    for dir in state_dirs(state_root)? {
        for path in entries(&records_dir(&dir))? {
            match proc::read_record(&path) {
                Ok(record) => match proc::state(&record) {
                    ProcessState::Running { .. } => {}
                    ProcessState::Exited => findings.push(Finding {
                        check: "service_record_orphan".to_owned(),
                        severity: Severity::Warning,
                        message: format!("{path} records pid {}, which has exited", record.pid),
                        detail: Some(json!({ "path": path, "pid": record.pid, "reason": "exited" })),
                    }),
                    ProcessState::Stale => findings.push(Finding {
                        check: "service_record_orphan".to_owned(),
                        severity: Severity::Warning,
                        message: format!("{path} records pid {}, which now belongs to something else", record.pid),
                        detail: Some(json!({ "path": path, "pid": record.pid, "reason": "stale" })),
                    }),
                },
                // A record we cannot read is a process we cannot stop. Reported, and left
                // alone by `gc`, because "unreadable" is not evidence that anything is dead.
                Err(error) => findings.push(Finding {
                    check: "service_record_unreadable".to_owned(),
                    severity: Severity::Error,
                    message: format!("{path} is not a usable process record: {error}"),
                    detail: Some(json!({ "path": path })),
                }),
            }
        }
    }
    Ok(findings)
}

/// Logs past the cap. Nothing rotates these but [`gc`].
fn check_logs(state_root: &Utf8Path, cap: u64) -> Result<Vec<Finding>, DoctorError> {
    let mut findings = Vec::new();
    for (path, bytes) in oversized_logs(state_root, cap)? {
        findings.push(Finding {
            check: "log_oversized".to_owned(),
            severity: Severity::Warning,
            message: format!("{path} is {bytes} bytes, over the {cap}-byte cap"),
            detail: Some(json!({ "path": path, "bytes": bytes, "cap": cap })),
        });
    }
    Ok(findings)
}

/// A filesystem with no copy-on-write clone, where `copy: strategy: clone` silently becomes a
/// slow byte copy. A warning, never an error: everything still works, it just costs more.
fn check_reflink(dir: &Utf8Path, clone: &dyn CloneProbe) -> Option<Finding> {
    match probe_reflink(dir, clone) {
        Some(false) => Some(Finding {
            check: "reflink_unsupported".to_owned(),
            severity: Severity::Warning,
            message: format!(
                "{dir} is on a filesystem without copy-on-write clones — a copy rule with \
                 strategy: clone will fall back to a slow byte copy"
            ),
            detail: Some(json!({ "path": dir })),
        }),
        // Supported, or we could not tell. A verdict invented from an unwritable directory
        // would send someone off to reformat a disk that is fine.
        _ => None,
    }
}

/// Clones a byte and throws it away. `None` when the probe could not be carried out at all,
/// which is not evidence either way.
fn probe_reflink(dir: &Utf8Path, clone: &dyn CloneProbe) -> Option<bool> {
    let source = dir.join(format!(".canopywt-doctor-{}.probe", std::process::id()));
    let target = dir.join(format!(".canopywt-doctor-{}.clone", std::process::id()));
    if fs::write(&source, b"canopy").is_err() {
        return None;
    }
    let supported = clone.clone_file(&source, &target).is_ok();
    let _ = fs::remove_file(&source);
    let _ = fs::remove_file(&target);
    Some(supported)
}

// ---------------------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------------------

/// Sweeps what [`diagnose`] reports as debris, with [`LOG_CAP`].
///
/// Every removal here rests on a proof: git no longer lists the branch, the kernel says the pid
/// is gone or is not ours, the file is over a cap. What cannot be proved is left — an unreadable
/// record, a live process, a worktree git still knows about — so running this can never be the
/// reason something stopped working.
pub fn gc(repo: &Repo, state_root: &Utf8Path, ports: &Utf8Path) -> Result<Swept, DoctorError> {
    gc_with(repo, state_root, ports, LOG_CAP)
}

/// [`gc`] with the log cap supplied.
pub fn gc_with(repo: &Repo, state_root: &Utf8Path, ports: &Utf8Path, log_cap: u64) -> Result<Swept, DoctorError> {
    let worktrees = repo.worktrees()?;
    Ok(Swept {
        ports_released: release_stale_rows(ports, &worktrees)?,
        // Records first: clearing the dead ones is what can leave a directory with nothing
        // alive in it, and only such a directory may be removed.
        records_removed: remove_dead_records(state_root)?,
        state_dirs_removed: remove_orphan_state_dirs(state_root, &worktrees)?,
        logs_truncated: truncate_oversized_logs(state_root, log_cap)?,
    })
}

/// Drops every row whose branch git no longer lists. Returns how many rows went.
fn release_stale_rows(ports: &Utf8Path, worktrees: &[WorktreeEntry]) -> Result<usize, DoctorError> {
    let live = live_branches(worktrees);
    let mut registry = Registry::load(ports)?;
    let stale: BTreeSet<String> = registry
        .rows()
        .iter()
        .filter(|row| !live.contains(row.branch.as_str()))
        .map(|row| row.branch.clone())
        .collect();
    let released: usize = stale.iter().map(|branch| registry.release(branch)).sum();
    // Saving an unchanged registry would rewrite the file — and take its lock — for nothing.
    if released > 0 {
        registry.save()?;
    }
    Ok(released)
}

/// Removes records whose process the kernel says is gone, or is no longer ours.
///
/// A `Stale` record is as dead as an exited one for our purposes: nothing will ever be signalled
/// through it again, and keeping it only makes the next reader think there is a service there.
fn remove_dead_records(state_root: &Utf8Path) -> Result<usize, DoctorError> {
    let mut removed = 0;
    for dir in state_dirs(state_root)? {
        for path in entries(&records_dir(&dir))? {
            // An unreadable record is not a dead one. Leaving it costs a warning; removing it
            // could orphan a live dev server that nothing can find again.
            let Ok(record) = proc::read_record(&path) else { continue };
            if proc::state(&record) == (ProcessState::Running { pid: record.pid }) {
                continue;
            }
            remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Removes state directories for worktrees git no longer lists — unless something in one is
/// still running, in which case the directory is the only way back to it.
fn remove_orphan_state_dirs(state_root: &Utf8Path, worktrees: &[WorktreeEntry]) -> Result<usize, DoctorError> {
    let known = known_state_dirs(worktrees);
    let mut removed = 0;
    for dir in state_dirs(state_root)? {
        if known.contains(dir.file_name().unwrap_or_default()) || holds_a_live_record(&dir) {
            continue;
        }
        fs::remove_dir_all(&dir).map_err(|source| DoctorError::Io { path: dir.clone(), source })?;
        removed += 1;
    }
    Ok(removed)
}

/// Empties logs over the cap, in place.
///
/// `set_len(0)` rather than delete-and-recreate: the service holding this file opened it with
/// `O_APPEND` and will keep writing to the same inode, so a replacement file would collect
/// nothing while the old one kept growing invisibly.
fn truncate_oversized_logs(state_root: &Utf8Path, cap: u64) -> Result<usize, DoctorError> {
    let mut truncated = 0;
    for (path, _) in oversized_logs(state_root, cap)? {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|source| DoctorError::Io { path: path.clone(), source })?;
        file.set_len(0).map_err(|source| DoctorError::Io { path: path.clone(), source })?;
        truncated += 1;
    }
    Ok(truncated)
}

// ---------------------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------------------

/// Every branch git currently has a worktree for. A detached or bare entry contributes nothing:
/// it owns no branch, so it can make no row or directory live.
fn live_branches(worktrees: &[WorktreeEntry]) -> BTreeSet<&str> {
    worktrees.iter().filter_map(|entry| entry.branch.as_deref()).collect()
}

/// The state directory names those branches would use.
fn known_state_dirs(worktrees: &[WorktreeEntry]) -> BTreeSet<String> {
    live_branches(worktrees).into_iter().map(sanitize).collect()
}

/// Where one worktree's process records live.
///
/// Derived from [`service::record_path`] rather than repeating the directory name, so a rename
/// there cannot leave `gc` sweeping a directory that no longer exists.
fn records_dir(state: &Utf8Path) -> Utf8PathBuf {
    let sample = service::record_path(state, "sample");
    sample.parent().unwrap_or(state).to_owned()
}

/// Where one worktree's logs live. Derived, for the reason [`records_dir`] is.
fn logs_dir(state: &Utf8Path) -> Utf8PathBuf {
    let sample = service::log_path(state, "sample");
    sample.parent().unwrap_or(state).to_owned()
}

/// Whether anything under this state directory is a record of a live process.
fn holds_a_live_record(state: &Utf8Path) -> bool {
    entries(&records_dir(state)).unwrap_or_default().iter().any(|path| {
        matches!(proc::read_record(path), Ok(record) if proc::state(&record) == (ProcessState::Running { pid: record.pid }))
    })
}

/// The same question asked about a branch.
fn has_live_record(state_root: &Utf8Path, branch: &str) -> bool {
    holds_a_live_record(&state_root.join(sanitize(branch)))
}

/// Every log over `cap`, with its size.
fn oversized_logs(state_root: &Utf8Path, cap: u64) -> Result<Vec<(Utf8PathBuf, u64)>, DoctorError> {
    let mut out = Vec::new();
    for dir in state_dirs(state_root)? {
        for path in entries(&logs_dir(&dir))? {
            let meta = fs::metadata(&path).map_err(|source| DoctorError::Io { path: path.clone(), source })?;
            // Directories are over the cap on most filesystems, and truncating one is an
            // error rather than a sweep.
            if meta.is_file() && meta.len() > cap {
                out.push((path, meta.len()));
            }
        }
    }
    Ok(out)
}

/// The per-worktree state directories. Files directly under the root are not ours and are left
/// where they are.
fn state_dirs(state_root: &Utf8Path) -> Result<Vec<Utf8PathBuf>, DoctorError> {
    Ok(entries(state_root)?.into_iter().filter(|path| path.is_dir()).collect())
}

/// Everything in `dir`, sorted, or nothing when the directory does not exist.
///
/// An absent state directory is the normal state of a repository that has never started a
/// service, not a failure. A name that is not UTF-8 is skipped rather than reported: every
/// directory here is named by [`sanitize`], which emits ASCII, so such a name cannot be one of
/// ours — and failing on it would make the rest of the repository undiagnosable.
fn entries(dir: &Utf8Path) -> Result<Vec<Utf8PathBuf>, DoctorError> {
    let listing = match fs::read_dir(dir) {
        Ok(listing) => listing,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(DoctorError::Io { path: dir.to_owned(), source }),
    };
    let mut out = Vec::new();
    for entry in listing {
        let entry = entry.map_err(|source| DoctorError::Io { path: dir.to_owned(), source })?;
        if let Ok(path) = Utf8PathBuf::from_path_buf(entry.path()) {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

fn remove_file(path: &Utf8Path) -> Result<(), DoctorError> {
    fs::remove_file(path).map_err(|source| DoctorError::Io { path: path.to_owned(), source })
}

/// The port registry as a plain list of rows, or a sentence saying why it cannot be read.
///
/// Deliberately not [`Registry::load`]: that refuses a file where two rows share a port, which
/// is precisely the corruption this module has to *report*. A diagnosis that failed on the
/// broken input would be silent exactly when it matters.
fn read_registry(path: &Utf8Path) -> Result<Vec<Allocation>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        // No file is no allocations: the normal state before the first `canopywt up`.
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    if text.trim().is_empty() {
        return Err("the file is empty".to_owned());
    }
    let file: RegistryFile = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    if file.version != crate::ports::FORMAT_VERSION {
        return Err(format!("unsupported registry version {}", file.version));
    }
    // Sorted the way `ports::Registry` sorts it, so what `doctor` reports does not depend on
    // the order somebody's editor left the file in.
    let mut rows = file.allocations;
    rows.sort_by(|a, b| (&a.branch, &a.name).cmp(&(&b.branch, &b.name)));
    Ok(rows)
}

/// The on-disk shape, repeated here because [`crate::ports`] keeps its own private and this
/// module has to parse a file that one would reject.
#[derive(Deserialize)]
struct RegistryFile {
    version: u32,
    allocations: Vec<Allocation>,
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::process::Command;

    use tempfile::TempDir;

    use super::*;
    use crate::git::Git;
    use crate::proc::ProcessRecord;

    // -----------------------------------------------------------------------------------
    // Probes
    // -----------------------------------------------------------------------------------

    struct AllFree;

    impl BindProbe for AllFree {
        fn is_free(&self, _port: u16) -> bool {
            true
        }
    }

    /// One port taken by something outside this process.
    struct Busy(u16);

    impl BindProbe for Busy {
        fn is_free(&self, port: u16) -> bool {
            port != self.0
        }
    }

    /// A filesystem that clones (or refuses to), without needing one that does.
    struct Cloning(bool);

    impl CloneProbe for Cloning {
        fn clone_file(&self, from: &Utf8Path, to: &Utf8Path) -> io::Result<()> {
            if self.0 {
                fs::copy(from, to).map(|_| ())
            } else {
                Err(io::Error::other("this filesystem does not clone"))
            }
        }
    }

    // -----------------------------------------------------------------------------------
    // The repository
    // -----------------------------------------------------------------------------------

    /// A throwaway repository on `main` with one commit, plus the two paths `doctor` is given.
    struct Fixture {
        state: Utf8PathBuf,
        ports: Utf8PathBuf,
        root: Utf8PathBuf,
        /// Stands in for $HOME so nothing reads or writes the real one.
        home: Utf8PathBuf,
        base: Utf8PathBuf,
        /// Kept alive so the directory outlives the test.
        _dir: TempDir,
    }

    impl Fixture {
        fn new() -> Fixture {
            let dir = TempDir::new().expect("temp dir");
            // Canonicalized because macOS hands out /var/folders/… which is a symlink to
            // /private/var/folders/…; git reports the resolved path and comparisons against
            // the unresolved one would fail.
            let base = Utf8PathBuf::from_path_buf(dir.path().canonicalize().expect("canonicalize"))
                .expect("temp path is utf-8");
            let root = base.join("repo");
            let home = base.join("home");
            fs::create_dir_all(&root).expect("create repo dir");
            fs::create_dir_all(&home).expect("create home dir");
            let fixture = Fixture {
                state: root.join(".git/canopy/worktrees"),
                ports: root.join(".git/canopy/ports.json"),
                root,
                home,
                base,
                _dir: dir,
            };
            fixture.git(&["init", "-b", "main"]);
            fs::write(fixture.root.join("README.md"), "# fixture\n").expect("write README");
            fixture.git(&["add", "-A"]);
            fixture.git(&["commit", "-m", "initial"]);
            fixture
        }

        /// Runs git with a pinned environment: without it the suite passes or fails according to
        /// the developer's own global config.
        fn git(&self, args: &[&str]) -> String {
            let mut command = Command::new("git");
            command
                .args(args)
                .current_dir(&self.root)
                .env("HOME", self.home.as_str())
                .env("XDG_CONFIG_HOME", self.home.join(".config").as_str())
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", self.home.join("gitconfig-absent").as_str())
                .env("GIT_AUTHOR_NAME", "Fixture")
                .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
                .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00+0000")
                .env("GIT_COMMITTER_NAME", "Fixture")
                .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
                .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00+0000")
                .env("TZ", "UTC");
            let output = command.output().expect("spawn git");
            assert!(output.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).expect("git output is utf-8")
        }

        fn repo(&self) -> Repo {
            Repo::discover(Git::default(), &self.root).expect("discover")
        }

        /// Adds a linked worktree on a new branch and returns where it landed.
        fn worktree(&self, branch: &str) -> Utf8PathBuf {
            let path = self.base.join(format!("wt-{}", sanitize(branch)));
            self.git(&["worktree", "add", path.as_str(), "-b", branch]);
            path
        }

        fn state_dir(&self, branch: &str) -> Utf8PathBuf {
            self.state.join(sanitize(branch))
        }

        fn write_record(&self, branch: &str, name: &str, record: &ProcessRecord) -> Utf8PathBuf {
            let path = service::record_path(&self.state_dir(branch), name);
            fs::create_dir_all(path.parent().expect("records dir")).expect("create records dir");
            proc::write_record(&path, record).expect("write record");
            path
        }

        fn write_raw_record(&self, branch: &str, name: &str, text: &str) -> Utf8PathBuf {
            let path = service::record_path(&self.state_dir(branch), name);
            fs::create_dir_all(path.parent().expect("records dir")).expect("create records dir");
            fs::write(&path, text).expect("write record");
            path
        }

        /// A log of exactly `bytes` bytes. Sparse, so an oversized one costs nothing to make.
        fn write_log(&self, branch: &str, name: &str, bytes: u64) -> Utf8PathBuf {
            let path = service::log_path(&self.state_dir(branch), name);
            fs::create_dir_all(path.parent().expect("logs dir")).expect("create logs dir");
            let file = fs::File::create(&path).expect("create log");
            file.set_len(bytes).expect("size log");
            path
        }

        fn write_ports(&self, rows: &[(&str, &str, u16)]) {
            let allocations: Vec<serde_json::Value> = rows
                .iter()
                .map(|(branch, name, port)| json!({ "branch": branch, "name": name, "port": port, "allocated_at": 0 }))
                .collect();
            self.write_ports_text(&json!({ "version": 1, "allocations": allocations }).to_string());
        }

        fn write_ports_text(&self, text: &str) {
            fs::create_dir_all(self.ports.parent().expect("ports dir")).expect("create ports dir");
            fs::write(&self.ports, text).expect("write ports");
        }

        fn port_rows(&self) -> Vec<Allocation> {
            read_registry(&self.ports).expect("readable registry")
        }
    }

    /// The default reading: nothing bound, a filesystem that clones, the real cap.
    fn report(fixture: &Fixture) -> Report {
        report_with(fixture, &AllFree, &Cloning(true), LOG_CAP)
    }

    fn report_with(fixture: &Fixture, bind: &dyn BindProbe, clone: &dyn CloneProbe, log_cap: u64) -> Report {
        diagnose_with(&fixture.repo(), &fixture.state, &fixture.ports, &Options { bind, clone, log_cap })
            .expect("diagnose")
    }

    /// Every finding of one check.
    fn found<'a>(report: &'a Report, check: &str) -> Vec<&'a Finding> {
        report.findings.iter().filter(|finding| finding.check == check).collect()
    }

    fn only(report: &Report, check: &str) -> Finding {
        let found = found(report, check);
        assert_eq!(found.len(), 1, "expected one {check} finding, got {:?}", report.findings);
        found[0].clone()
    }

    /// A record for a process that is certainly alive: this one.
    ///
    /// No start time, which [`crate::proc`] reads as "nothing recorded to contradict a live
    /// pid" — the `Running` arm, arranged without leaving a `sleep` behind.
    fn live_record() -> ProcessRecord {
        record(i32::try_from(std::process::id()).expect("pid fits"), None)
    }

    /// A record for a process that has exited: one we started and collected.
    fn dead_record() -> ProcessRecord {
        let mut child = Command::new("true").spawn().expect("spawn true");
        child.wait().expect("wait");
        record(i32::try_from(child.id()).expect("pid fits"), None)
    }

    /// A record whose pid is alive but is somebody else's: pid 1 never has this start time.
    fn stale_record() -> ProcessRecord {
        record(1, Some("Thu Jan 1 00:00:00 1970".to_owned()))
    }

    fn record(pid: i32, start_time: Option<String>) -> ProcessRecord {
        ProcessRecord {
            pid,
            pgid: pid,
            start_time,
            launch_id: "test".to_owned(),
            command: "sleep 60".to_owned(),
            cwd: Utf8PathBuf::from("/tmp"),
            log: Utf8PathBuf::from("/tmp/service.log"),
            started_at: 0,
        }
    }

    // -----------------------------------------------------------------------------------
    // A healthy repository
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_clean_repository_has_nothing_to_report() {
        let fixture = Fixture::new();
        // Everything a healthy repo has: a worktree git lists and that exists, a port row for
        // it, a live record, a log under the cap.
        fixture.write_ports(&[("main", "web", 10_001)]);
        fixture.write_record("main", "web", &live_record());
        fixture.write_log("main", "web", 1024);

        let report = report(&fixture);

        assert_eq!(report.findings, Vec::new(), "a healthy repository must report nothing");
        assert!(report.ok);
    }

    #[test]
    fn the_real_probes_agree_on_a_clean_repository() {
        // `diagnose` itself, not `diagnose_with`: the wiring of the real probes is the part a
        // test of the inner function cannot see.
        let fixture = Fixture::new();
        let report = diagnose(&fixture.repo(), &fixture.state, &fixture.ports).expect("diagnose");

        // Whether this filesystem clones is a property of the machine, not of the repository,
        // so it is the one finding a clean repo may legitimately carry.
        let unexpected: Vec<&Finding> =
            report.findings.iter().filter(|finding| finding.check != "reflink_unsupported").collect();
        assert!(unexpected.is_empty(), "{unexpected:?}");
    }

    #[test]
    fn ok_is_false_for_a_warning_too() {
        // `ok` answers "is there anything to do here?"; severity answers "by whom?".
        let fixture = Fixture::new();
        fixture.write_ports(&[("gone", "web", 10_001)]);

        let report = report(&fixture);

        assert_eq!(only(&report, "port_row_stale").severity, Severity::Warning);
        assert!(!report.ok);
    }

    // -----------------------------------------------------------------------------------
    // Ports
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_row_for_a_branch_with_no_worktree_is_stale() {
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001), ("gone", "web", 10_002), ("gone", "api", 10_003)]);

        let report = report(&fixture);
        let finding = only(&report, "port_row_stale");

        // One finding per branch, not per row: that is the unit `gc` releases.
        assert_eq!(finding.severity, Severity::Warning);
        assert!(finding.message.contains("2 port(s) for gone"), "{}", finding.message);
        assert_eq!(finding.detail.as_ref().expect("detail")["branch"], "gone");
        assert_eq!(finding.detail.as_ref().expect("detail")["ports"][0]["port"], 10_003);
    }

    #[test]
    fn a_row_for_a_branch_git_still_lists_is_not_stale() {
        let fixture = Fixture::new();
        fixture.worktree("feat/login");
        fixture.write_ports(&[("main", "web", 10_001), ("feat/login", "web", 10_002)]);

        assert_eq!(found(&report(&fixture), "port_row_stale"), Vec::<&Finding>::new());
    }

    #[test]
    fn two_branches_on_one_port_is_corruption() {
        let fixture = Fixture::new();
        fixture.worktree("feat/login");
        fixture.write_ports(&[("main", "web", 10_001), ("feat/login", "web", 10_001)]);

        let report = report(&fixture);
        let finding = only(&report, "port_duplicate");

        assert_eq!(finding.severity, Severity::Error);
        assert!(finding.message.contains("port 10001"), "{}", finding.message);
        assert!(finding.message.contains("feat/login/web and main/web"), "{}", finding.message);
        assert_eq!(finding.detail.as_ref().expect("detail")["holders"].as_array().expect("holders").len(), 2);
    }

    #[test]
    fn one_row_per_port_is_not_a_duplicate() {
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001), ("main", "api", 10_002)]);

        assert_eq!(found(&report(&fixture), "port_duplicate"), Vec::<&Finding>::new());
    }

    #[test]
    fn a_port_a_stranger_holds_is_reported() {
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001)]);

        let report = report_with(&fixture, &Busy(10_001), &Cloning(true), LOG_CAP);
        let finding = only(&report, "port_foreign");

        assert_eq!(finding.severity, Severity::Error);
        assert!(finding.message.contains("port 10001"), "{}", finding.message);
        assert_eq!(finding.detail.as_ref().expect("detail")["branch"], "main");
    }

    #[test]
    fn a_port_our_own_service_holds_is_not_foreign() {
        // The record cannot say which port it listens on, so a live service on the branch is
        // the evidence — and without it the same busy port is somebody else's.
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001)]);
        fixture.write_record("main", "web", &live_record());

        let report = report_with(&fixture, &Busy(10_001), &Cloning(true), LOG_CAP);

        assert_eq!(found(&report, "port_foreign"), Vec::<&Finding>::new());
    }

    #[test]
    fn a_dead_record_does_not_excuse_a_busy_port() {
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001)]);
        fixture.write_record("main", "web", &dead_record());

        let report = report_with(&fixture, &Busy(10_001), &Cloning(true), LOG_CAP);

        assert_eq!(found(&report, "port_foreign").len(), 1);
    }

    #[test]
    fn a_free_port_is_never_foreign() {
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001)]);

        assert_eq!(found(&report(&fixture), "port_foreign"), Vec::<&Finding>::new());
    }

    #[test]
    fn an_unreadable_registry_is_a_finding_not_a_failure() {
        // A diagnosis that refused to run because the thing it diagnoses is broken would be
        // silent exactly when it is needed.
        let fixture = Fixture::new();
        fixture.write_ports_text("{ not json");

        let report = report(&fixture);
        let finding = only(&report, "port_registry_unreadable");

        assert_eq!(finding.severity, Severity::Error);
        assert!(finding.message.contains("cannot be read"), "{}", finding.message);
    }

    #[test]
    fn a_registry_from_the_future_is_not_guessed_at() {
        let fixture = Fixture::new();
        fixture.write_ports_text(r#"{"version":99,"allocations":[]}"#);

        assert!(only(&report(&fixture), "port_registry_unreadable").message.contains("version 99"));
    }

    #[test]
    fn an_empty_registry_file_is_damage() {
        // A save writes the whole document or nothing, so no bytes is not "no allocations".
        let fixture = Fixture::new();
        fixture.write_ports_text("   \n");

        assert!(only(&report(&fixture), "port_registry_unreadable").message.contains("empty"));
    }

    #[test]
    fn a_registry_that_does_not_exist_yet_is_not_a_finding() {
        let fixture = Fixture::new();

        assert_eq!(read_registry(&fixture.ports).expect("absent is empty"), Vec::new());
        assert_eq!(found(&report(&fixture), "port_registry_unreadable"), Vec::<&Finding>::new());
    }

    #[test]
    fn a_registry_that_ports_itself_refuses_is_still_read_here() {
        // `Registry::load` rejects a duplicated port as corrupt, which is exactly the file
        // `doctor` has to be able to describe.
        let fixture = Fixture::new();
        fixture.write_ports(&[("a", "web", 10_001), ("b", "web", 10_001)]);

        assert!(Registry::load(&fixture.ports).is_err());
        assert_eq!(fixture.port_rows().len(), 2);
    }

    // -----------------------------------------------------------------------------------
    // Worktrees and state directories
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_worktree_git_lists_that_is_not_on_disk() {
        let fixture = Fixture::new();
        let path = fixture.worktree("feat/login");
        fs::remove_dir_all(&path).expect("remove the worktree behind git's back");

        let report = report(&fixture);
        let finding = only(&report, "worktree_missing");

        assert_eq!(finding.severity, Severity::Error);
        assert!(finding.message.contains(path.as_str()), "{}", finding.message);
        assert_eq!(finding.detail.as_ref().expect("detail")["branch"], "feat/login");
    }

    #[test]
    fn a_worktree_that_is_on_disk_is_not_missing() {
        let fixture = Fixture::new();
        fixture.worktree("feat/login");

        assert_eq!(found(&report(&fixture), "worktree_missing"), Vec::<&Finding>::new());
    }

    #[test]
    fn a_state_dir_for_a_worktree_git_no_longer_knows() {
        let fixture = Fixture::new();
        fixture.write_log("gone", "web", 16);

        let report = report(&fixture);
        let finding = only(&report, "state_dir_orphan");

        assert_eq!(finding.severity, Severity::Warning);
        assert!(finding.message.contains("gone"), "{}", finding.message);
    }

    #[test]
    fn a_state_dir_is_matched_by_the_sanitized_branch() {
        // The directory is named `feat-login`; the branch is `feat/login`. Comparing the two
        // without sanitizing would report every branch with a slash in it as an orphan.
        let fixture = Fixture::new();
        fixture.worktree("feat/login");
        fixture.write_log("feat/login", "web", 16);

        assert_eq!(found(&report(&fixture), "state_dir_orphan"), Vec::<&Finding>::new());
    }

    #[test]
    fn a_file_beside_the_state_dirs_is_not_one() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.state).expect("create state root");
        fs::write(fixture.state.join("README"), "not ours").expect("write file");

        assert_eq!(found(&report(&fixture), "state_dir_orphan"), Vec::<&Finding>::new());
    }

    // -----------------------------------------------------------------------------------
    // Records
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_record_whose_process_has_exited_is_an_orphan() {
        let fixture = Fixture::new();
        let path = fixture.write_record("main", "web", &dead_record());

        let report = report(&fixture);
        let finding = only(&report, "service_record_orphan");

        assert_eq!(finding.severity, Severity::Warning);
        assert!(finding.message.contains("has exited"), "{}", finding.message);
        assert_eq!(finding.detail.as_ref().expect("detail")["reason"], "exited");
        assert_eq!(finding.detail.as_ref().expect("detail")["path"], path.as_str());
    }

    #[test]
    fn a_record_whose_pid_was_reused_is_an_orphan() {
        let fixture = Fixture::new();
        fixture.write_record("main", "web", &stale_record());

        let report = report(&fixture);
        let finding = only(&report, "service_record_orphan");

        // Distinguished from an exited one: the pid is alive, which is why nothing may be
        // signalled through this record.
        assert!(finding.message.contains("belongs to something else"), "{}", finding.message);
        assert_eq!(finding.detail.as_ref().expect("detail")["reason"], "stale");
    }

    #[test]
    fn a_record_whose_process_is_running_is_not_an_orphan() {
        let fixture = Fixture::new();
        fixture.write_record("main", "web", &live_record());

        assert_eq!(found(&report(&fixture), "service_record_orphan"), Vec::<&Finding>::new());
    }

    #[test]
    fn an_unreadable_record_is_reported_separately() {
        // Separately because it is the one record `gc` must not remove: unreadable is not
        // evidence of death.
        let fixture = Fixture::new();
        fixture.write_raw_record("main", "web", "half a record");

        let report = report(&fixture);
        let finding = only(&report, "service_record_unreadable");

        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(found(&report, "service_record_orphan"), Vec::<&Finding>::new());
    }

    // -----------------------------------------------------------------------------------
    // Logs
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_log_over_the_cap_is_reported() {
        let fixture = Fixture::new();
        let path = fixture.write_log("main", "web", 65);

        let report = report_with(&fixture, &AllFree, &Cloning(true), 64);
        let finding = only(&report, "log_oversized");

        assert_eq!(finding.severity, Severity::Warning);
        assert_eq!(finding.detail.as_ref().expect("detail")["bytes"], 65);
        assert_eq!(finding.detail.as_ref().expect("detail")["cap"], 64);
        assert_eq!(finding.detail.as_ref().expect("detail")["path"], path.as_str());
    }

    #[test]
    fn a_log_exactly_at_the_cap_is_not_over_it() {
        let fixture = Fixture::new();
        fixture.write_log("main", "web", 64);

        assert_eq!(
            found(&report_with(&fixture, &AllFree, &Cloning(true), 64), "log_oversized"),
            Vec::<&Finding>::new()
        );
    }

    #[test]
    fn a_directory_among_the_logs_is_never_oversized() {
        // It would be, by size, on most filesystems — and truncating a directory is an error,
        // not a sweep.
        let fixture = Fixture::new();
        fixture.write_log("main", "web", 1);
        fs::create_dir_all(service::log_path(&fixture.state_dir("main"), "web").with_file_name("archive"))
            .expect("create dir");

        assert_eq!(found(&report_with(&fixture, &AllFree, &Cloning(true), 0), "log_oversized").len(), 1);
    }

    // -----------------------------------------------------------------------------------
    // Reflink
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_filesystem_that_cannot_clone_is_a_warning() {
        let fixture = Fixture::new();

        let report = report_with(&fixture, &AllFree, &Cloning(false), LOG_CAP);
        let finding = only(&report, "reflink_unsupported");

        assert_eq!(finding.severity, Severity::Warning);
        assert!(finding.message.contains("strategy: clone"), "{}", finding.message);
    }

    #[test]
    fn a_filesystem_that_clones_is_not_reported() {
        let fixture = Fixture::new();

        assert_eq!(found(&report(&fixture), "reflink_unsupported"), Vec::<&Finding>::new());
    }

    #[test]
    fn the_reflink_probe_leaves_nothing_behind() {
        let dir = TempDir::new().expect("temp dir");
        let path = Utf8PathBuf::from_path_buf(dir.path().to_path_buf()).expect("utf-8");

        assert_eq!(probe_reflink(&path, &Cloning(true)), Some(true));
        assert_eq!(fs::read_dir(&path).expect("list").count(), 0, "the probe files must be cleaned up");

        assert_eq!(probe_reflink(&path, &Cloning(false)), Some(false));
        assert_eq!(fs::read_dir(&path).expect("list").count(), 0, "a failed clone must clean up too");
    }

    #[test]
    fn a_probe_that_cannot_be_carried_out_says_nothing() {
        // "I could not tell" must not become "your disk is slow": the directory being
        // unwritable is a different problem with a different fix.
        assert_eq!(probe_reflink(Utf8Path::new("/nonexistent/canopywt"), &Cloning(true)), None);
        assert_eq!(check_reflink(Utf8Path::new("/nonexistent/canopywt"), &Cloning(true)), None);
    }

    #[test]
    fn the_host_clone_actually_calls_the_filesystem() {
        // The one line that cannot be faked: a clone of a file that is not there must fail.
        let dir = TempDir::new().expect("temp dir");
        let path = Utf8PathBuf::from_path_buf(dir.path().to_path_buf()).expect("utf-8");

        assert!(HostClone.clone_file(&path.join("absent"), &path.join("clone")).is_err());
    }

    // -----------------------------------------------------------------------------------
    // Listing
    // -----------------------------------------------------------------------------------

    #[test]
    fn the_cap_is_eight_mebibytes() {
        // Pinned: `gc` truncates at this number. An order of magnitude either way and a log is
        // emptied under somebody's `logs -f`, or never swept at all.
        assert_eq!(LOG_CAP, 8_388_608);
    }

    #[test]
    fn a_listing_that_failed_is_an_error_not_an_empty_directory() {
        // "I could not look" must never read as "there is nothing there": `gc` would then
        // report a clean sweep of a directory it never managed to open.
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.state.parent().expect("state parent")).expect("create canopy dir");
        fs::write(&fixture.state, "not a directory").expect("write file");

        let error = entries(&fixture.state).unwrap_err();

        assert!(matches!(error, DoctorError::Io { .. }), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
    }

    #[test]
    fn a_registry_that_cannot_be_opened_is_reported_rather_than_read_as_empty() {
        // Only "no file" means "no allocations". Any other failure to read hides every row in
        // it, and hiding rows is how two branches end up on one port.
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.ports).expect("create a directory where the registry goes");

        assert_eq!(only(&report(&fixture), "port_registry_unreadable").severity, Severity::Error);
    }

    #[test]
    fn a_state_root_that_does_not_exist_is_empty_not_an_error() {
        let fixture = Fixture::new();

        assert_eq!(entries(&fixture.state).expect("absent is empty"), Vec::<Utf8PathBuf>::new());
        assert!(report(&fixture).ok);
    }

    #[test]
    fn the_records_and_logs_directories_follow_the_service_module() {
        let state = Utf8Path::new("/state");

        assert_eq!(records_dir(state), service::record_path(state, "web").parent().expect("parent"));
        assert_eq!(logs_dir(state), service::log_path(state, "web").parent().expect("parent"));
    }

    // -----------------------------------------------------------------------------------
    // gc
    // -----------------------------------------------------------------------------------

    fn sweep(fixture: &Fixture, log_cap: u64) -> Swept {
        gc_with(&fixture.repo(), &fixture.state, &fixture.ports, log_cap).expect("gc")
    }

    #[test]
    fn gc_on_a_clean_repository_sweeps_nothing() {
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001)]);
        fixture.write_record("main", "web", &live_record());
        fixture.write_log("main", "web", 16);

        let swept = gc(&fixture.repo(), &fixture.state, &fixture.ports).expect("gc");

        assert_eq!(swept, Swept { ports_released: 0, records_removed: 0, state_dirs_removed: 0, logs_truncated: 0 });
        // And nothing was touched on the way past.
        assert!(fixture.ports.exists());
        assert!(service::record_path(&fixture.state_dir("main"), "web").exists());
    }

    #[test]
    fn gc_will_not_sweep_a_registry_it_cannot_read() {
        // The asymmetry between the two halves: `diagnose` describes a corrupt registry,
        // `gc` refuses to act on one. Releasing rows out of a file we do not understand is
        // how a port in use gets handed to somebody else.
        let fixture = Fixture::new();
        fixture.write_ports(&[("a", "web", 10_001), ("b", "web", 10_001)]);

        let error = gc_with(&fixture.repo(), &fixture.state, &fixture.ports, LOG_CAP).unwrap_err();

        assert!(matches!(error, DoctorError::Ports(_)), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
    }

    #[test]
    fn gc_releases_only_the_stale_rows() {
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001), ("gone", "web", 10_002), ("gone", "api", 10_003)]);

        let swept = sweep(&fixture, LOG_CAP);

        assert_eq!(swept.ports_released, 2);
        let rows = fixture.port_rows();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].branch, "main");
    }

    #[test]
    fn gc_leaves_a_registry_it_changes_nothing_in_alone() {
        // Rewriting an unchanged registry would take the lock and churn the file for nothing.
        let fixture = Fixture::new();
        fixture.write_ports(&[("main", "web", 10_001)]);
        let before = fs::read_to_string(&fixture.ports).expect("read");

        assert_eq!(sweep(&fixture, LOG_CAP).ports_released, 0);
        assert_eq!(fs::read_to_string(&fixture.ports).expect("read"), before);
    }

    #[test]
    fn gc_removes_dead_records_and_keeps_live_ones() {
        let fixture = Fixture::new();
        let dead = fixture.write_record("main", "dead", &dead_record());
        let stale = fixture.write_record("main", "stale", &stale_record());
        let live = fixture.write_record("main", "live", &live_record());

        let swept = sweep(&fixture, LOG_CAP);

        assert_eq!(swept.records_removed, 2);
        assert!(!dead.exists());
        assert!(!stale.exists(), "a reused pid is as dead as an exited one: nothing can be signalled through it");
        assert!(live.exists(), "never a record whose process is alive");
    }

    #[test]
    fn gc_will_not_remove_a_record_it_cannot_read() {
        // Unreadable is not evidence of death; removing it would orphan whatever it points at.
        let fixture = Fixture::new();
        let path = fixture.write_raw_record("main", "web", "half a record");

        assert_eq!(sweep(&fixture, LOG_CAP).records_removed, 0);
        assert!(path.exists());
    }

    #[test]
    fn gc_removes_a_state_dir_for_a_worktree_git_no_longer_lists() {
        let fixture = Fixture::new();
        fixture.write_log("gone", "web", 16);
        fixture.write_record("gone", "web", &dead_record());

        let swept = sweep(&fixture, LOG_CAP);

        assert_eq!(swept.state_dirs_removed, 1);
        assert!(!fixture.state_dir("gone").exists());
    }

    #[test]
    fn gc_will_not_remove_a_state_dir_git_still_lists() {
        let fixture = Fixture::new();
        fixture.worktree("feat/login");
        fixture.write_log("feat/login", "web", 16);
        fixture.write_log("main", "web", 16);

        let swept = sweep(&fixture, LOG_CAP);

        assert_eq!(swept.state_dirs_removed, 0);
        assert!(fixture.state_dir("feat/login").exists());
        assert!(fixture.state_dir("main").exists());
    }

    #[test]
    fn gc_will_not_remove_a_state_dir_with_something_still_running_in_it() {
        // The branch is gone, but the directory is the only way back to the process.
        let fixture = Fixture::new();
        let live = fixture.write_record("gone", "web", &live_record());

        let swept = sweep(&fixture, LOG_CAP);

        assert_eq!(swept.state_dirs_removed, 0);
        assert_eq!(swept.records_removed, 0);
        assert!(live.exists());
    }

    #[test]
    fn gc_truncates_an_oversized_log_rather_than_deleting_it() {
        // A `canopywt logs -f` has this file open; replacing it would leave the follower
        // watching an inode nothing writes to any more.
        let fixture = Fixture::new();
        let path = fixture.write_log("main", "web", 65);

        let swept = sweep(&fixture, 64);

        assert_eq!(swept.logs_truncated, 1);
        assert!(path.exists(), "truncated, not deleted");
        assert_eq!(fs::metadata(&path).expect("metadata").len(), 0);
    }

    #[test]
    fn gc_leaves_a_log_under_the_cap_alone() {
        let fixture = Fixture::new();
        let path = fixture.write_log("main", "web", 64);

        assert_eq!(sweep(&fixture, 64).logs_truncated, 0);
        assert_eq!(fs::metadata(&path).expect("metadata").len(), 64);
    }

    #[test]
    fn gc_does_not_count_a_log_in_a_directory_it_removed() {
        // The dead branch's oversized log goes with the directory; only the live one is
        // truncated, and the counts have to say so.
        let fixture = Fixture::new();
        fixture.write_log("gone", "web", 65);
        fixture.write_log("main", "web", 65);

        let swept = sweep(&fixture, 64);

        assert_eq!(swept.state_dirs_removed, 1);
        assert_eq!(swept.logs_truncated, 1);
    }

    #[test]
    fn gc_sweeps_exactly_what_diagnose_warned_about() {
        // The two halves have to agree: everything `gc` cleared must stop being reported, and
        // what it refused must still be.
        let fixture = Fixture::new();
        fixture.write_ports(&[("gone", "web", 10_002)]);
        fixture.write_record("main", "web", &dead_record());
        fixture.write_raw_record("main", "broken", "half a record");
        fixture.write_log("main", "web", 65);

        let before = report_with(&fixture, &AllFree, &Cloning(true), 64);
        assert_eq!(before.findings.len(), 4, "{:?}", before.findings);

        sweep(&fixture, 64);
        let after = report_with(&fixture, &AllFree, &Cloning(true), 64);

        assert_eq!(
            after.findings.iter().map(|finding| finding.check.as_str()).collect::<Vec<_>>(),
            vec!["service_record_unreadable"]
        );
    }
}
