# The JSON interface

Everything `canopywt` can do is available to a program, not just a person. Pass `--json` to any
command and stdout carries exactly one JSON object.

This page is the contract. It is what you pin against.

## The envelope

```json
{"v":1,"ok":true,"command":"list","data":[…],"warnings":[]}
```

| Field | Always | Meaning |
|---|---|---|
| `v` | yes | Envelope version. `1`. Bumped only for a breaking change to the envelope itself, never for new `data` fields. |
| `ok` | yes | Whether the thing succeeded. See [verdicts](#verdicts) for the one subtlety. |
| `command` | yes | Which command produced this — `"config check"`, `"list"`. Stable. |
| `data` | on success | The result. Shape depends on the command. |
| `error` | on failure | `{ code, message, details? }`. |
| `warnings` | yes | Array of strings, possibly empty. Read it unconditionally. |

Four rules that make this safe to script against:

1. **Exactly one object on stdout**, success or failure. One line, so it is NDJSON-able.
2. **Progress and human messages go to stderr.** stdout stays parseable even when a command is
   chatty. In `--json` mode stderr is usually empty.
3. **`data` is never partial.** A command that cannot produce a complete answer returns an error
   instead of half of one.
4. **New fields may appear in `data`.** Do not fail on unknown keys.

## Exit codes

| | Meaning |
|---|---|
| `0` | Success. |
| `1` | The operation failed. `error.code` says how. |
| `2` | Usage error — a bad flag or a missing argument. Handled by the argument parser; no envelope is printed. |
| `3` | Another process holds the lock. **Retryable** — nothing else uses this code, so a caller can retry on `3` blindly. |

## Errors

```json
{"v":1,"ok":false,"command":"info",
 "error":{"code":"not_a_repository","message":"/tmp is not inside a git repository"}}
```

Branch on `code`. It is a stable API; `message` is for humans and may be reworded.

| Code | Exit | Meaning |
|---|---|---|
| `not_a_repository` | 1 | The directory is not inside a git repository. |
| `git_failed` | 1 | git ran and refused. `details` carries `args`, `status` and git's own `stderr`, verbatim. |
| `config_not_found` | 1 | No `canopy.yaml` in any of the three search locations. The message says where it looked. |
| `config_invalid` | 1 | The config has errors. `details.errors` counts them. |
| `branch_not_found` | 1 | No such branch. |
| `worktree_exists` | 1 | A worktree is already there. |
| `worktree_not_found` | 1 | No worktree for that branch. |
| `worktree_dirty` | 1 | Uncommitted changes; pass `--force` to override. |
| `worktree_create_failed` | 1 | Creation failed. |
| `worktree_remove_failed` | 1 | Removal failed. |
| `port_in_use` | 1 | A port is held by something else. |
| `service_failed` | 1 | A service would not start or would not become healthy. |
| `locked` | **3** | Another `canopywt` holds the lock. Retry. |
| `io` | 1 | A filesystem or encoding problem. |

Codes for commands not yet implemented are listed because they are already reserved — the set
does not change under you when a milestone lands.

`git_failed` is deliberately distinct from `not_a_repository`. git's message ("fatal: a branch
named 'x' already exists") is the part you need, and translating it would throw that away.

## Verdicts

One case needs care. `canopywt config check` on a broken file *ran perfectly* — the answer is
just "no". So:

```json
{"v":1,"ok":false,"command":"config check",
 "data":{"path":"…/canopy.yaml","valid":false,"errors":1,"warnings":2,"diagnostics":[…]},
 "error":{"code":"config_invalid","message":"canopy.yaml has 1 error(s)"}}
```

`ok` is the **verdict about the file**, and `data` is present anyway, carrying every diagnostic.
So you read warnings off a passing file exactly as you read errors off a failing one, with one
code path. Exit is `1`, so CI does not have to parse anything.

This is the only command where `ok: false` comes with `data`.

## Commands

### `info`

```json
{"name":"canopy","root":"/Users/me/dev/canopy","common_dir":"/Users/me/dev/canopy/.git",
 "git_dir":"/Users/me/dev/canopy/.git","bare":false,"worktrees":6}
```

`common_dir` identifies the repository from *any* worktree inside it — the one field to key
state on. `root` is absent (not null) for a bare repo.

### `list`

An array, main checkout first — git's own ordering, which is how you identify the main worktree
without a second call.

```json
[{"path":"/Users/me/dev/canopy","head":"f794c07…","branch":"main","bare":false,"detached":false},
 {"path":"/Users/me/code/canopy.feat-login","head":"a950fe0…","branch":"feat/login","bare":false,"detached":false}]
```

`branch` is absent when detached or bare — absent, not null, so `if (entry.branch)` reads
correctly. `locked` and `prunable` appear only when they apply, each carrying git's reason.

### `config check [--stdin]`

See [verdicts](#verdicts). Each diagnostic:

```json
{"severity":"error","path":"services.web.run","message":"unknown port `${ports.wbe}`"}
{"severity":"error","path":"<root>","message":"invalid u32","line":1,"column":10}
```

`severity` is `"error"` or `"warning"`. `path` is a dotted key path and is always present.

`line` and `column` are **optional** and currently appear only on parse errors, where the YAML
parser reported a position. Semantic findings — unknown ports, dependency cycles — carry the
path alone; spans for those land in M2b. Treat both fields as optional permanently, since a
finding derived from several places at once has no single position to report.

Diagnostics are not ordered by position.

`--stdin` validates text on stdin and touches no file. That is what an editor wants for a buffer
that has not been saved: `data.path` reads `"<stdin>"`.

### `config show`

The whole config with every default filled in, so a consumer renders services, ports and setup
steps without owning a YAML parser or a table of defaults. Errors with `config_invalid` rather
than returning a partial config.

### `config path`

```json
{"path":"/Users/me/dev/canopy/canopy.yaml","source":"worktree"}
```

`source` is `worktree`, `main-checkout` or `user-config`.

### `config init`

Prints a starter `canopy.yaml` on stdout and writes nothing — redirect it yourself. The only
command that works outside a repository, since creating the file is sometimes the first thing
you do in a new directory.

## Using it from a script

```bash
# Every port this branch will use
canopywt config show --json | jq -r '.ports | keys[]'

# Fail a CI job on config problems, showing them
if ! canopywt config check --json > result.json; then
  jq -r '.data.diagnostics[] | "\(.severity) \(.path): \(.message)"' result.json
  exit 1
fi

# Retry once if another process holds the lock
canopywt list --json || [ $? -eq 3 ] && sleep 1 && canopywt list --json
```

## Using it from Rust

The CLI is a thin printf over the library — every subcommand calls one method and serializes the
result — so linking the crate gives you the same answers without a subprocess or a JSON parse.

```rust,no_run
use camino::Utf8Path;
use canopy_worktree::Canopy;

let canopy = Canopy::open(Utf8Path::new(".")).expect("inside a git repository");

for entry in canopy.list().expect("git worktree list") {
    println!("{} -> {}", entry.branch.as_deref().unwrap_or("(detached)"), entry.path);
}

if let Some((located, parsed)) = canopy.config() {
    println!("{} — {} error(s)", located.path, parsed.error_count());
    for diagnostic in &parsed.diagnostics {
        println!("  {:?} {}: {}", diagnostic.severity, diagnostic.path, diagnostic.message);
    }
}
```
