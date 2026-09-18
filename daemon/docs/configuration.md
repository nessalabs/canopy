# `canopy.yaml` reference

The whole configuration. Nothing lives anywhere else — not in a dotfile, not in a daemon's
database — because a setting `canopywt` cannot read is a setting it cannot honour when it runs
on its own.

Validate any of what follows with:

```bash
canopywt config check          # errors and warnings, each naming the key it is about
canopywt config show           # the same file with every default filled in
```

## Where the file is found

Three places, most specific first. The first that exists wins:

| | Path | For |
|---|---|---|
| 1 | `<worktree>/canopy.yaml` | The worktree you are standing in. A branch may change what it runs, and that change travels with the branch. |
| 2 | `<main checkout>/canopy.yaml` | The committed, shared answer. |
| 3 | `$XDG_CONFIG_HOME/canopywt/<repo>/canopy.yaml` | A repo that should not carry a `canopy.yaml` of its own — someone else's project you still want to run this way. |

`canopy.yml` is accepted wherever `canopy.yaml` is. `canopywt config path` reports which file is
actually in effect, and which of the three it came from — worth asking before you spend ten
minutes editing the wrong one.

A committed file always beats a user-level one. If it did not, two people on the same branch
would get different environments.

## Top level

The smallest file that does anything:

```yaml
version: 1              # required; the only value
name: my-app            # optional; defaults to the repository directory name

services:
  web:
    run: npm run dev
```

| Key | Type | Default |
|---|---|---|
| `version` | `1` | — (required) |
| `name` | string | the repository's directory name |

`name:` is what the project calls itself, and it is what `${project.name}` and
`CANOPY_PROJECT` report. The directory name is only the fallback — whoever cloned the repo chose
that, and it may not match.
| `defaults` | mapping | `{ runtime: host, env: {} }` |
| `env` | string → string | `{}` |
| `ports` | name → [port](#ports) | `{}` |
| `setup` | list of [step](#setup) | `[]` |
| `services` | name → [service](#services) | `{}` |
| `env_file` | string or `false` | `.env.canopy` |
| `worktree` | [worktree](#worktree) | see below |
| `copy` | list of [rule](#copy) | `[]` |
| `databases` | name → database | `{}` — **parsed but not yet supported**; warns |

**Names** — for ports, services and databases — may contain lowercase letters, digits, `_` and
`-`, and must start with a letter or digit. The rule is strict because a name has to be safe in
an environment variable, a path and a container name all at once.

**Unknown keys are warnings, never errors**, at any depth. A key this binary does not recognise
may simply be newer than it. You still hear about `services.web.helth`, by path — that is the
kind of typo that otherwise costs half an hour.

## Templates

Two different syntaxes appear in this file, and the difference is not cosmetic.

**`${scope.name}`** — values resolved per worktree, used in `env`, `run`, `health` and setup
steps:

| Scope | Example | Is |
|---|---|---|
| `ports` | `${ports.web}` | the port allocated to this worktree |
| `worktree` | `${worktree.path}`, `${worktree.name}` | this checkout |
| `project` | `${project.name}` | the repository |
| `env` | `${env.BASE}` | another variable **declared in this file** |
| `db` | `${db.main.url}` | a database fork — recognised, not yet resolved |

Scopes and resource names are lowercase `[a-z0-9_-]`, the same rule ports and services follow —
so `${ports.WEB}` names something that cannot exist and stays literal. The `env` scope is the
exception: variable names are uppercase by convention, so `${env.DATABASE_URL}` is a reference.

`${CANOPY_HOME}` and `$(cat …)` are shell, left exactly as written — which is what you want,
since `run:` goes to `/bin/sh -c`.

**`${env.X}` means a variable declared in this file**, not one from your shell:

```yaml
env:
  BASE: /srv/app
  DATA_DIR: ${env.BASE}/data      # → /srv/app/data
  FROM_SHELL: ${env.HOME}         # HOME is not declared here, so this stays literal
```

A reference that cannot be resolved is left verbatim rather than blanked — it may be shell
syntax, or a variable the surrounding environment will supply. Substitution is single-pass, so
a value that *contains* `${…}` after substitution is not re-scanned.

**`{{ variable | filter }}`** — used *only* in `worktree.path`, which is rendered before a
worktree exists and so cannot reference anything inside one. See [worktree](#worktree).

> Resolution of `${…}` lands with `canopywt env`. Today the linter checks that every reference
> points at something that exists, which is the half that catches typos.

## ports

Each named port gets its own number per worktree, so two branches can run the same service at
once.

```yaml
ports:
  web:
    description: the dev server      # shown in listings
  api:
    preferred: 4000                  # used when free
  debug:
    range: [9000, 9100]              # restrict allocation
```

All three keys are optional; `web: {}` is a complete declaration.

A port you declare but no service mentions is a warning — usually a rename that only got done in
one place.

### How a service claims a port

Either say so:

```yaml
services:
  web:
    ports: [web]
```

or let it be inferred, which is what most files do. A service claims every `${ports.x}` in its
`run` command, plus any env value that is a **bare** reference:

```yaml
services:
  web:
    run: vite --port ${ports.web}        # claims `web`
    env:
      PORT: "${ports.web}"               # claims `web`
      API_URL: http://127.0.0.1:${ports.api}/   # does NOT claim `api`
```

That last line is the distinction worth understanding. A port embedded in a URL points at
*another* service; counting it would have two services claiming one port.

## services

```yaml
services:
  web:
    run: npm run dev -- --port ${ports.web}
    cwd: apps/web                  # relative to the worktree root
    depends_on: [api]
    health:
      http: http://127.0.0.1:${ports.web}/
      start_period: 10s
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `run` | string | — | shell command, via `/bin/sh -c`. Required unless `compose` is set |
| `cwd` | string | worktree root | relative to the worktree |
| `runtime` | `host` \| `docker` \| `compose` | `defaults.runtime` (`host`) | |
| `env` | string → string | `{}` | layered over `defaults.env` and `env` |
| `ports` | list of names | inferred | see above |
| `health` | mapping | none | see below |
| `depends_on` | list of names | `[]` | start order; a cycle is an error |
| `restart` | `never` \| `on-failure` \| `always` | `on-failure` | |
| `autostart` | bool | `true` | `false` registers it without starting it |
| `stop_signal` | string | `SIGTERM` | |
| `stop_timeout` | [duration](#durations) | `10s` | then `SIGKILL` |
| `description` | string | — | shown in listings |
| `docker` | mapping | — | needs `image` or `dockerfile` |
| `compose` | mapping | — | `file` defaults to `docker-compose.yml` |

`run:` is passed to a shell, so `&&`, pipes, `$(…)` and `&` all work as written.

### health

Exactly one of `http`, `tcp` or `cmd`. More than one, or none, is an error.

```yaml
health:
  http: http://127.0.0.1:${ports.web}/   # 2xx and 3xx are healthy, redirect not followed
  # tcp: "${ports.web}"                  # or a bare number: tcp: 5432
  # cmd: pg_isready -q                    # exit 0 is healthy
  interval: 3s
  timeout: 3s
  retries: 10
  start_period: 0s        # grace after start, during which failures do not count
```

> **Use `127.0.0.1`, not `localhost`.** On macOS `localhost` resolves to `::1` first, so a check
> against a service bound to IPv4 fails while the service is running perfectly. `config check`
> warns about this, because it has cost real debugging time.

A 3xx counts as healthy and the redirect is *not* followed: a service behind a login wall is up.

## setup

Run once when a worktree is provisioned, in order, with the resolved environment.

```yaml
setup:
  - npm ci                       # bare string: the common case
  - run: npm run build           # or the full form
    name: build
    cwd: apps/web
    if_changed: [package-lock.json]
```

| Key | Type | Notes |
|---|---|---|
| `run` | string | required |
| `name` | string | defaults to `step 1`, `step 2`, … |
| `cwd` | string | relative to the worktree; created if absent |
| `env` | string → string | on top of the resolved environment |
| `if_changed` | list of globs | skip when these match the source checkout byte for byte |

`if_changed` is how you avoid a four-minute `npm ci` on every worktree: the files are compared
against the checkout the worktree was made from, and an unchanged lockfile means the step is
skipped.

## worktree

```yaml
worktree:
  path: "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"
  base: main
```

| Key | Default |
|---|---|
| `path` | `{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}` |
| `base` | the repository's default branch, discovered when needed |

The default puts worktrees *beside* the repository, not inside it. A worktree nested under the
checkout shows up in every `git status`, every file watcher and every `rg`.

Variables: `{{ repo }}` (repository name), `{{ repo_path }}` (its path), `{{ branch }}`,
`{{ name }}`. The `| sanitize` filter replaces anything outside `[A-Za-z0-9._-]` with `-`, which
is what turns `feat/login` into a directory called `feat-login` while the branch keeps its real
name. A relative result resolves against the repository.

## copy

`git worktree add` brings tracked files only. These rules carry the rest — the `.env` your app
needs, and optionally the dependency directories that take minutes to rebuild.

```yaml
copy:
  - pattern: .env
  - pattern: .env.*.local
  - pattern: node_modules
    strategy: clone
```

| Key | Default | Notes |
|---|---|---|
| `pattern` | — | glob relative to the repo root |
| `strategy` | `copy` | `copy`, `clone` or `symlink` |

`*` stops at `/`, as in a shell. A bare directory name carries everything under it. The first
rule to claim a path wins, and a path is handled exactly once.

A `.canopyinclude` file at the repo root (gitignore syntax) **narrows** the set: with one
present, a path must be both gitignored *and* matched by it. `!` takes a path back out. No
`.canopyinclude` means no narrowing.

Nothing is ever overwritten — an existing file, directory or symlink at the target is left
alone and reported as skipped. One unreadable source does not abort the rest; it is reported as
a failure alongside the paths that landed.

`clone` is a copy-on-write clone where the filesystem supports it — APFS, btrfs, XFS — and a
plain copy where it does not. That is what makes carrying a multi-gigabyte `node_modules` or
`target` a few seconds rather than a few minutes. The result says which actually happened,
`cloned` or `copied`, because a silent degradation turns a twenty-second provision into two
minutes with no explanation.

Only gitignored files are candidates; tracked files are never touched.

## env and env_file

```yaml
defaults:
  env:
    NODE_ENV: development
env:
  DATABASE_URL: postgres://localhost/${project.name}
env_file: .env.canopy      # or `false` to write nothing
```

Layered, last wins: `defaults.env` → `env` → a service's own `env`.

`env_file` names a dotenv written into each worktree with everything resolved. `false` disables
it. `true` is an error — it looks like it means something and does not.

## durations

`500ms`, `5s`, `2m`. Those three units, nothing else.

A bare number is an error rather than a guess: `timeout: 5` meaning five milliseconds in one tool
and five seconds in another is exactly the sort of thing that wastes an afternoon. `5h` is also
an error — Canopy's own parser does not accept it, and a file that worked here and failed there
would be worse than a clear message.

## What `config check` reports

**Errors** — the config cannot run:

- an unsupported `version`
- a name that breaks the naming rule
- `${ports.x}` or `${db.x}` naming something undeclared, or a `ports: [x]` entry that does
- a service with neither `run` nor `compose`
- `runtime: docker` without `docker.image` or `docker.dockerfile`
- a `health` block with other than exactly one probe
- `depends_on` naming an unknown service, itself, or forming a cycle (the cycle is spelled out)
- a database `seed` with more than one of `dump`, `sql`, `command`
- `env_file: true`

**Warnings** — it will run, probably not as you meant:

- an unknown key, by path
- tab characters in indentation
- an unknown template scope
- `run:` alongside `compose:` (the `run` is ignored)
- a `localhost` health URL (the `::1` trap above)
- a declared port no service references
- no services at all
- `databases:` — recognised, not yet supported

## A complete example

Canopy's own `canopy.yaml`, which is checked into this repository as a test fixture and must
parse with zero errors and zero warnings on every commit:

```yaml
version: 1
name: canopy

ports:
  api:
    description: canopyd for this worktree
  web:
    description: web client (vite dev server)

env:
  CANOPY_HOME: ${worktree.path}/.canopy-home
  CANOPY_PORT: ${ports.api}

setup:
  - name: install
    run: npm install
    if_changed: [package-lock.json]

services:
  web:
    description: the web client, pointed at this worktree's daemon
    depends_on: [daemon]
    cwd: apps/web
    ports: [web]
    run: npx vite --host 127.0.0.1 --port ${ports.web} --strictPort
    health:
      http: http://127.0.0.1:${ports.web}/
      start_period: 10s
  daemon:
    ports: [api]                    # declared, since `run` does not mention it
    run: npm -w @canopy/daemon run dev
    health:
      http: http://127.0.0.1:${ports.api}/healthz
      start_period: 15s
```
