# canopy-worktree

Git worktree dev environments driven by `canopy.yaml`: create a worktree, copy the files git
won't, allocate ports, resolve env, run setup and supervise services — from a terminal or an
agent, with **no daemon**.

```bash
cargo install canopy-worktree   # installs the `canopywt` binary
```

macOS and Linux.

## Status

Early. Built milestone by milestone, each one tested before the next starts.

| | |
|---|---|
| ✅ **M1** | repository discovery, `git worktree list` — `canopywt info`, `canopywt list` |
| ✅ **M2** | `canopy.yaml` parse + lint — `canopywt config check\|show\|path\|init` |
| ⬜ M2b | JSON Schema (`config schema`), generated TypeScript types, `config set` |
| ⬜ M3 | worktree path template, port allocation |
| ⬜ M4 | `canopywt new` / `rm` |
| ⬜ M5–M12 | env, copy, setup, services, health, supervisor, hardened removal, git hook |

## Two invariants

**`git worktree list` is the registry.** Nothing this crate persists is consulted to answer
"what worktrees exist" or "where is branch X". A worktree created, moved or removed by plain
git behind our back is still seen correctly. The only things persisted are what git cannot
know: which processes we started, and which ports are taken.

**Progress goes to stderr, results to stdout.** Every command accepts `--json` and prints
exactly one envelope, success or failure:

```json
{"v":1,"ok":true,"command":"list","data":[…],"warnings":[]}
{"v":1,"ok":false,"command":"info","error":{"code":"not_a_repository","message":"…"}}
```

So a consumer parses one shape and reads `ok`, instead of branching on exit codes and scraping
text. Exit codes are still meaningful: `0` ok, `1` the operation failed (`error.code` says how),
`2` you typed it wrong, `3` someone else holds the lock — retry.

## Config is a public interface

`canopy.yaml` is the whole configuration — nothing lives in some daemon's database, because a
setting `canopywt` cannot read is a setting it cannot honour when it runs alone. That only pays
off if *other* programs can read the file as easily, so:

```bash
canopywt config check --json     # diagnostics with line and column, for squiggles
canopywt config check --stdin    # validate a buffer the user is still typing
canopywt config show --json      # every default filled in — render it without a YAML parser
canopywt config path             # which of the candidate files actually applies
canopywt config init             # a starter file on stdout; never writes
```

`config check` reports a **verdict**, so it is the one command whose `ok` is about the file
rather than the run: an invalid config exits 1 with `ok: false`, and `data` still carries every
diagnostic — you read warnings off a passing file exactly as you read errors off a failing one.

Unknown keys are warnings, never errors, at any depth. A key this binary does not recognise may
simply be newer than it, and `services.web.helth` is worth a warning rather than a silent
shrug or a refusal to run.

Human output is `path:line:column:` so editors and terminals can already open it.

## Library

The CLI is a printf over the library; every subcommand calls one method and serializes the
result, so the `--json` contract cannot drift from the API.

```rust
use camino::Utf8Path;
use canopy_worktree::Canopy;

let canopy = Canopy::open(Utf8Path::new("."))?;
for entry in canopy.list()? {
    println!("{} -> {}", entry.branch.as_deref().unwrap_or("(detached)"), entry.path);
}
# Ok::<(), canopy_worktree::Error>(())
```

## Why not worktrunk

[worktrunk](https://worktrunk.dev) is excellent and much larger — an fzf picker, CI status, LLM
branch summaries, a config-migration layer. This crate does one job: take a `canopy.yaml` and
make a worktree that runs. Ideas taken from it with thanks: branch-as-identity with the path
derived from a template, rename-to-trash before a background delete, and merge detection that
copes with squash and rebase merges.

## License

MIT OR Apache-2.0
