# Command reference

Everything `canopywt` currently does. Commands marked *planned* are named here because their
error codes and output shapes are already reserved — the surface does not shift under you when a
milestone lands.

## Global options

| Flag | Effect |
|---|---|
| `--json` | Print one JSON envelope on stdout. See [the JSON interface](json-api.md). |
| `-C <path>` | Run as if started in `<path>`. |
| `-y`, `--yes` | Do not prompt. *(planned — nothing prompts yet)* |
| `-q`, `--quiet` | Suppress progress on stderr. |
| `-v` | More detail on stderr; repeatable. |
| `-h`, `--help` | Help for any command. |
| `-V`, `--version` | Version. |

A bad flag exits `2` without printing an envelope.

## `canopywt info`

What repository this is and where its pieces are.

```console
$ canopywt info
name        canopy
root        /Users/me/dev/canopy
common dir  /Users/me/dev/canopy/.git
git dir     /Users/me/dev/canopy/.git
worktrees   6
```

`common dir` is the same from every worktree in the repository, which is what makes it the thing
to key state on. Run it inside a linked worktree and `root` and `git dir` change while
`common dir` does not.

For a bare repository `root` is omitted entirely.

## `canopywt list`

Every worktree git knows about, main checkout first.

```console
$ canopywt list
main                     /Users/me/dev/canopy
feat/login               /Users/me/code/canopy.feat-login
(detached a950fe09)      /Users/me/code/canopy.spike
```

Detached worktrees show a shortened head; a bare entry shows `(bare)`.

```console
$ canopywt list --json | jq -r '.data[] | select(.branch) | .branch'
```

## `canopywt config check`

Validate the `canopy.yaml` in effect.

```console
$ canopywt config check
ok: 0 error(s), 0 warning(s)
```

```console
$ canopywt config check
/Users/me/app/canopy.yaml: warning: services.app.helth: unknown key `helth` — ignored
/Users/me/app/canopy.yaml: error: services.app.run: unknown port `${ports.wbe}`
invalid: 1 error(s), 1 warning(s)
```

Every diagnostic names the key it is about, as a dotted path.

A **parse** error also carries a position, printed as `path:line:column:` so editors and
terminals can jump straight to it:

```console
$ canopywt config check
/Users/me/app/canopy.yaml:1:10: error: <root>: invalid u32
invalid: 1 error(s), 0 warning(s)
```

Lint diagnostics — unknown ports, dependency cycles, everything semantic — carry the path but
not yet a position; spans for those land in M2b.

**Exits `1` when the config is invalid**, so CI needs no parsing:

```bash
canopywt config check || exit 1
```

### `--stdin`

Validate text on stdin and touch no file — for an editor checking a buffer that has not been
saved.

```bash
cat draft.yaml | canopywt config check --stdin --json
```

## `canopywt config show`

The config with every default filled in. What a service actually gets, not what the file says.

```console
$ canopywt config show --json | jq '.data.services.web'
{
  "run": "npx vite --host 127.0.0.1 --port ${ports.web} --strictPort",
  "cwd": "apps/web",
  "env": {},
  "ports": ["web"],
  "health": { "http": "…", "interval": "3s", "timeout": "3s", "retries": 10, "start_period": "10s" },
  "depends_on": ["daemon"],
  "restart": "on-failure",
  "autostart": true,
  "stop_signal": "SIGTERM",
  "stop_timeout": "10s"
}
```

Refuses an invalid config rather than returning part of one.

## `canopywt config path`

Which file is in effect, and which of the three search locations it came from.

```console
$ canopywt config path
/Users/me/dev/canopy/canopy.yaml  (this worktree)
```

Worth asking before editing. See [where the file is found](configuration.md#where-the-file-is-found).

## `canopywt config schema`

The JSON Schema for `canopy.yaml`, generated from the Rust types so it cannot drift from the
parser.

```bash
canopywt config schema > canopy.schema.json
```

Point an editor at it and you get completion and inline validation for free:

```yaml
# yaml-language-server: $schema=./canopy.schema.json
version: 1
```

It is also how a program in any language validates a config without running `canopywt`. Two
deliberate limits: the schema cannot express what the linter checks (`depends_on` cycles,
exactly-one-probe in `health`, unresolvable `${ports.x}`), and it leaves `additionalProperties`
open because unknown keys are warnings here, not errors. `config check` remains the authority.

Generated TypeScript bindings ship alongside it in `types/`, so a consumer stops hand-writing
types that have to match a Rust struct by eyeball.

## `canopywt config init`

Print a starter `canopy.yaml` on stdout. **Writes nothing** — redirect it yourself:

```bash
canopywt config init > canopy.yaml
```

Printing rather than writing is the difference between a command you can pipe and one that
clobbers the file you were editing. The starter passes `config check` with no warnings.

The only command that works outside a git repository.

## `canopywt ports [<branch>]`

The ports allocated to a branch, allocating them on first ask. Idempotent — the numbers do not
move once a branch has them.

```console
$ canopywt ports
api          14100
web          11189
```

Allocation starts from a hash of the branch and walks on, skipping anything the registry holds
and anything that fails a bind test on **both** `127.0.0.1` and `::1`. A port free on one stack
and busy on the other is a failure that looks like a broken service.

`ports.<name>.preferred` is honoured when it is free *and inside the range*; one outside is
ignored rather than silently widening the range. `--all` prints the whole registry — that is
what another program reads instead of keeping its own table. `--release` hands a branch's ports
back to the pool.

The registry lives in `.git/canopy/ports.json`, so every worktree of the repository sees one
table.

## `canopywt env [<branch>]`

The resolved environment: Canopy's own facts, then `defaults.env`, then `env:`, last wins.

```console
$ canopywt env
CANOPY_BRANCH=main
CANOPY_PORT_API=14100
CANOPY_PORT_WEB=11189
CANOPY_PROJECT=demo
CANOPY_WORKTREE=demo
CANOPY_WORKTREE_PATH=/Users/me/code/demo
PUBLIC_URL=http://127.0.0.1:11189
```

Output is sorted and deterministic: writing twice produces byte-identical files, so it never
shows up as a spurious diff.

- `--export` prints `export K='v'` lines for `eval "$(canopywt env --export)"`
- `--write` writes the file named by `env_file:` into the worktree
- `--json` **masks** values that look like secrets; the file and `--export` keep the real ones,
  because masking is presentation, not storage

Values are single-quoted when they need it. Double quotes would not do: `sh` still expands `$`,
backticks and `\` inside them, so a password containing `$` would not survive a round trip
through `. ./.env.canopy`.

## `canopywt up [<branch>]`

Start the worktree's services, in dependency order.

```console
$ canopywt up feat/login
api              running    48210
web              running    48214
```

`up` spawns and **exits**; the services keep running. There is no daemon holding them — each is
its own process group with its output redirected to a file, so nothing needs to stay alive to
pump a pipe.

It waits for each service's health check by default, so a green result means the thing actually
serves. `--no-wait` returns as soon as each process is spawned; a service with a health check
then reports `starting` rather than `running`, because alive is not the same as serving.

A service that dies immediately is reported `exited`, not `running` — there is a short grace
period after spawn precisely to catch that. A second `up` is a no-op that returns the existing
pids, so a race loses gracefully instead of double-starting. `--only <name>` starts a subset,
and `autostart: false` keeps a service registered but unstarted unless you name it.

`runtime: docker` and `compose` report `unsupported` rather than pretending.

## `canopywt down [<branch>]`

Stop them, in reverse dependency order: `stop_signal` (default SIGTERM) to the whole process
group, escalating to SIGKILL after `stop_timeout`.

The group, not the process, is the point — `run: npm start` that backgrounds a watcher would
otherwise leave the watcher running. A record whose pid has been reused by an unrelated process
is **refused**, never killed.

## `canopywt ps [<branch>]`

What is running, re-verified from the OS rather than trusted from the record file.

```console
$ canopywt ps feat/login --json | jq '.data[] | {name, state, pid, health}'
{ "name": "web", "state": "running", "pid": 48214, "health": { "status": "healthy" } }
```

## `canopywt logs <service> [<branch>]`

stdout and stderr, interleaved in one file — which is what you want when reading why something
died.

- `-n <count>` how many lines to show (default 200)
- `-f` keep printing as new lines arrive

## `canopywt copy [<branch>]`

Carry the gitignored files a worktree needs — the `.env` your app reads, and optionally the
dependency directories that cost minutes to rebuild.

```console
$ canopywt copy feat/login
copied     .env (41 bytes, 0ms)
cloned     node_modules/react/index.js (6212 bytes, 1ms)
```

Candidates come from git, so only **gitignored** files are eligible and a tracked file is never
touched — it arrived with the checkout and reflects what the branch actually says.

`strategy: clone` uses a copy-on-write clone where the filesystem supports it. The report
distinguishes `cloned` from `copied` so a silent fallback is visible rather than just slow.

Nothing is overwritten: an existing file, directory or symlink at the target is reported
`skipped`. One unreadable source does not abort the rest — it lands in `failures` alongside the
paths that worked.

- `--from <path>` copies from another checkout instead of the main one
- `--dry-run` reports the plan and writes nothing

## `canopywt setup [<branch>]`

Run the worktree's `setup:` steps, in order, with the resolved environment.

```console
$ canopywt setup feat/login
skipped  install — lockfile.txt unchanged
ran      build (1240ms)
```

Step output streams to **stderr** as it happens — a four-minute `npm ci` that prints nothing
until it finishes looks like a hang — so stdout stays clean for `--json`. `--quiet` suppresses
the stream without suppressing the result.

`if_changed` is what makes this cheap to re-run: a step is skipped when the files it names are
byte-for-byte identical to the main checkout's. Content, never mtime — every file in a fresh
worktree has a new mtime, which would make the check useless.

- `--force` runs every step anyway
- `--only <name>` runs just that step, repeatable. An unknown name is an **error**, not a silent
  clean run — a typo that reports instant success is the failure mode that costs an hour
- `--timeout 5m` gives up on any single step, killing its whole process group

A failing step stops the run; later steps do not run. Exit is `1`, and `--json` reports a
verdict: `ok: false` with `setup_failed`, while `data` still carries every step with the tail of
the failing one's output.

## Planned

| Command | Milestone |
|---|---|
| `config schema`, `config set` | M2b |
| `run` (foreground supervisor with restart policy) | M10 |
| `doctor`, `gc`, `hook install` | M11–M12 |

## Exit codes

`0` success · `1` the operation failed · `2` usage error · `3` another process holds the lock
(retryable).

Full list of error codes: [the JSON interface](json-api.md#errors).
