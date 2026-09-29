/**
 * Driving `canopyd` for the provisioning steps Canopy used to implement itself.
 *
 * Copying gitignored files, linking caches and allocating ports were three TypeScript modules
 * (437 lines) doing what the crate now does behind one flag each. They are gone; this is what
 * replaced them. `backend.ts` covers the worktree itself — this covers what happens after it
 * exists.
 *
 * Everything here is a `--json` call, so failures arrive as a stable `error.code` rather than
 * as text to match against, and every result is one object rather than a stream to parse.
 *
 * Every call runs with `cwd` set to the **worktree**, not the main checkout. The crate resolves
 * `canopy.yaml` the way Canopy does — the worktree's own copy wins — and it resolves it relative
 * to where it was invoked, so running from the main checkout would silently use the wrong file
 * for a branch that changed what it runs.
 */
import type { CacheRule, CacheStrategy, CopyFileRule, PortSpec } from '@canopy/shared'

import { conflict } from '../../lib/errors'

import { parseEnvelope, runTool, type OnLine, type ToolRun } from './exec'

export interface CopiedEntry {
  path: string
  strategy: 'copy' | 'clone' | 'symlink'
  result: 'cloned' | 'copied' | 'symlinked' | 'skipped' | 'planned'
  bytes: number
  millis: number
}

export interface CopyResult {
  entries: CopiedEntry[]
  failures: Array<{ path: string; strategy: string; message: string }>
}

/** One database fork, as `canopyd db …` reports it. */
export interface CanopydFork {
  name: string
  adapter: string
  status: 'ready' | 'missing'
  url: string
  env_key: string
  forked_from: string
  /** What it was copied from; absent when it started empty. */
  source?: string
  detail: Record<string, string>
  size_bytes?: number
}

/**
 * What every call carries: the worktree it runs in, the key its ports are filed under (the
 * branch, or the worktree's name when it is detached), and — for a project whose canopy.yaml
 * lives in its Canopy home rather than the repository — that file, which the tool would not
 * otherwise look for.
 */
interface Target {
  cwd: string
  branch: string
  config?: string
}

export interface Canopyd {
  available(): Promise<boolean>
  /** Carries gitignored files from `source` into the worktree, with explicit rules. */
  copy(input: Target & { source: string; rules: Array<{ pattern: string; strategy: string }>; onLine?: OnLine }): Promise<CopyResult>
  /** Allocate-if-absent for every declared port; idempotent, and the numbers never move. */
  ports(input: Target & { onLine?: OnLine }): Promise<Record<string, number>>
  /**
   * Pins numbers the daemon picked itself — a database fork's container port — in the same
   * registry, so the tool never hands them to a service. Rejects with `port_in_use` when
   * another worktree holds one. Returns the branch's whole table.
   */
  reserve(input: Target & { ports: Record<string, number> }): Promise<Record<string, number>>
  /** Hands a branch's ports back to the pool. */
  releasePorts(input: Target): Promise<number>
  /**
   * Writes the worktree's env file (`env_file:`, `.env.canopy` by default) with `env` layered over
   * what canopyd resolves, and returns its path — null when the config turns the file off.
   * Needs canopyd 0.2.0; ask [`Canopyd.version`] first.
   */
  writeEnv(input: Target & { env: Record<string, string> }): Promise<string | null>
  /** Throws the branch's fork of `name` away and makes it again from `from`. Needs canopyd 0.3.0. */
  dbReset(input: Target & { name: string; from: string }): Promise<CanopydFork>
  /** Removes the branch's fork of `name`. True when there was one. */
  dbDrop(input: Target & { name: string }): Promise<boolean>
  /** The branch's recorded forks, as they stand on disk. */
  dbList(input: Target): Promise<CanopydFork[]>
  /** The installed version, or null when canopyd is not there. Cached for the life of the daemon. */
  version(): Promise<string | null>
  /** Runs the worktree's `setup:` steps, with Canopy's resolved environment layered on top. */
  setup(input: Target & { env: Record<string, string>; force?: boolean; onLine?: OnLine }): Promise<SetupResult>
}

export interface SetupStepOutcome {
  name: string
  command: string
  result: { kind: 'ran'; millis: number } | { kind: 'skipped'; reason: string } | { kind: 'failed'; status: string; tail: string[]; millis: number }
}

export interface SetupResult {
  steps: SetupStepOutcome[]
  ok: boolean
}

/** Unwraps a successful envelope, or throws with the code the tool chose. */
function unwrap<T>(command: string, result: ToolRun): T {
  const envelope = parseEnvelope<T>(result.stdout)
  if (!envelope) {
    throw conflict('provision_failed', result.stderr.trim() || `canopyd ${command} exited with ${result.exitCode}`)
  }
  if (!envelope.ok || envelope.data === undefined) {
    // `error.code` is a stable API, so it is carried through rather than flattened.
    throw conflict(envelope.error?.code ?? 'provision_failed', envelope.error?.message ?? `canopyd ${command} failed`)
  }
  return envelope.data
}

/** A Canopy cache strategy as the crate spells it. `fresh` means "do not copy at all". */
const copyStrategyFor = (strategy: CacheStrategy | CopyFileRule['strategy']): string | null => {
  switch (strategy) {
    case 'fresh':
      return null
    case 'clone':
      return 'clone'
    case 'symlink':
      return 'symlink'
    default:
      return 'copy'
  }
}

/**
 * Canopy's copy rules and cache rules are one thing to the crate: both name gitignored paths to
 * carry into a worktree, and `node_modules` is as gitignored as `.env` is. Folding them here is
 * what let `caches.ts` go.
 */
export function rulesFor(copyFiles: CopyFileRule[], caches: CacheRule[]): Array<{ pattern: string; strategy: string }> {
  const rules: Array<{ pattern: string; strategy: string }> = []
  for (const rule of copyFiles) {
    const strategy = copyStrategyFor(rule.strategy)
    if (strategy) rules.push({ pattern: rule.pattern, strategy })
  }
  for (const rule of caches) {
    const strategy = copyStrategyFor(rule.strategy)
    if (strategy) rules.push({ pattern: rule.path, strategy })
  }
  return rules
}

/** `run --control`, `--env` on every service command, bare `--env KEY` and resumable logs arrived in canopyd 0.2.0. */
export function supportsRunControl(version: string | null): boolean {
  return atLeast(version, 0, 2)
}

/** Whether `version` is `major.minor` or newer. A version that will not parse is not. */
export function atLeast(version: string | null, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version ?? '')
  if (!match) return false
  const [have, haveMinor] = [Number(match[1]), Number(match[2])]
  return have > major || (have === major && haveMinor >= minor)
}

/** `runtime: docker` and `compose:` services arrived in canopyd 0.4.0. */
export function supportsContainers(version: string | null): boolean {
  return atLeast(version, 0, 4)
}

/**
 * The name canopyd gives a docker service's container: `canopy-<id>-<service>`, where the id is
 * eight hex characters of the FNV-1a hash of the worktree's path. Reproduced here because the
 * name is how this daemon asks docker about a container it did not start — for CPU and memory.
 * canopyd pins the algorithm with a test, since its own backstop `rm -f` depends on it too.
 */
export function canopydContainerName(worktreePath: string, service: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(worktreePath, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  const id = hash.toString(16).padStart(16, '0').slice(0, 8)
  const safe = service.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '')
  return `canopy-${id}-${safe}`
}

/**
 * `--env` flags for `env`, and the environment that carries their values.
 *
 * From 0.2.0 a bare `--env KEY` means "the value you were started with", so a database password
 * never appears in an argument list, which every user on the machine can read through `ps`.
 * Older versions only know `KEY=VALUE`.
 */
function envFlags(env: Record<string, string>, bare: boolean): { args: string[]; env: Record<string, string> } {
  const args: string[] = []
  for (const [key, value] of Object.entries(env)) args.push('--env', bare ? key : `${key}=${value}`)
  return { args, env: bare ? env : {} }
}

/**
 * @param opts.env the environment every call runs with: the shared port registry and the
 *   daemon's port range. A function, so a range changed in settings applies to the next call.
 */
export function createCanopyd(opts: { bin?: string; env?: () => Record<string, string> } = {}): Canopyd {
  const bin = opts.bin ?? 'canopyd'
  // `extra` is the values bare `--env KEY` flags name; they travel in the environment, not argv.
  const call = (args: string[], target: Target, onLine?: OnLine, extra: Record<string, string> = {}): Promise<ToolRun> =>
    runTool(bin, args, { cwd: target.cwd, env: { ...extra, ...(opts.env?.() ?? {}), ...(target.config ? { CANOPYD_CONFIG: target.config } : {}) }, onLine })
  let version: Promise<string | null> | null = null
  const installed = (): Promise<string | null> => {
    version ??= runTool(bin, ['--version'], { cwd: process.cwd() })
      .then((result) => (result.exitCode === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(`${result.stdout} ${result.stderr}`)?.[1] ?? null) : null))
      .catch(() => null)
    return version
  }

  return {
    version: installed,

    async dbReset({ name, from, ...target }) {
      return unwrap<CanopydFork>('db reset', await call(['db', 'reset', name, target.branch, '--from', from, '--json'], target))
    },

    async dbDrop({ name, ...target }) {
      const data = unwrap<{ dropped: string[] }>('db drop', await call(['db', 'drop', target.branch, '--only', name, '--json'], target))
      return data.dropped.includes(name)
    },

    async dbList(target) {
      return unwrap<CanopydFork[]>('db ls', await call(['db', 'ls', target.branch, '--json'], target))
    },

    async writeEnv({ env, ...target }) {
      const flags = envFlags(env, true)
      const data = unwrap<{ written: string | null }>('env', await call(['env', target.branch, '--write', '--json', ...flags.args], target, undefined, flags.env))
      return data.written
    },

    async available() {
      try {
        return (await runTool(bin, ['--version'], { cwd: process.cwd() })).exitCode === 0
      } catch {
        return false
      }
    },

    async copy({ source, rules, onLine, ...target }) {
      if (rules.length === 0) return { entries: [], failures: [] }
      const args = ['copy', target.branch, '--from', source, '--json']
      for (const rule of rules) args.push('--rule', `${rule.pattern}=${rule.strategy}`)
      return unwrap<CopyResult>('copy', await call(args, target, onLine))
    },

    async ports({ onLine, ...target }) {
      return unwrap<Record<string, number>>('ports', await call(['ports', target.branch, '--json'], target, onLine))
    },

    async reserve({ ports, ...target }) {
      const args = ['ports', target.branch, '--json']
      for (const [name, port] of Object.entries(ports)) args.push('--reserve', `${name}=${port}`)
      return unwrap<Record<string, number>>('ports', await call(args, target))
    },

    async releasePorts(target) {
      const data = unwrap<{ released: number }>('ports', await call(['ports', target.branch, '--release', '--json'], target))
      return data.released
    },

    async setup({ env, force, onLine, ...target }) {
      const args = ['setup', target.branch, '--json']
      if (force) args.push('--force')
      // Canopy's environment is richer than the crate can resolve on its own — database URLs
      // come from forks it knows nothing about — so it is passed through rather than re-derived.
      const flags = envFlags(env, supportsRunControl(await installed()))
      args.push(...flags.args)

      const result = await call(args, target, onLine, flags.env)
      const envelope = parseEnvelope<SetupResult>(result.stdout)
      if (!envelope) {
        throw conflict('setup_failed', result.stderr.trim() || `canopyd setup exited with ${result.exitCode}`)
      }
      // A failing step is a verdict, not a fault: the data is still there, and the caller wants
      // to show which step failed and why rather than just that something did.
      if (envelope.data) return envelope.data
      throw conflict(envelope.error?.code ?? 'setup_failed', envelope.error?.message ?? 'canopyd setup failed')
    }
  }
}

/** Declared ports, for the "nothing to do" check the step makes before spawning anything. */
export const hasPorts = (ports: Record<string, PortSpec> | undefined): boolean => Object.keys(ports ?? {}).length > 0
