# canopy-worktree

Work on several branches at once, each with its own running environment — its own ports, its own
dependencies, its own dev server — described by one file and managed without a daemon.

```bash
cargo install canopy-worktree   # installs the `canopywt` binary
```

macOS and Linux.

## The idea

Git worktrees give you several checkouts of one repository. What they do not give you is
everything after the checkout: which port this branch's dev server runs on, where its `.env` came
from, whether its dependencies are installed, what is actually running right now. That is the
part people script by hand, per project, and get subtly wrong.

`canopywt` reads a `canopy.yaml` and does it. No daemon, no background process, no database — so
it behaves the same from a terminal, a Makefile, a CI job or an agent.

```yaml
version: 1

ports:
  web: {}

copy:
  - pattern: .env
  - pattern: node_modules
    strategy: clone        # copy-on-write; seconds, not minutes

setup:
  - run: npm ci
    if_changed: [package-lock.json]

services:
  web:
    run: npm run dev -- --port ${ports.web}
    health:
      tcp: "${ports.web}"
```

## Status

Early, and built one milestone at a time — each shipped with its tests passing and no surviving
mutants before the next starts.

| | |
|---|---|
| ✅ **M1** | repository discovery, worktree listing — `info`, `list` |
| ✅ **M2** | `canopy.yaml` parse, lint and read interface — `config check\|show\|path\|init` |
| ✅ **M3–M4** | worktree path template, port allocation, `new` / `rm` |
| ✅ **M5–M7** | env resolution, `copy`, `setup` |
| ✅ **M8–M9** | services and health — `up`, `down`, `ps`, `logs` |
| ⬜ M10 | `run` — foreground supervisor with a restart policy |
| ✅ **M11–M12** | `doctor`, `gc`, and the opt-in `post-checkout` bridge |
| ✅ **M2b** | JSON Schema (`config schema`) and generated TypeScript types |

The whole provisioning chain works today: create a worktree, carry its gitignored files,
allocate its ports, resolve its environment, run its setup steps, start its services and watch
them — then tear it all down again.

## Documentation

| | |
|---|---|
| [Command reference](docs/cli.md) | Every command and flag |
| [`canopy.yaml` reference](docs/configuration.md) | Every key, every default, every lint rule |
| [The JSON interface](docs/json-api.md) | The contract for scripts, agents and other programs |
| [Design](docs/design.md) | Invariants, the choices behind them, and how this is tested |

## For other programs

Every command takes `--json` and prints exactly one object on stdout, success or failure.
Progress goes to stderr, so you can watch a command work and pipe it at the same time.

```console
$ canopywt config check --json
{"v":1,"ok":true,"command":"config check","data":{"path":"…","valid":true,"errors":0,"warnings":0,"diagnostics":[]},"warnings":[]}
```

Every diagnostic names the key it is about by dotted path, parse errors add a line and column,
and `config check --stdin` validates a buffer that has not been saved yet. `config show` returns the
config with every default filled in, so a UI can render services and ports without owning a YAML
parser.

Unknown config keys are warnings, never errors, at any depth — a key this binary does not know
may simply be newer than it, but you still hear about `services.web.helth` by path.

Full contract: [the JSON interface](docs/json-api.md).

## As a library

The CLI is a thin printf over the library — each subcommand calls one method and serializes the
result — so the JSON shape and the Rust API cannot drift apart.

```rust,no_run
use camino::Utf8Path;
use canopy_worktree::Canopy;

let canopy = Canopy::open(Utf8Path::new(".")).expect("inside a git repository");
for entry in canopy.list().expect("git worktree list") {
    println!("{} -> {}", entry.branch.as_deref().unwrap_or("(detached)"), entry.path);
}
```

## Two things to know

**git is the registry.** `git worktree list` is the only source of truth for what exists and
where. A worktree created, moved or removed by plain `git` behind this tool's back is still seen
correctly, and there is no state to repair when the two disagree — they cannot. Only what git
genuinely cannot know is persisted: which processes we started, and which ports are taken.

**`canopy.yaml` is the whole configuration.** No dotfile, no per-machine settings store. A
setting the tool cannot read is a setting it cannot honour when it runs alone.

## Development

```bash
cargo test                       # unit + integration, against real git repositories
cargo clippy --all-targets -- -D warnings
cargo mutants -j 4               # injects bugs; a MISSED line is a test gap, treat as failure
```

The suite catches every viable mutant. See [Design → Testing](docs/design.md#testing) for why
that matters more than the count of tests.

## Prior art

[worktrunk](https://worktrunk.dev) is a larger, more featureful tool in this space — worth using
if you want an interactive picker, CI status and branch summaries. Ideas borrowed from it with
thanks are credited in [Design](docs/design.md#prior-art).

## License

MIT OR Apache-2.0
