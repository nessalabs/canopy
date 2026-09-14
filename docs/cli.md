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

## `canopywt config init`

Print a starter `canopy.yaml` on stdout. **Writes nothing** — redirect it yourself:

```bash
canopywt config init > canopy.yaml
```

Printing rather than writing is the difference between a command you can pipe and one that
clobbers the file you were editing. The starter passes `config check` with no warnings.

The only command that works outside a git repository.

## Planned

| Command | Milestone |
|---|---|
| `config schema`, `config set` | M2b |
| `path <branch>`, `ports [--all\|release\|reserve]` | M3 |
| `new <branch>`, `rm <branch>` | M4 |
| `env [--write\|--export]` | M5 |
| `copy`, `setup` | M6–M7 |
| `up`, `down`, `ps`, `logs`, `wait` | M8–M9 |
| `run` | M10 |
| `doctor`, `gc`, `hook install` | M11–M12 |

## Exit codes

`0` success · `1` the operation failed · `2` usage error · `3` another process holds the lock
(retryable).

Full list of error codes: [the JSON interface](json-api.md#errors).
