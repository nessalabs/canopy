//! Port allocation — the one place a port number comes from.
//!
//! Every consumer (the env file, a health check, a `${ports.web}` in a `run:` line) asks this
//! module and nobody re-derives a number, because two answers to "which port is web?" is the
//! same bug as no answer at all.
//!
//! Three properties, in the order they matter:
//!
//! - **An existing allocation always wins.** A URL a developer bookmarked has to survive a
//!   restart, so a row in the registry is handed back untouched and is never re-probed — the
//!   service bound to it right now is usually the reason it is in use.
//! - **A new name starts from a hash of `project/branch/name`**, so the same branch tends to
//!   get the same numbers on every machine, and walks forward from there past anything already
//!   allocated or already bound.
//! - **The registry is the authority across branches.** The port column is unique registry-wide,
//!   which is what stops two worktrees of the same repo landing on one number.
//!
//! Ported from `packages/daemon/src/env/ports/allocator.ts`, with two deliberate differences:
//! the hash runs over UTF-8 bytes rather than UTF-16 code units (Rust has no UTF-16 to hash),
//! and the bind probe tests both IP stacks rather than IPv4 alone.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Write as _;
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use camino::{Utf8Path, Utf8PathBuf};
use fs4::{FileExt, TryLockError};
use serde::{Deserialize, Serialize};

use crate::config::PortSpec;
use crate::error::ErrorCode;

/// Where allocation looks when a port declares no range of its own.
///
/// Above the privileged range and above the ports a framework picks by default (3000, 5173,
/// 8080), below the ephemeral range macOS hands out for outbound connections.
pub const DEFAULT_RANGE: (u16, u16) = (10_000, 19_999);

/// How long a read-modify-write waits for the lock before giving up.
///
/// Long enough that a slow filesystem or a concurrent `canopywt up` finishes first, short
/// enough that a stale lock does not look like a hang.
pub const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(30);

/// The `version` written into the registry file. Bumped only for a breaking shape change.
pub const FORMAT_VERSION: u32 = 1;

/// How often the lock is retried while waiting. Small enough to be invisible to a human.
const LOCK_POLL: Duration = Duration::from_millis(25);

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/// Module-local so the crate's `Error` does not need a variant per failure here. [`code`] maps
/// each one onto the wire codes the `--json` envelope already publishes.
///
/// [`code`]: PortError::code
#[derive(Debug, thiserror::Error)]
pub enum PortError {
    /// The walk covered every port in the range and every one was taken or bound.
    #[error("no free port for {name} in {from}-{to} — every port in the range is taken")]
    RangeExhausted { name: String, from: u16, to: u16 },

    /// A reservation collided with a row another branch holds. Allocation never reports this;
    /// it walks on instead.
    #[error("port {port} is already held by {branch}/{name}")]
    PortInUse { port: u16, branch: String, name: String },

    /// `0` means "let the kernel choose", which cannot be written down as an allocation.
    #[error("{port} is not a port number that can be reserved")]
    InvalidPort { port: u16 },

    /// The file exists and could not be understood. Never silently recovered: see
    /// [`Registry::load`].
    #[error("{path} is not a usable port registry: {detail}")]
    Corrupt { path: Utf8PathBuf, detail: String },

    #[error("timed out after {}ms waiting for the lock on {path}", timeout.as_millis())]
    Locked { path: Utf8PathBuf, timeout: Duration },

    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl PortError {
    /// The stable code a caller branches on. Lock contention keeps its own code because it is
    /// the one failure here that is worth retrying unchanged.
    pub fn code(&self) -> ErrorCode {
        match self {
            PortError::RangeExhausted { .. } | PortError::PortInUse { .. } => ErrorCode::PortInUse,
            PortError::InvalidPort { .. } => ErrorCode::ConfigInvalid,
            PortError::Corrupt { .. } | PortError::Io(_) => ErrorCode::Io,
            PortError::Locked { .. } => ErrorCode::Locked,
        }
    }
}

fn corrupt(path: &Utf8Path, detail: impl Into<String>) -> PortError {
    PortError::Corrupt { path: path.to_owned(), detail: detail.into() }
}

// ---------------------------------------------------------------------------------------
// The hash
// ---------------------------------------------------------------------------------------

/// The starting point for a walk. Same input, same number, forever.
///
/// FNV-1a over the UTF-8 bytes of `project/branch/name`: tiny, dependency-free, and identical
/// in every process on every machine, which is the whole point — two developers on the same
/// branch get the same URL without talking to each other.
///
/// A reversed range is read as the interval it describes, so `(19999, 10000)` and
/// `(10000, 19999)` agree rather than one of them producing nonsense.
pub fn hash_seed(project: &str, branch: &str, name: &str, range: (u16, u16)) -> u16 {
    let (lo, hi) = normalize(range);
    let span = u32::from(hi - lo) + 1;
    let mut hash: u32 = 0x811c_9dc5;
    for byte in format!("{project}/{branch}/{name}").bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    // `lo + …` cannot exceed `hi`: the remainder is below `span`, and `lo + span - 1 == hi`.
    (u32::from(lo) + hash % span) as u16
}

/// `(from, to)` as the interval `[lo, hi]`.
fn normalize(range: (u16, u16)) -> (u16, u16) {
    let (from, to) = range;
    (from.min(to), from.max(to))
}

// ---------------------------------------------------------------------------------------
// The bind probe
// ---------------------------------------------------------------------------------------

/// "Can we actually listen on this?" — a number nobody allocated may still belong to another
/// application entirely.
///
/// A seam rather than a free function so tests can say "this port is taken" without racing the
/// machine they run on, and so an embedder can supply a probe that knows about containers.
pub trait BindProbe: Send + Sync {
    fn is_free(&self, port: u16) -> bool;
}

/// The real thing: a port counts as free only when it binds on **both** `127.0.0.1` and `::1`.
///
/// This is load-bearing. On macOS a service listening on IPv4 leaves the same port bindable on
/// IPv6 and vice versa, so a single-stack probe hands out a half-free number; the service then
/// starts, binds the stack the probe never checked, and fails in a way that looks like the
/// service is broken rather than like the port was.
///
/// A host with no IPv6 at all is a different case: there, `::1` is unbindable for every port,
/// and failing all of them would make the tool useless. The stack is detected once per process
/// and cached, and when it is absent the IPv6 half is simply not consulted.
pub struct HostProbe {
    ipv6: bool,
}

impl HostProbe {
    /// Detects the host's loopback IPv6 stack, once per process.
    ///
    /// Cached because the answer cannot change while a process runs, and probing it per port
    /// would double the syscalls on every walk.
    pub fn detect() -> HostProbe {
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        HostProbe { ipv6: *AVAILABLE.get_or_init(|| TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).is_ok()) }
    }

    /// An explicit stack assumption, for tests and for an embedder that knows better.
    pub fn with_ipv6(ipv6: bool) -> HostProbe {
        HostProbe { ipv6 }
    }

    /// Whether this probe consults `::1`.
    pub fn has_ipv6(&self) -> bool {
        self.ipv6
    }
}

impl BindProbe for HostProbe {
    fn is_free(&self, port: u16) -> bool {
        // Binding port 0 always succeeds and means "whatever the kernel has spare", so asking
        // whether 0 is free would answer yes about a port that is not a port.
        if port == 0 {
            return false;
        }
        let Ok(v4) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)) else { return false };
        // The IPv4 listener stays alive across the IPv6 bind, so what is proven is that both
        // can be held at the same time — which is what the service will do.
        let free = !self.ipv6 || TcpListener::bind((Ipv6Addr::LOCALHOST, port)).is_ok();
        drop(v4);
        free
    }
}

// ---------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------

/// One named port of one branch, for its whole life.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allocation {
    pub branch: String,
    pub name: String,
    pub port: u16,
    /// Unix seconds. Only ever informational — nothing expires.
    pub allocated_at: u64,
}

/// The on-disk shape. An object rather than a bare array so a future format change is
/// recognisable instead of a parse error.
#[derive(Debug, Serialize, Deserialize)]
struct RegistryFile {
    version: u32,
    allocations: Vec<Allocation>,
}

/// The allocation table, loaded from a JSON file.
///
/// The path is supplied rather than derived: allocation has no opinion about where a
/// repository keeps its state, and a function that computes its own path cannot be tested.
pub struct Registry {
    path: Utf8PathBuf,
    rows: Vec<Allocation>,
    probe: Box<dyn BindProbe>,
    lock_timeout: Duration,
    writes: u64,
}

/// Hand-written because the probe is a trait object: a registry is worth printing in a test
/// failure, and which probe it holds is not.
impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry").field("path", &self.path).field("rows", &self.rows).finish_non_exhaustive()
    }
}

impl Registry {
    /// Loads the registry at `path`, using the real dual-stack bind probe.
    ///
    /// A file that does not exist is an empty registry — the normal state before the first
    /// allocation. A file that exists and cannot be parsed is an error: a registry is not a
    /// cache, and quietly starting over would re-hand every port that is in use right now to
    /// somebody else.
    pub fn load(path: &Utf8Path) -> Result<Registry, PortError> {
        Registry::load_with(path, Box::new(HostProbe::detect()))
    }

    /// Loads with an explicit probe.
    pub fn load_with(path: &Utf8Path, probe: Box<dyn BindProbe>) -> Result<Registry, PortError> {
        Ok(Registry {
            rows: read_rows(path)?,
            path: path.to_owned(),
            probe,
            lock_timeout: DEFAULT_LOCK_TIMEOUT,
            writes: 0,
        })
    }

    /// Replaces the bind probe.
    #[must_use]
    pub fn with_probe(mut self, probe: Box<dyn BindProbe>) -> Registry {
        self.probe = probe;
        self
    }

    /// Overrides [`DEFAULT_LOCK_TIMEOUT`]. `Duration::ZERO` still attempts the lock once.
    #[must_use]
    pub fn with_lock_timeout(mut self, timeout: Duration) -> Registry {
        self.lock_timeout = timeout;
        self
    }

    /// The registry file this was loaded from.
    pub fn path(&self) -> &Utf8Path {
        &self.path
    }

    /// Every row, ordered by branch then name.
    pub fn rows(&self) -> &[Allocation] {
        &self.rows
    }

    /// How many times this registry has written the file. A no-op [`allocate`] does not write,
    /// and this is how a caller — or a test — can tell.
    ///
    /// [`allocate`]: Registry::allocate
    pub fn writes(&self) -> u64 {
        self.writes
    }

    /// This branch's ports, by name.
    pub fn for_branch(&self, branch: &str) -> BTreeMap<String, u16> {
        self.rows.iter().filter(|row| row.branch == branch).map(|row| (row.name.clone(), row.port)).collect()
    }

    /// Allocate-if-absent for every declared port, under the file lock.
    ///
    /// Idempotent: a second call returns the same numbers and writes nothing. The file is
    /// re-read inside the lock, so a concurrent `canopywt` in another worktree cannot be
    /// clobbered by this one, and all-or-nothing on failure, so a range that runs out does not
    /// leave half an environment written down.
    ///
    /// That re-read is also why unsaved [`reserve`] and [`release`] edits do not count here:
    /// what is on disk is what other processes can see. Call [`save`] first.
    ///
    /// [`reserve`]: Registry::reserve
    /// [`release`]: Registry::release
    /// [`save`]: Registry::save
    pub fn allocate(
        &mut self,
        project: &str,
        branch: &str,
        ports: &BTreeMap<String, PortSpec>,
    ) -> Result<BTreeMap<String, u16>, PortError> {
        let guard = self.lock()?;
        let mut rows = read_rows(&self.path)?;
        let mut taken: BTreeSet<u16> = rows.iter().map(|row| row.port).collect();
        let mut allocated = BTreeMap::new();
        let mut fresh = Vec::new();

        for (name, spec) in ports {
            if let Some(row) = rows.iter().find(|row| row.branch == branch && &row.name == name) {
                // Never re-probed: whatever is listening on it is almost certainly the service
                // this row was created for.
                allocated.insert(name.clone(), row.port);
                continue;
            }
            let range = normalize(spec.range.unwrap_or(DEFAULT_RANGE));
            let port = self.pick(project, branch, name, spec, range, &taken)?;
            taken.insert(port);
            fresh.push(Allocation { branch: branch.to_owned(), name: name.clone(), port, allocated_at: now_secs() });
            allocated.insert(name.clone(), port);
        }

        if !fresh.is_empty() {
            rows.extend(fresh);
            sort_rows(&mut rows);
            write_atomic(&self.path, &rows)?;
            self.writes += 1;
        }
        self.rows = rows;
        drop(guard);
        Ok(allocated)
    }

    /// The first usable port: the preferred one if it is inside the range and actually free,
    /// otherwise a walk forward from the hash seed, wrapping at the end of the range.
    fn pick(
        &self,
        project: &str,
        branch: &str,
        name: &str,
        spec: &PortSpec,
        range: (u16, u16),
        taken: &BTreeSet<u16>,
    ) -> Result<u16, PortError> {
        let (lo, hi) = range;
        let usable = |port: u16| !taken.contains(&port) && self.probe.is_free(port);

        // A preferred port outside the range is ignored rather than honoured: the range is the
        // narrower, more deliberate statement of the two.
        if let Some(preferred) = spec.preferred
            && (lo..=hi).contains(&preferred)
            && usable(preferred)
        {
            return Ok(preferred);
        }

        let span = u32::from(hi - lo) + 1;
        let start = u32::from(hash_seed(project, branch, name, range) - lo);
        (0..span)
            .map(|step| (u32::from(lo) + (start + step) % span) as u16)
            .find(|port| usable(*port))
            .ok_or_else(|| PortError::RangeExhausted { name: name.to_owned(), from: lo, to: hi })
    }

    /// Drops every row for a branch. Returns how many were removed.
    ///
    /// In memory only: call [`save`] to persist, and do it before [`allocate`], which reads the
    /// file rather than this object.
    ///
    /// [`allocate`]: Registry::allocate
    /// [`save`]: Registry::save
    pub fn release(&mut self, branch: &str) -> usize {
        let before = self.rows.len();
        self.rows.retain(|row| row.branch != branch);
        before - self.rows.len()
    }

    /// Pins a specific number.
    ///
    /// In memory only, like [`release`]: call [`save`] to persist.
    ///
    /// Deliberately not bind-probed. A pin is someone naming a port on purpose — a legacy
    /// client, a hard-coded webhook URL — and the service that makes it look busy is usually
    /// the one being pinned. A row another branch holds is still refused, because that is the
    /// collision the registry exists to prevent.
    ///
    /// [`release`]: Registry::release
    /// [`save`]: Registry::save
    pub fn reserve(&mut self, branch: &str, name: &str, port: u16) -> Result<(), PortError> {
        if port == 0 {
            return Err(PortError::InvalidPort { port });
        }
        if let Some(holder) = self.rows.iter().find(|row| row.port == port)
            && (holder.branch != branch || holder.name != name)
        {
            return Err(PortError::PortInUse { port, branch: holder.branch.clone(), name: holder.name.clone() });
        }
        match self.rows.iter_mut().find(|row| row.branch == branch && row.name == name) {
            Some(row) => row.port = port,
            None => self.rows.push(Allocation {
                branch: branch.to_owned(),
                name: name.to_owned(),
                port,
                allocated_at: now_secs(),
            }),
        }
        sort_rows(&mut self.rows);
        Ok(())
    }

    /// Writes what this registry holds, atomically, under the lock.
    ///
    /// Unlike [`allocate`] this does not merge with what is on disk — it is the persist half of
    /// [`reserve`] and [`release`], where the caller's copy is the intended state.
    ///
    /// [`allocate`]: Registry::allocate
    /// [`reserve`]: Registry::reserve
    /// [`release`]: Registry::release
    pub fn save(&self) -> Result<(), PortError> {
        let guard = self.lock()?;
        write_atomic(&self.path, &self.rows)?;
        drop(guard);
        Ok(())
    }

    fn lock(&self) -> Result<File, PortError> {
        acquire_lock(&self.path, self.lock_timeout)
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

/// Stable order, so the file does not churn and two registries that hold the same allocations
/// produce the same bytes.
fn sort_rows(rows: &mut [Allocation]) {
    rows.sort_by(|a, b| (&a.branch, &a.name).cmp(&(&b.branch, &b.name)));
}

// ---------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------

/// The advisory lock file for a registry: the registry path with `.lock` appended.
///
/// A sidecar rather than the registry itself, because an atomic save replaces the registry by
/// `rename`. A lock held on the old inode guards a file that is no longer the registry, and two
/// processes would each hold "the" lock on a different one.
pub fn lock_path(path: &Utf8Path) -> Utf8PathBuf {
    let name = path.file_name().unwrap_or("ports.json");
    path.with_file_name(format!("{name}.lock"))
}

/// The lock attempt itself.
///
/// A parameter rather than a fixed call because the two failures are answered very differently —
/// contention is waited out, anything else is reported at once — and there is no arrangement of
/// files on disk that makes `flock` fail for a reason other than contention.
type TryLock<'a> = dyn Fn(&File) -> Result<(), TryLockError> + 'a;

/// Holds the lock for as long as the returned file is alive: closing a file descriptor
/// releases the `flock` on it, so the guard needs no drop glue of its own.
fn acquire_lock(path: &Utf8Path, timeout: Duration) -> Result<File, PortError> {
    // UFCS: `File` grew inherent `try_lock` in 1.89 and an inherent method wins over a trait one,
    // so a plain `file.try_lock()` would silently be a different function returning a different
    // error type.
    acquire_lock_with(path, timeout, &|file| FileExt::try_lock(file))
}

fn acquire_lock_with(path: &Utf8Path, timeout: Duration, try_lock: &TryLock<'_>) -> Result<File, PortError> {
    let lock = lock_path(path);
    // A bare `ports.json` has an empty parent — the current directory, which is already there and
    // which `create_dir_all` would refuse to be handed.
    lock.parent().filter(|parent| !parent.as_str().is_empty()).map_or(Ok(()), fs::create_dir_all)?;
    let file = File::options().create(true).read(true).write(true).truncate(false).open(&lock)?;
    let deadline = Instant::now() + timeout;
    loop {
        match try_lock(&file) {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(error)) => return Err(PortError::Io(error)),
        }
        if Instant::now() >= deadline {
            return Err(PortError::Locked { path: lock, timeout });
        }
        std::thread::sleep(LOCK_POLL);
    }
}

fn read_rows(path: &Utf8Path) -> Result<Vec<Allocation>, PortError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(PortError::Io(error)),
    };
    // A save writes the whole document or nothing, so an empty file is damage, not a new
    // registry — and treating it as new would re-hand every port in it.
    if text.trim().is_empty() {
        return Err(corrupt(path, "the file is empty"));
    }
    let file: RegistryFile = serde_json::from_str(&text).map_err(|error| corrupt(path, error.to_string()))?;
    if file.version != FORMAT_VERSION {
        return Err(corrupt(path, format!("unsupported registry version {}", file.version)));
    }
    let mut rows = file.allocations;
    sort_rows(&mut rows);
    if let Some(duplicate) = first_duplicate(rows.iter().map(|row| (&row.branch, &row.name))) {
        return Err(corrupt(path, format!("{}/{} appears twice", duplicate.0, duplicate.1)));
    }
    let mut ports: Vec<u16> = rows.iter().map(|row| row.port).collect();
    ports.sort_unstable();
    if let Some(port) = first_duplicate(ports.iter()) {
        return Err(corrupt(path, format!("port {port} is claimed twice")));
    }
    Ok(rows)
}

/// The first value equal to the one before it. Input must be sorted by the same key.
fn first_duplicate<T: PartialEq>(items: impl IntoIterator<Item = T>) -> Option<T> {
    let mut previous: Option<T> = None;
    for item in items {
        if previous.as_ref() == Some(&item) {
            return Some(item);
        }
        previous = Some(item);
    }
    None
}

/// Distinguishes concurrent temp files. Two threads of one process are serialized by the lock,
/// but a crash between `create` and `rename` should not leave a name the next run reuses.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write, `fsync`, `rename`. In that order, and to a temp file in the *same* directory so the
/// rename is atomic — a cross-filesystem rename is a copy, which is exactly the partial write
/// this is avoiding.
fn write_atomic(path: &Utf8Path, rows: &[Allocation]) -> Result<(), PortError> {
    let document = RegistryFile { version: FORMAT_VERSION, allocations: rows.to_vec() };
    let mut json = serde_json::to_vec_pretty(&document).map_err(|error| PortError::Io(error.into()))?;
    json.push(b'\n');

    let name = path.file_name().unwrap_or("ports.json");
    let serial = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_file_name(format!(".{name}.{}.{serial}.tmp", std::process::id()));

    if let Err(error) = write_and_sync(&temp, &json) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(PortError::Io(error));
    }
    Ok(())
}

fn write_and_sync(temp: &Utf8Path, json: &[u8]) -> Result<(), PortError> {
    let mut file = File::create(temp)?;
    file.write_all(json)?;
    // Without this the rename can land before the bytes do, and a power cut leaves a registry
    // that is a valid name pointing at an empty file.
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use rstest::rstest;

    use super::*;

    const PROJECT: &str = "canopy";

    // -----------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------

    /// A machine whose only occupied ports are the ones named, so a test can say "this one is
    /// taken" without racing whatever else is listening on the host it runs on.
    struct FakeProbe {
        busy: BTreeSet<u16>,
    }

    impl FakeProbe {
        fn free() -> Box<FakeProbe> {
            FakeProbe::busy(&[])
        }

        fn busy(ports: &[u16]) -> Box<FakeProbe> {
            Box::new(FakeProbe { busy: ports.iter().copied().collect() })
        }
    }

    impl BindProbe for FakeProbe {
        fn is_free(&self, port: u16) -> bool {
            !self.busy.contains(&port)
        }
    }

    fn temp_registry() -> (tempfile::TempDir, Utf8PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = Utf8PathBuf::from_path_buf(dir.path().join("ports.json")).unwrap();
        (dir, path)
    }

    fn open(path: &Utf8Path, probe: Box<dyn BindProbe>) -> Registry {
        Registry::load_with(path, probe).unwrap()
    }

    fn specs(names: &[&str]) -> BTreeMap<String, PortSpec> {
        names.iter().map(|name| ((*name).to_owned(), PortSpec::default())).collect()
    }

    fn spec(preferred: Option<u16>, range: Option<(u16, u16)>) -> PortSpec {
        PortSpec { preferred, range, description: None }
    }

    fn one(name: &str, spec: PortSpec) -> BTreeMap<String, PortSpec> {
        BTreeMap::from([(name.to_owned(), spec)])
    }

    /// Everything in the registry's directory, sorted.
    fn listing(path: &Utf8Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Half-written registries: the temp file an atomic save creates and renames away.
    fn temp_files(path: &Utf8Path) -> Vec<String> {
        listing(path).into_iter().filter(|name| name.ends_with(".tmp")).collect()
    }

    // -----------------------------------------------------------------------------------
    // The hash
    // -----------------------------------------------------------------------------------

    #[test]
    fn hash_seed_is_deterministic_and_in_range() {
        let mut seen = BTreeSet::new();
        for index in 0..1000u32 {
            let branch = format!("feat/{index}-{}", index.wrapping_mul(2_654_435_761) % 9973);
            let seed = hash_seed(PROJECT, &branch, "web", DEFAULT_RANGE);
            assert_eq!(seed, hash_seed(PROJECT, &branch, "web", DEFAULT_RANGE), "{branch} moved");
            assert!((DEFAULT_RANGE.0..=DEFAULT_RANGE.1).contains(&seed), "{branch} → {seed}");
            seen.insert(seed);
        }
        // A constant would satisfy everything above; the point of a hash is that it spreads.
        assert!(seen.len() > 900, "1000 branches produced only {} distinct seeds", seen.len());
    }

    /// The golden table. These numbers are a contract: a developer's bookmarked URL depends on
    /// this function answering the same thing next year, so a refactor that changes the hash,
    /// the separator or the byte order has to fail here rather than in someone's browser.
    #[rstest]
    #[case(PROJECT, "main", "web", DEFAULT_RANGE, 17050)]
    #[case(PROJECT, "main", "api", DEFAULT_RANGE, 11748)]
    #[case(PROJECT, "feat/login", "web", DEFAULT_RANGE, 17673)]
    #[case(PROJECT, "feat/login", "api", DEFAULT_RANGE, 12847)]
    // The project is part of the key, so two repos with the same branch do not pile up.
    #[case("other", "main", "web", DEFAULT_RANGE, 19790)]
    #[case(PROJECT, "main", "web", (3000, 3099), 3050)]
    #[case(PROJECT, "", "", DEFAULT_RANGE, 13719)]
    #[case(PROJECT, "main", "web", (0, 65535), 14906)]
    fn hash_seed_is_pinned(
        #[case] project: &str,
        #[case] branch: &str,
        #[case] name: &str,
        #[case] range: (u16, u16),
        #[case] expected: u16,
    ) {
        assert_eq!(hash_seed(project, branch, name, range), expected);
    }

    #[test]
    fn hash_seed_hashes_utf8_bytes() {
        // The TypeScript original hashes UTF-16 code units; hashing bytes is the difference,
        // and a non-ASCII branch is where the two would disagree.
        assert_eq!(hash_seed(PROJECT, "功能/ログイン", "web", DEFAULT_RANGE), 16296);
        assert_eq!(hash_seed(PROJECT, "café", "web", DEFAULT_RANGE), hash_seed(PROJECT, "café", "web", DEFAULT_RANGE));
        // Same characters, different bytes: a hash over `char` values as u32 would collide here.
        assert_ne!(hash_seed(PROJECT, "café", "web", DEFAULT_RANGE), hash_seed(PROJECT, "cafe", "web", DEFAULT_RANGE));
    }

    #[test]
    fn hash_seed_differs_per_port_name() {
        let seeds: BTreeSet<u16> =
            ["web", "api", "db", "worker"].iter().map(|name| hash_seed(PROJECT, "main", name, DEFAULT_RANGE)).collect();
        assert_eq!(seeds.len(), 4, "port names share a seed: {seeds:?}");
    }

    #[test]
    fn hash_seed_reads_a_reversed_range_as_the_same_interval() {
        assert_eq!(
            hash_seed(PROJECT, "main", "web", (19_999, 10_000)),
            hash_seed(PROJECT, "main", "web", DEFAULT_RANGE)
        );
    }

    #[test]
    fn hash_seed_of_a_one_port_range_is_that_port() {
        assert_eq!(hash_seed(PROJECT, "main", "web", (8080, 8080)), 8080);
        assert_eq!(hash_seed(PROJECT, "whatever", "thing", (8080, 8080)), 8080);
    }

    // -----------------------------------------------------------------------------------
    // Allocation
    // -----------------------------------------------------------------------------------

    #[test]
    fn allocation_is_idempotent() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());

        let first = registry.allocate(PROJECT, "main", &specs(&["web", "api"])).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first["web"], hash_seed(PROJECT, "main", "web", DEFAULT_RANGE));
        assert_eq!(registry.rows().len(), 2);
        assert_eq!(registry.writes(), 1);

        let second = registry.allocate(PROJECT, "main", &specs(&["web", "api"])).unwrap();
        assert_eq!(second, first);
        assert_eq!(registry.rows().len(), 2, "the registry grew on a repeat allocation");
        assert_eq!(registry.writes(), 1, "a repeat allocation rewrote the file");

        // And across a reload, which is what a second process sees.
        let reloaded = open(&path, FakeProbe::free()).for_branch("main");
        assert_eq!(reloaded, first);
    }

    #[test]
    fn allocating_nothing_writes_nothing() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        assert!(registry.allocate(PROJECT, "main", &BTreeMap::new()).unwrap().is_empty());
        assert_eq!(registry.writes(), 0);
        assert!(!path.exists(), "an empty allocation created a registry file");
    }

    #[test]
    fn two_branches_never_collide_even_when_their_seeds_match() {
        // Found by search: these two hash to the same starting point in the default range.
        let seed = hash_seed(PROJECT, "b92", "web", DEFAULT_RANGE);
        assert_eq!(seed, hash_seed(PROJECT, "b166", "web", DEFAULT_RANGE), "the fixture no longer collides");

        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        let first = registry.allocate(PROJECT, "b92", &specs(&["web"])).unwrap()["web"];
        let second = registry.allocate(PROJECT, "b166", &specs(&["web"])).unwrap()["web"];

        assert_eq!(first, seed);
        assert_eq!(second, seed + 1, "the loser of a seed collision should take the next port");
        assert_ne!(first, second);
        assert_eq!(registry.rows().len(), 2);
    }

    fn unix_now() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    #[test]
    fn now_secs_is_unix_seconds() {
        // Any clock this code runs under is well past 2025; a stub is not.
        assert!(now_secs() > 1_750_000_000, "{} is not a plausible unix time", now_secs());
        assert!(now_secs().abs_diff(unix_now()) <= 1);
    }

    #[test]
    fn allocated_at_is_the_time_of_allocation() {
        let before = unix_now();
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap();
        let after = unix_now();

        let stamp = registry.rows().first().unwrap().allocated_at;
        assert!((before..=after).contains(&stamp), "{stamp} is not between {before} and {after}");
    }

    #[test]
    fn for_branch_returns_only_that_branch() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        registry.allocate(PROJECT, "main", &specs(&["web", "api"])).unwrap();
        registry.allocate(PROJECT, "feat/login", &specs(&["web"])).unwrap();

        assert_eq!(registry.for_branch("main").keys().collect::<Vec<_>>(), ["api", "web"]);
        assert_eq!(registry.for_branch("feat/login").len(), 1);
        assert!(registry.for_branch("nobody").is_empty());
    }

    #[test]
    fn a_port_held_by_a_real_listener_is_skipped() {
        // Bind the seed *inside* the search rather than checking it and binding after: any
        // gap between the two is a window in which another test on this machine takes the
        // port, and the walk then steps over it for a reason this test is not about.
        let (branch, seed, held) = (0..500)
            .find_map(|index| {
                let branch = format!("real-{}-{index}", std::process::id());
                let seed = hash_seed(PROJECT, &branch, "web", DEFAULT_RANGE);
                let held = TcpListener::bind((Ipv4Addr::LOCALHOST, seed)).ok()?;
                Some((branch, seed, held))
            })
            .expect("no bindable seed in 10000-19999");

        // The property: a port something is genuinely listening on is not handed out.
        let (_dir2, path2) = temp_registry();
        let mut registry = Registry::load(&path2).unwrap();
        let allocated = registry.allocate(PROJECT, &branch, &specs(&["web"])).unwrap()["web"];
        assert_ne!(allocated, seed, "a port held by a real listener was handed out anyway");
        assert!(allocated > seed, "the walk goes forward from the seed, not backwards");
        drop(held);

        // And with nothing in the way the seed is exactly what comes back. A probe rather than
        // the host, because between releasing the port above and asking for it again anything
        // else on this machine may have claimed it — which would make this assert the state of
        // the machine rather than the behaviour of the allocator.
        let (_dir, path) = temp_registry();
        let mut registry = Registry::load(&path).unwrap().with_probe(FakeProbe::busy(&[]));
        assert_eq!(registry.allocate(PROJECT, &branch, &specs(&["web"])).unwrap()["web"], seed);
    }

    #[test]
    fn binding_requires_both_v4_and_v6() {
        let probe = HostProbe::detect();

        let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let held_on_v4 = v4.local_addr().unwrap().port();
        assert!(!probe.is_free(held_on_v4), "a port held on IPv4 was reported free");

        // The kernel assigns an IPv6 ephemeral port without regard to IPv4, so a port held on
        // `::1` is not guaranteed free on `127.0.0.1`. Confirm it rather than assume it: under a
        // parallel suite the same number is occasionally taken on the other stack, and asserting
        // on that assumption is a flake that only shows up under load.
        let held = probe
            .has_ipv6()
            .then(|| {
                (0..32).find_map(|_| {
                    let v6 = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).ok()?;
                    let port = v6.local_addr().ok()?.port();
                    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok().map(|v4| {
                        drop(v4);
                        (v6, port)
                    })
                })
            })
            .flatten();
        held.into_iter().for_each(|(_v6, held_on_v6)| {
            // The half a single-stack probe misses, and the reason this test exists.
            assert!(!probe.is_free(held_on_v6), "a port held only on IPv6 was reported free");
            // On a host with no IPv6 the same port is free: `::1` is unbindable for every port
            // there, and failing all of them would leave nothing to allocate.
            assert!(HostProbe::with_ipv6(false).is_free(held_on_v6), "IPv4 was busy for a port we confirmed free");
        });

        let spare = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port();
        assert!(probe.is_free(spare), "a port nobody holds was reported busy");
    }

    #[test]
    fn a_probe_reports_which_stacks_it_consults() {
        assert!(HostProbe::with_ipv6(true).has_ipv6());
        assert!(!HostProbe::with_ipv6(false).has_ipv6());
        // Detection is not a guess: it agrees with what the host actually does.
        assert_eq!(HostProbe::detect().has_ipv6(), TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).is_ok());
    }

    #[test]
    fn port_zero_is_never_free() {
        // Binding 0 succeeds and means "any port", which would make 0 look allocatable.
        assert!(!HostProbe::detect().is_free(0));
        assert!(!HostProbe::with_ipv6(false).is_free(0));
    }

    #[test]
    fn preferred_is_honoured_when_free_and_walked_past_when_not() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        assert_eq!(registry.allocate(PROJECT, "main", &one("api", spec(Some(14000), None))).unwrap()["api"], 14000);

        // A second branch wanting the same number gets its own hash seed instead.
        let second = registry.allocate(PROJECT, "feat/login", &one("api", spec(Some(14000), None))).unwrap()["api"];
        assert_eq!(second, hash_seed(PROJECT, "feat/login", "api", DEFAULT_RANGE));
        assert_ne!(second, 14000);
    }

    #[test]
    fn a_preferred_port_something_is_listening_on_is_walked_past() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::busy(&[14000]));
        let port = registry.allocate(PROJECT, "main", &one("api", spec(Some(14000), None))).unwrap()["api"];
        assert_eq!(port, hash_seed(PROJECT, "main", "api", DEFAULT_RANGE));
        assert_ne!(port, 14000);
    }

    #[test]
    fn a_preferred_port_outside_the_range_is_ignored() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        let ports = one("api", spec(Some(3000), Some((20_000, 20_099))));
        let port = registry.allocate(PROJECT, "main", &ports).unwrap()["api"];
        assert!((20_000..=20_099).contains(&port), "{port} escaped the declared range");
    }

    #[test]
    fn a_per_port_range_overrides_the_default() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        let ports = BTreeMap::from([
            ("debug".to_owned(), spec(None, Some((9000, 9100)))),
            ("web".to_owned(), spec(None, None)),
        ]);
        let allocated = registry.allocate(PROJECT, "main", &ports).unwrap();

        assert_eq!(allocated["debug"], hash_seed(PROJECT, "main", "debug", (9000, 9100)));
        assert!((9000..=9100).contains(&allocated["debug"]));
        assert!((DEFAULT_RANGE.0..=DEFAULT_RANGE.1).contains(&allocated["web"]));
    }

    #[test]
    fn range_exhaustion_is_a_clear_error_not_an_infinite_loop() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        let tiny = (10_000, 10_002);
        let ports: BTreeMap<String, PortSpec> =
            ["a", "b", "c", "d"].iter().map(|name| ((*name).to_owned(), spec(None, Some(tiny)))).collect();

        let error = registry.allocate(PROJECT, "main", &ports).unwrap_err();
        let PortError::RangeExhausted { name, from, to } = &error else { panic!("not exhausted: {error:?}") };
        assert_eq!((*from, *to), tiny);
        assert_eq!(name, "d", "the fourth port is the one that cannot be placed");
        assert_eq!(error.code(), ErrorCode::PortInUse);

        // All-or-nothing: three ports did fit, and none of them were written down.
        assert!(registry.rows().is_empty());
        assert_eq!(registry.writes(), 0);
        assert!(!path.exists());

        // Three in the same range is fine, which is what makes the fourth the boundary.
        let three: BTreeMap<String, PortSpec> =
            ["a", "b", "c"].iter().map(|name| ((*name).to_owned(), spec(None, Some(tiny)))).collect();
        let allocated = registry.allocate(PROJECT, "main", &three).unwrap();
        assert_eq!(allocated.values().copied().collect::<BTreeSet<u16>>(), BTreeSet::from([10_000, 10_001, 10_002]));
    }

    #[test]
    fn a_range_where_every_port_is_bound_is_exhausted_too() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::busy(&[10_000, 10_001, 10_002]));
        let ports = one("web", spec(None, Some((10_000, 10_002))));
        assert!(matches!(registry.allocate(PROJECT, "main", &ports), Err(PortError::RangeExhausted { .. })));
    }

    // -----------------------------------------------------------------------------------
    // Reserve and release
    // -----------------------------------------------------------------------------------

    #[test]
    fn reserve_pins_a_specific_port() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        registry.reserve("main", "web", 4000).unwrap();
        assert_eq!(registry.for_branch("main")["web"], 4000);
        registry.save().unwrap();

        // A pin survives allocation: the declared port already has a row.
        let allocated = registry.allocate(PROJECT, "main", &specs(&["web", "api"])).unwrap();
        assert_eq!(allocated["web"], 4000);
        assert_eq!(allocated["api"], hash_seed(PROJECT, "main", "api", DEFAULT_RANGE));

        // Re-pinning the same name moves it rather than duplicating it.
        registry.reserve("main", "web", 4001).unwrap();
        assert_eq!(registry.for_branch("main")["web"], 4001);
        assert_eq!(registry.rows().iter().filter(|row| row.name == "web").count(), 1);

        // Re-pinning the same name to the same port is a no-op, not a self-collision.
        registry.reserve("main", "web", 4001).unwrap();
        assert_eq!(registry.rows().len(), 2);
    }

    #[test]
    fn reserve_refuses_a_port_another_branch_holds() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        registry.reserve("main", "web", 4000).unwrap();

        let error = registry.reserve("feat/login", "web", 4000).unwrap_err();
        let PortError::PortInUse { port, branch, name } = &error else { panic!("not a collision: {error:?}") };
        assert_eq!(*port, 4000);
        assert_eq!(branch, "main");
        assert_eq!(name, "web");
        assert_eq!(error.code(), ErrorCode::PortInUse);
        assert_eq!(registry.rows().len(), 1, "a refused reservation still wrote a row");

        // A different port for the same branch is fine — it is the number that collides.
        registry.reserve("feat/login", "web", 4001).unwrap();
        assert_eq!(registry.rows().len(), 2);
    }

    #[test]
    fn reserve_refuses_port_zero() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        let error = registry.reserve("main", "web", 0).unwrap_err();
        assert!(matches!(error, PortError::InvalidPort { port: 0 }), "{error:?}");
        assert_eq!(error.code(), ErrorCode::ConfigInvalid);
        assert!(registry.rows().is_empty());
    }

    #[test]
    fn release_frees_rows_and_they_can_be_reused() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        let before = registry.allocate(PROJECT, "feat/login", &specs(&["web", "api"])).unwrap();
        registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap();

        assert_eq!(registry.release("nobody"), 0, "releasing an unknown branch removed rows");
        assert_eq!(registry.release("feat/login"), 2);
        assert!(registry.for_branch("feat/login").is_empty());
        assert_eq!(registry.for_branch("main").len(), 1, "release took another branch's rows");
        registry.save().unwrap();

        // The numbers come back, because the seed did not move.
        let mut reopened = open(&path, FakeProbe::free());
        assert_eq!(reopened.rows().len(), 1);
        assert_eq!(reopened.allocate(PROJECT, "feat/login", &specs(&["web", "api"])).unwrap(), before);
    }

    // -----------------------------------------------------------------------------------
    // The file
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_registry_prints_its_path_and_its_rows() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap();
        let text = format!("{registry:?}");
        assert!(text.contains("ports.json"), "{text}");
        assert!(text.contains("web"), "{text}");
    }

    #[test]
    fn a_missing_registry_is_empty_not_an_error() {
        let (_dir, path) = temp_registry();
        let registry = open(&path, FakeProbe::free());
        assert!(registry.rows().is_empty());
        assert_eq!(registry.path(), path.as_path());
    }

    #[test]
    fn allocation_creates_the_directory_the_registry_lives_in() {
        // The path is usually somewhere under the git dir that nothing has made yet.
        let dir = tempfile::tempdir().unwrap();
        let path = Utf8PathBuf::from_path_buf(dir.path().join("state/canopy/ports.json")).unwrap();
        let mut registry = open(&path, FakeProbe::free());

        assert_eq!(registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap().len(), 1);
        assert!(path.exists(), "{path} was not created");
    }

    #[test]
    fn an_unreadable_registry_is_an_error_not_an_empty_table() {
        // Only "no such file" means "nothing allocated yet". Every other read failure —
        // a directory in the way, a permission problem — is a registry we cannot see, and
        // treating it as empty would re-hand every port in it.
        let (_dir, path) = temp_registry();
        fs::create_dir(&path).unwrap();

        let error = Registry::load_with(&path, FakeProbe::free()).unwrap_err();
        assert!(matches!(error, PortError::Io(_)), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
    }

    #[rstest]
    // Truncated mid-document: the shape a crashed writer would leave behind.
    #[case("{\"version\": 1, \"allocations\": [{\"branch\": \"mai")]
    #[case("not json at all")]
    // Zero bytes. A save writes the whole document or nothing, so this is damage.
    #[case("")]
    #[case("   \n")]
    // Right JSON, wrong shape.
    #[case("{\"version\": 1, \"allocations\": \"nope\"}")]
    #[case("[]")]
    // A row missing a field would hand back a port with no name.
    #[case("{\"version\": 1, \"allocations\": [{\"branch\": \"main\", \"port\": 10000}]}")]
    // A format this binary does not understand is not a licence to overwrite it.
    #[case("{\"version\": 2, \"allocations\": []}")]
    // Two rows for one port: the exact collision the registry exists to prevent.
    #[case(
        "{\"version\": 1, \"allocations\": [\
         {\"branch\": \"a\", \"name\": \"web\", \"port\": 10000, \"allocated_at\": 1},\
         {\"branch\": \"b\", \"name\": \"web\", \"port\": 10000, \"allocated_at\": 1}]}"
    )]
    // One name twice in one branch.
    #[case(
        "{\"version\": 1, \"allocations\": [\
         {\"branch\": \"a\", \"name\": \"web\", \"port\": 10000, \"allocated_at\": 1},\
         {\"branch\": \"a\", \"name\": \"web\", \"port\": 10001, \"allocated_at\": 1}]}"
    )]
    fn a_corrupt_registry_file_is_an_error_not_a_silent_reset(#[case] content: &str) {
        let (_dir, path) = temp_registry();
        fs::write(&path, content).unwrap();

        let error = Registry::load_with(&path, FakeProbe::free()).unwrap_err();
        match &error {
            PortError::Corrupt { path: reported, detail } => {
                assert_eq!(reported, &path);
                assert!(!detail.is_empty(), "a corruption report with no detail is not actionable");
            }
            other => panic!("expected Corrupt, got {other:?}"),
        }
        assert_eq!(error.code(), ErrorCode::Io);
        // The damaged file is still there to be looked at, not replaced with an empty one.
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }

    #[test]
    fn an_unknown_field_in_a_row_is_not_corruption() {
        // A newer canopywt may add a column; refusing the whole table over it would strand
        // every worktree on the older binary.
        let (_dir, path) = temp_registry();
        fs::write(
            &path,
            "{\"version\": 1, \"allocations\": [{\"branch\": \"a\", \"name\": \"web\", \"port\": 10000, \
             \"allocated_at\": 7, \"note\": \"from the future\"}]}",
        )
        .unwrap();
        let registry = Registry::load_with(&path, FakeProbe::free()).unwrap();
        assert_eq!(registry.for_branch("a")["web"], 10000);
    }

    #[test]
    fn the_registry_round_trips_through_disk() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        registry.allocate(PROJECT, "main", &specs(&["web", "api"])).unwrap();
        registry.allocate(PROJECT, "feat/login", &specs(&["web"])).unwrap();
        registry.reserve("release", "db", 5432).unwrap();
        registry.save().unwrap();

        let reloaded = open(&path, FakeProbe::free());
        assert_eq!(reloaded.rows(), registry.rows());
        assert_eq!(reloaded.rows().len(), 4);
        // Ordered by branch then name, so the file does not churn between saves.
        let keys: Vec<(&str, &str)> =
            reloaded.rows().iter().map(|row| (row.branch.as_str(), row.name.as_str())).collect();
        assert_eq!(keys, [("feat/login", "web"), ("main", "api"), ("main", "web"), ("release", "db")]);

        // And it is JSON a human can read and a script can parse.
        let text = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["allocations"].as_array().unwrap().len(), 4);
        assert!(text.ends_with('\n'), "the file should end with a newline");
    }

    #[test]
    fn an_atomic_write_leaves_no_partial_file() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free());
        for index in 0..20 {
            registry.allocate(PROJECT, &format!("branch-{index}"), &specs(&["web", "api"])).unwrap();
        }
        assert_eq!(registry.rows().len(), 40);
        // Twenty saves, and the only things on disk are the registry and its lock.
        assert_eq!(listing(&path), ["ports.json", "ports.json.lock"]);

        // A save that cannot land leaves the previous table intact rather than truncating it:
        // renaming onto a directory fails after the temp file is already written and synced.
        let good = fs::read_to_string(&path).unwrap();
        let blocked = path.parent().unwrap().join("blocked");
        fs::create_dir(&blocked).unwrap();
        let mut doomed = open(&path, FakeProbe::free());
        doomed.path = blocked.clone();
        let error = doomed.save().unwrap_err();
        assert!(matches!(error, PortError::Io(_)), "{error:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), good, "the good registry was damaged");
        assert!(temp_files(&path).is_empty(), "a failed rename left {:?} behind", temp_files(&path));
    }

    #[test]
    fn a_held_lock_times_out_as_locked() {
        let (_dir, path) = temp_registry();
        let mut registry = open(&path, FakeProbe::free()).with_lock_timeout(Duration::from_millis(50));

        // Exactly what another process does, and flock contends per open file, so the same
        // process is a faithful stand-in.
        let held = File::options().create(true).read(true).write(true).truncate(false).open(lock_path(&path)).unwrap();
        FileExt::lock(&held).unwrap();

        let error = registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap_err();
        let PortError::Locked { path: reported, timeout } = &error else { panic!("not locked: {error:?}") };
        assert_eq!(reported, &lock_path(&path));
        assert_eq!(*timeout, Duration::from_millis(50));
        assert_eq!(error.code(), ErrorCode::Locked);
        assert_eq!(error.code().exit_code(), 3);
        assert!(!path.exists(), "a call that never got the lock still wrote");

        FileExt::unlock(&held).unwrap();
        // The lock was the only obstacle.
        assert_eq!(registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap().len(), 1);
    }

    #[test]
    fn a_write_that_cannot_be_created_is_reported_and_leaves_nothing() {
        let (_dir, path) = temp_registry();
        let sealed = path.parent().unwrap().join("sealed");
        fs::create_dir(&sealed).unwrap();
        let registry_path = sealed.join("ports.json");
        // The lock is taken before the write, so it has to already exist — otherwise the run
        // fails while opening the lock and never reaches the write under test.
        File::create(lock_path(&registry_path)).unwrap();
        fs::set_permissions(sealed.as_std_path(), fs::Permissions::from_mode(0o555)).unwrap();

        let mut registry = open(&registry_path, FakeProbe::free());
        let error = registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap_err();

        assert!(matches!(error, PortError::Io(_)), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
        // A write that never landed must not be remembered as one: the in-memory table is what
        // the caller goes on to write into an env file.
        assert!(registry.rows().is_empty(), "a failed write still updated the table");
        assert_eq!(registry.writes(), 0, "a failed write was counted as a write");
        assert!(!registry_path.exists(), "a failed write left a registry behind");
        assert!(temp_files(&registry_path).is_empty(), "left {:?} behind", temp_files(&registry_path));

        fs::set_permissions(sealed.as_std_path(), fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_lock_failure_that_is_not_contention_is_reported_at_once() {
        let (_dir, path) = temp_registry();
        let attempts = std::cell::Cell::new(0u32);
        let broken = |_: &File| {
            attempts.set(attempts.get() + 1);
            Err(TryLockError::Error(std::io::Error::from(std::io::ErrorKind::PermissionDenied)))
        };

        let began = Instant::now();
        let error = acquire_lock_with(&path, Duration::from_secs(30), &broken).unwrap_err();

        // Waiting one out would spend the whole timeout on a lock that is never going to be
        // granted, and then report contention for something that was not contention.
        assert!(matches!(error, PortError::Io(_)), "{error:?}");
        assert_eq!(error.code(), ErrorCode::Io);
        assert_eq!(attempts.get(), 1, "a lock failure was retried");
        assert!(began.elapsed() < Duration::from_secs(1), "a lock failure burned the timeout");
    }

    #[test]
    fn the_lock_is_a_sidecar_not_the_registry_itself() {
        // A lock on the registry inode would be a lock on a file `rename` is about to replace.
        assert_eq!(lock_path(Utf8Path::new("/tmp/x/ports.json")), Utf8PathBuf::from("/tmp/x/ports.json.lock"));
    }

    #[test]
    fn concurrent_allocation_under_the_lock_produces_disjoint_sets() {
        let (_dir, path) = temp_registry();
        // A range narrow enough that two independent walks would land on each other if the
        // lock and the re-read inside it were not doing their job.
        let names = ["web", "api", "db", "worker", "debug"];
        let ports: BTreeMap<String, PortSpec> =
            names.iter().map(|name| ((*name).to_owned(), spec(None, Some((10_000, 10_019))))).collect();

        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = ["left", "right"]
                .iter()
                .map(|branch| {
                    let path = path.clone();
                    let ports = ports.clone();
                    scope.spawn(move || {
                        let mut registry = Registry::load_with(&path, FakeProbe::free()).unwrap();
                        registry.allocate(PROJECT, branch, &ports).unwrap()
                    })
                })
                .collect();
            handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
        });

        let left: BTreeSet<u16> = results[0].values().copied().collect();
        let right: BTreeSet<u16> = results[1].values().copied().collect();
        assert_eq!(left.len(), names.len());
        assert_eq!(right.len(), names.len());
        assert!(left.is_disjoint(&right), "two branches were handed the same port: {left:?} vs {right:?}");

        // And the file holds both sets: a lost update would show up as missing rows.
        let final_rows = open(&path, FakeProbe::free());
        assert_eq!(final_rows.rows().len(), 2 * names.len());
        let stored: BTreeSet<u16> = final_rows.rows().iter().map(|row| row.port).collect();
        assert_eq!(stored, left.union(&right).copied().collect::<BTreeSet<u16>>());
    }

    #[test]
    fn a_replaced_probe_is_the_one_consulted() {
        let (_dir, path) = temp_registry();
        let seed = hash_seed(PROJECT, "main", "web", DEFAULT_RANGE);
        // Loaded with a probe that calls everything free, then handed one that does not.
        let mut registry = open(&path, FakeProbe::free()).with_probe(FakeProbe::busy(&[seed]));

        assert_eq!(registry.allocate(PROJECT, "main", &specs(&["web"])).unwrap()["web"], seed + 1);
    }

    #[test]
    fn allocation_sees_rows_another_process_wrote() {
        let (_dir, path) = temp_registry();
        let mut mine = open(&path, FakeProbe::free());
        let mut theirs = open(&path, FakeProbe::free());

        let seed = hash_seed(PROJECT, "b92", "web", DEFAULT_RANGE);
        assert_eq!(theirs.allocate(PROJECT, "b92", &specs(&["web"])).unwrap()["web"], seed);
        // `mine` was loaded before that row existed; the re-read under the lock is what stops
        // it handing out the same number.
        assert_eq!(mine.allocate(PROJECT, "b166", &specs(&["web"])).unwrap()["web"], seed + 1);
    }

    #[test]
    fn first_duplicate_finds_the_second_of_a_pair() {
        assert_eq!(first_duplicate([1, 2, 3]), None);
        assert_eq!(first_duplicate([1, 2, 2, 3]), Some(2));
        assert_eq!(first_duplicate([1, 1]), Some(1));
        assert_eq!(first_duplicate(Vec::<u8>::new()), None);
    }

    #[test]
    fn error_messages_name_the_thing_that_went_wrong() {
        let exhausted = PortError::RangeExhausted { name: "web".to_owned(), from: 10_000, to: 10_002 };
        assert!(exhausted.to_string().contains("web"), "{exhausted}");
        assert!(exhausted.to_string().contains("10000-10002"), "{exhausted}");

        let held = PortError::PortInUse { port: 4000, branch: "main".to_owned(), name: "web".to_owned() };
        assert!(held.to_string().contains("4000") && held.to_string().contains("main/web"), "{held}");

        let locked =
            PortError::Locked { path: Utf8PathBuf::from("/x/ports.json.lock"), timeout: Duration::from_secs(30) };
        assert!(
            locked.to_string().contains("30000ms") && locked.to_string().contains("/x/ports.json.lock"),
            "{locked}"
        );
    }
}
