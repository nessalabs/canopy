# Design

Why this is shaped the way it is, and what you may rely on.

## What it is for

Working on several branches of one project at the same time, each with its own running
environment: its own ports, its own dependencies, its own processes. Git worktrees give you the
checkouts. Everything after that — which port, which `.env`, which dev server — is the part
people script by hand and get subtly wrong.

`canopywt` reads one file, `canopy.yaml`, and does the rest. Without a daemon, so it works the
same from a terminal, a CI job, a Makefile or an agent.

## Invariants

Four. Everything else is negotiable.

### git is the registry

`git worktree list` is the only source of truth for what worktrees exist and where. Nothing this
crate persists is ever consulted to answer that.

A worktree created, moved, or removed by plain `git` behind our back is therefore still seen
correctly, and there is no state to "repair" when the two disagree — they cannot disagree. The
only things persisted are what git genuinely cannot know: which processes we started, and which
ports are taken.

This is the difference between a tool you can abandon and one you have to migrate off.

### The CLI is a printf over the library

Every subcommand calls exactly one library method and serializes the result. There is no
CLI-only logic and no CLI-only struct.

That is what keeps `--json` from drifting: the JSON shape *is* the library's return type, so
they cannot disagree without a compile error. It also means a Rust consumer can link the crate
and get identical answers without a subprocess.

### stdout is for results, stderr is for people

`--json` prints exactly one object on stdout, success or failure. Progress, warnings and human
formatting go to stderr. You can watch a command work and pipe its output at the same time.

### `canopy.yaml` is the whole configuration

No dotfile, no database, no per-machine settings store. A setting `canopywt` cannot read is a
setting it cannot honour when it runs alone, which defeats the point.

The cost is that the file has to carry things a GUI might prefer to keep elsewhere — the
worktree path template, the copy rules. The payoff is that a config is reviewable, diffable and
travels with the branch.

## Choices worth explaining

### Shelling out to git rather than linking gix or git2

An in-process git would be faster and would not depend on a binary. It would also silently
behave differently: `git worktree add` fires the repository's `post-checkout` hook, honours
`core.hooksPath`, clean/smudge filters, credential helpers and `include`d config. A library
reimplements some of that and not the rest, and the gap shows up as "it works when I type it
myself" bug reports.

So: one `Git::run`, subprocess, `LC_ALL=C`, porcelain formats only.

### No async runtime

There is nothing to multiplex. Starting services spawns and returns; supervising them polls a
handful of children. `tokio` would add a dependency tree and a colour to every function in
exchange for nothing.

### Unix only

macOS and Linux. Process groups, `kill(-pgid)` and signal semantics have no clean Windows
equivalent, and supporting both would roughly double the supervision code — the most delicate
part of the system — for a platform nobody has asked for. `#![cfg(unix)]` says so at the crate
root rather than failing strangely later.

### Unknown config keys are warnings

Refusing a whole file over one unrecognised key is hostile when the key may simply be newer than
the binary reading it. But silently ignoring it means a typo like `helth:` costs you half an
hour.

So: warn, with the dotted path, at any depth. `serde_ignored` gives this for free and it is
strictly better than the behaviour it was ported from, which only checked the top level.

### Durations are `500ms`, `5s`, `2m` and nothing else

A bare `5` is an error. `timeout: 5` meaning five milliseconds in one tool and five seconds in
another is a classic afternoon-waster, and there is no reading of a bare number that is obviously
right.

`5h` is an error too, for a duller reason: Canopy's parser does not accept it, and a file that
worked with one tool and failed with the other would be worse than a clear message now.

## Testing

Two rules.

**Every test runs against real git.** The fixture creates an actual repository in a temp
directory and runs the actual binary. There are no mocks of git, because the bugs worth catching
are in the parts where our idea of git is wrong.

**The fixture pins the environment.** `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM`,
`GIT_CONFIG_GLOBAL`, the author and committer identity, and `TZ`. Without that the suite passes
or fails according to whoever's machine it is on — a global `commit.gpgsign`, an
`init.defaultBranch=master`, a `core.hooksPath` pointing at someone's dotfiles — and the failure
only reproduces for one person.

### Mutation testing

A passing suite proves the tests ran, not that they could fail. `cargo-mutants` injects bugs and
reports which ones nothing notices:

```bash
cargo mutants -j 4
```

The first run found 47 of 239 mutants surviving — a fifth of the code could be broken silently.
Among them: no test ever referenced a database that *existed*, so a lint rejecting every
`${db.…}` reference would have passed; the user-level config tier was never exercised at all;
and every character class was tested only through its rejections, so dropping `_` and `-` from
any validator was invisible.

The suite now catches every viable mutant. A `MISSED` line in that output is a test gap — treat
it as a failure.

It also surfaces code worth deleting. Three survivors were unkillable rather than untested: two
were index arithmetic in a string scan that no test could distinguish (rewritten with
`split_once`, which has no offsets to get wrong), and two were functions with no callers.

## Status

| | |
|---|---|
| ✅ M1 | repository discovery, worktree listing |
| ✅ M2 | `canopy.yaml` parse, lint and read interface |
| ⬜ M2b | JSON Schema, generated TypeScript types, `config set` |
| ⬜ M3 | worktree path template, port allocation |
| ⬜ M4 | `new` / `rm` |
| ⬜ M5–M12 | env resolution, copy, setup, services, health, supervisor, hardened removal, git hook |

Each milestone ships as one commit with its tests passing and no surviving mutants before the
next starts.

## Prior art

[worktrunk](https://worktrunk.dev) does much more: an fzf picker with live previews, CI status,
LLM branch summaries, a merge pipeline, a config-migration layer. It is a good tool and this is
not a criticism of it — but it is ~225,000 lines, and Canopy used three of its commands.

Ideas taken from it, with thanks:

- **Branch as identity**, with the worktree path derived from one template. You name the branch
  and nothing else.
- **Rename into a trash directory, then delete in the background.** A same-filesystem rename is
  instant; the `rm -rf` of a large `node_modules` does not have to be.
- **Merge detection that survives squash and rebase.** Six checks in cost order, because
  `git branch -d` refuses a branch whose work is already on main via a squash merge.

Ideas deliberately not taken: the hook approval system (its own source warns the TOCTOU handling
has "no compile-time guard"), the interactive picker, and shell `cd` integration.
