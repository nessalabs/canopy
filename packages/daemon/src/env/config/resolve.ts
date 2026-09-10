/**
 * Turns a parsed `canopy.yaml` plus this worktree's allocations into the concrete things the
 * supervisor runs: one env table, one command per service, one setup list.
 *
 * All the layering rules live here, in one pure function, because "why does my service see
 * this value?" must have exactly one answer — and because the settings UI previews the same
 * resolution without starting anything.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  type CanopyConfig,
  type EnvVar,
  interpolate,
  looksSecret,
  normalizeSetupStep,
  parseDuration,
  type ProjectSettings,
  servicePorts,
  serviceRuntime,
  startOrder,
  type WorktreeOptions
} from '@canopy/shared'

import type { ResolvedService } from '../types'

/** A URL that carries `user:password@` — never printable in the UI, whatever the key is called. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@/i

/** `main-db` → `MAIN_DB`; the shape every generated env key uses. */
const upperSnake = (name: string): string => name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()

/** Env var a database fork's URL lands in: the spec's `env:` or `<NAME>_URL`. */
export function dbEnvKey(name: string, spec: { env?: string }): string {
  return spec.env ?? `${upperSnake(name)}_URL`
}

export interface ResolveInput {
  config: CanopyConfig
  options: WorktreeOptions
  settings: ProjectSettings
  /** Named port → allocated number. */
  ports: Record<string, number>
  /** Forked databases; `url` is null until the fork exists. `detail` (host, port, database, user, …) is exposed as `${db.<name>.<key>}`. */
  databases: Array<{ name: string; url: string | null; envKey: string; detail?: Record<string, string> }>
  worktree: { id: string; name: string; path: string; branch: string | null }
  project: { id: string; name: string }
}

export interface ResolveSetupStep {
  name: string
  run: string
  cwd: string
  env: Record<string, string>
  if_changed: string[] | undefined
}

export interface ResolvedEnvironment {
  /** Layered and deduped by key (last layer wins), each tagged with where it came from. */
  env: EnvVar[]
  /** The same table as a plain map, ready for `spawn`. */
  envMap: Record<string, string>
  /** What `${...}` references resolve against: ports, db, worktree, project, env. */
  scope: Record<string, Record<string, string>>
  /** Every service in the file, in start order — excluded ones included so the UI can show them. */
  services: ResolvedService[]
  excluded: Set<string>
  setup: ResolveSetupStep[]
  /** Absolute path of the dotenv to write, or null when `env_file: false`. */
  envFile: string | null
  /** Resolution decisions worth surfacing (a forced runtime that could not be honoured). */
  notes: string[]
}

/** Secret unless the author said otherwise: key convention first, then credentials in the value. */
const isSecret = (key: string, value: string, explicit?: boolean): boolean => explicit ?? (looksSecret(key) || URL_WITH_PASSWORD.test(value))

export function resolveEnvironment(input: ResolveInput): ResolvedEnvironment {
  const { config, options, settings, ports, databases, worktree, project } = input
  const notes: string[] = []

  // scope.env is the live map: a later layer can reference an earlier one with ${env.KEY}.
  const envMap: Record<string, string> = {}
  const scope: Record<string, Record<string, string>> = {
    ports: Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, String(port)])),
    db: {},
    worktree: { id: worktree.id, name: worktree.name, path: worktree.path, branch: worktree.branch ?? '' },
    project: { id: project.id, name: project.name },
    env: envMap
  }
  for (const db of databases) {
    // A fork that does not exist yet contributes nothing, so `${db.x.url}` stays visible as
    // an unresolved template instead of silently becoming an empty connection string.
    if (db.url === null) continue
    scope['db']![db.name] = db.url
    scope['db']![`${db.name}.url`] = db.url
    // Apps that need a different driver scheme (postgresql+asyncpg://…) rebuild the URL from its parts.
    for (const [key, value] of Object.entries(db.detail ?? {})) scope['db']![`${db.name}.${key}`] = value
  }

  const layered = new Map<string, EnvVar>()
  const put = (key: string, rawValue: string, source: EnvVar['source'], explicitSecret?: boolean): void => {
    const value = interpolate(rawValue, scope)
    layered.set(key, { key, value, source, secret: isSecret(key, value, explicitSecret) })
    envMap[key] = value
  }

  // 1. Canopy's own facts — always available, always overridable by the project.
  put('CANOPY_WORKTREE', worktree.name, 'canopy')
  put('CANOPY_WORKTREE_ID', worktree.id, 'canopy')
  put('CANOPY_WORKTREE_PATH', worktree.path, 'canopy')
  put('CANOPY_PROJECT', project.name, 'canopy')
  put('CANOPY_BRANCH', worktree.branch ?? '', 'canopy')
  for (const [name, port] of Object.entries(ports)) put(`CANOPY_PORT_${upperSnake(name)}`, String(port), 'canopy')
  for (const db of databases) {
    if (db.url === null) continue
    put(`CANOPY_DB_${upperSnake(db.name)}_URL`, db.url, 'canopy')
  }

  // 2. The yaml: defaults.env under env.
  for (const [key, value] of Object.entries(config.defaults.env)) put(key, value, 'yaml')
  for (const [key, value] of Object.entries(config.env)) put(key, value, 'yaml')

  // 3. Database URLs under the keys the file asked for.
  for (const db of databases) {
    if (db.url === null) continue
    put(db.envKey, db.url, 'db', URL_WITH_PASSWORD.test(db.url) ? true : undefined)
  }

  // 4. Project-level defaults, then 5. this worktree's overrides — the last word.
  for (const entry of settings.defaults.env) put(entry.key, entry.value, 'project', entry.secret)
  for (const entry of options.env) put(entry.key, entry.value, 'override', entry.secret)

  const env = [...layered.values()]

  const included = options.services === null ? null : new Set(options.services)
  const excluded = new Set(Object.keys(config.services).filter((name) => included !== null && !included.has(name)))

  const forcedRuntime = options.runtime ?? (settings.defaults.runtime === 'per-service' ? null : settings.defaults.runtime)

  const services: ResolvedService[] = startOrder(config.services).map((name) => {
    const spec = config.services[name]!
    const declared = serviceRuntime(spec, config)
    let runtime = declared
    if (declared !== 'compose' && forcedRuntime !== null) {
      if (forcedRuntime === 'docker' && !spec.docker?.image && !spec.docker?.dockerfile) {
        notes.push(`services.${name}: kept on host — forcing docker needs docker.image or docker.dockerfile`)
      } else {
        runtime = forcedRuntime
      }
    }
    const serviceEnv: Record<string, string> = { ...envMap }
    for (const [key, value] of Object.entries(spec.env)) serviceEnv[key] = interpolate(value, scope)
    return {
      name,
      spec,
      runtime,
      command: interpolate(spec.run ?? '', scope),
      cwd: join(worktree.path, spec.cwd ?? ''),
      env: serviceEnv,
      ports: servicePorts(spec)
        .filter((portName) => ports[portName] !== undefined)
        .map((portName) => ({ name: portName, port: ports[portName]! })),
      stopSignal: spec.stop_signal as NodeJS.Signals,
      stopTimeoutMs: parseDuration(spec.stop_timeout)
    }
  })

  const setup: ResolveSetupStep[] = config.setup.map(normalizeSetupStep).map((step, index) => {
    const stepEnv: Record<string, string> = { ...envMap }
    for (const [key, value] of Object.entries(step.env)) stepEnv[key] = interpolate(value, scope)
    return {
      name: step.name ?? `step ${index + 1}`,
      run: interpolate(step.run, scope),
      cwd: join(worktree.path, step.cwd ?? ''),
      env: stepEnv,
      if_changed: step.if_changed
    }
  })

  return {
    env,
    envMap,
    scope,
    services,
    excluded,
    setup,
    envFile: config.env_file === false ? null : join(worktree.path, config.env_file),
    notes
  }
}

/** Quote only when the shell/dotenv readers would otherwise mis-split the value. */
const quote = (value: string): string =>
  /[\s#'"\\$`]/.test(value) || value.length === 0 ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value

/** The generated dotenv. Deterministic, in resolution order, so a rewrite is a no-op diff. */
export function envFileText(env: EnvVar[]): string {
  const lines = ['# generated by canopy — do not edit', ...env.map((entry) => `${entry.key}=${quote(entry.value)}`)]
  return `${lines.join('\n')}\n`
}

/** Writes the dotenv, creating the directory when the file lives in a subdirectory. */
export function writeEnvFile(path: string, env: EnvVar[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, envFileText(env))
}
