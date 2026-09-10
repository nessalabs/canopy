/**
 * canopy.yaml parsing and linting — one implementation for the daemon (registration,
 * provisioning) and the UI (live lint in the settings editor). Pure: no I/O.
 */
import { parse as parseYamlText } from 'yaml'

import { CANOPY_TOP_KEYS, CanopyConfig, type CanopyYamlReport, type ServiceSpec, type SetupStep } from './schemas/environment'

export interface CanopyYamlParse {
  config: CanopyConfig | null
  errors: string[]
  warnings: string[]
}

const TEMPLATE_REF = /\$\{([a-z_]+)\.([a-z0-9_-]+)(?:\.([a-z_]+))?\}/g

/** Every `${ports.x}` / `${db.x.url}` reference in a string. */
export function templateRefs(text: string): Array<{ scope: string; name: string; field?: string }> {
  const refs: Array<{ scope: string; name: string; field?: string }> = []
  for (const match of text.matchAll(TEMPLATE_REF)) {
    refs.push({ scope: match[1] ?? '', name: match[2] ?? '', field: match[3] })
  }
  return refs
}

/** `setup:` entries may be bare strings; this gives every step the object form. */
export const normalizeSetupStep = (step: string | SetupStep, index: number): SetupStep =>
  typeof step === 'string' ? { run: step, name: `step ${index + 1}`, env: {} } : { ...step, name: step.name ?? `step ${index + 1}` }

const BARE_PORT_REF = /^\s*\$\{ports\.([a-z0-9_-]+)\}\s*$/

/**
 * Named ports a service listens on: explicit `ports:`, else every `${ports.x}` in its run
 * command plus env values that are a bare port reference (`PORT: "${ports.web}"`). A port
 * embedded in a URL (`API_URL: http://localhost:${ports.api}`) points at another service and
 * is not counted.
 */
export function servicePorts(service: ServiceSpec): string[] {
  if (service.ports) return service.ports
  const names = new Set<string>()
  for (const ref of templateRefs(service.run ?? '')) if (ref.scope === 'ports') names.add(ref.name)
  for (const value of Object.values(service.env)) {
    const bare = BARE_PORT_REF.exec(value)
    if (bare?.[1]) names.add(bare[1])
  }
  return [...names]
}

/** Effective runtime for a service given the file's defaults. */
export const serviceRuntime = (service: ServiceSpec, config: CanopyConfig): 'host' | 'docker' | 'compose' =>
  service.compose ? 'compose' : (service.runtime ?? config.defaults.runtime)

/** Topological start order; throws on cycles/unknown deps (callers validate first). */
export function startOrder(services: Record<string, ServiceSpec>, include?: Set<string>): string[] {
  const names = Object.keys(services).filter((name) => !include || include.has(name))
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string, trail: string[]): void => {
    const mark = state.get(name)
    if (mark === 'done') return
    if (mark === 'visiting') throw new Error(`depends_on cycle: ${[...trail, name].join(' → ')}`)
    state.set(name, 'visiting')
    for (const dep of services[name]?.depends_on ?? []) {
      if (!names.includes(dep)) continue
      visit(dep, [...trail, name])
    }
    state.set(name, 'done')
    order.push(name)
  }
  for (const name of names) visit(name, [])
  return order
}

/** Semantic checks zod cannot express: references, cycles, runtime requirements. */
export function lintConfig(config: CanopyConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const portNames = new Set(Object.keys(config.ports))
  const dbNames = new Set(Object.keys(config.databases))
  const serviceNames = new Set(Object.keys(config.services))

  const checkRefs = (where: string, text: string): void => {
    for (const ref of templateRefs(text)) {
      if (ref.scope === 'ports' && !portNames.has(ref.name)) errors.push(`${where}: unknown port \${ports.${ref.name}}`)
      if (ref.scope === 'db' && !dbNames.has(ref.name)) errors.push(`${where}: unknown database \${db.${ref.name}.${ref.field ?? 'url'}}`)
      if (!['ports', 'db', 'worktree', 'project', 'env'].includes(ref.scope)) warnings.push(`${where}: unknown template scope \${${ref.scope}.…}`)
    }
  }

  for (const [key, value] of Object.entries({ ...config.defaults.env, ...config.env })) checkRefs(`env.${key}`, value)

  for (const [name, service] of Object.entries(config.services)) {
    const where = `services.${name}`
    const runtime = serviceRuntime(service, config)
    if (!service.run && !service.compose) errors.push(`${where}: needs run: (or compose:)`)
    if (runtime === 'docker' && !service.docker?.image && !service.docker?.dockerfile) errors.push(`${where}: runtime docker needs docker.image or docker.dockerfile`)
    if (service.compose && service.run) warnings.push(`${where}: run: is ignored for a compose service`)
    checkRefs(where + '.run', service.run ?? '')
    for (const [key, value] of Object.entries(service.env)) checkRefs(`${where}.env.${key}`, value)
    if (service.health?.http) checkRefs(`${where}.health.http`, service.health.http)
    if (typeof service.health?.tcp === 'string') checkRefs(`${where}.health.tcp`, service.health.tcp)
    for (const port of service.ports ?? []) if (!portNames.has(port)) errors.push(`${where}.ports: unknown port ${port}`)
    for (const dep of service.depends_on) {
      if (dep === name) errors.push(`${where}: depends on itself`)
      else if (!serviceNames.has(dep)) errors.push(`${where}: depends_on unknown service ${dep}`)
    }
  }
  try {
    startOrder(config.services)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  for (const [name, db] of Object.entries(config.databases)) {
    const where = `databases.${name}`
    if (db.adapter === 'sqlite' && !db.source) warnings.push(`${where}: sqlite without source: starts empty`)
    if (db.adapter !== 'sqlite' && db.source) warnings.push(`${where}: source: only applies to sqlite (use seed:)`)
    if ((db.adapter === 'postgres' || db.adapter === 'mysql') && !db.seed) warnings.push(`${where}: no seed — forks start empty`)
    if (db.seed && [db.seed.dump, db.seed.sql, db.seed.command].filter(Boolean).length > 1) errors.push(`${where}.seed: use one of dump, sql or command`)
  }

  config.setup.map(normalizeSetupStep).forEach((step) => {
    checkRefs(`setup ${step.name}`, step.run)
    for (const [key, value] of Object.entries(step.env)) checkRefs(`setup ${step.name}.env.${key}`, value)
  })

  if (serviceNames.size === 0) warnings.push('no services: — nothing will run')
  const exposed = new Set(Object.values(config.services).flatMap((service) => servicePorts(service)))
  for (const port of portNames) if (!exposed.has(port)) warnings.push(`ports.${port} is not referenced by any service`)

  return { errors, warnings }
}

/** Parses YAML text into a defaulted CanopyConfig with line-free but path-qualified errors. */
export function parseCanopyYaml(text: string): CanopyYamlParse {
  let doc: unknown
  try {
    doc = parseYamlText(text)
  } catch (error) {
    return { config: null, errors: [`yaml: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`], warnings: [] }
  }
  if (doc === null || doc === undefined) return { config: null, errors: ['empty file — start with version: 1'], warnings: [] }
  if (typeof doc !== 'object' || Array.isArray(doc)) return { config: null, errors: ['top level must be a mapping'], warnings: [] }

  const warnings: string[] = []
  for (const key of Object.keys(doc as Record<string, unknown>)) {
    if (!(CANOPY_TOP_KEYS as readonly string[]).includes(key)) warnings.push(`unknown top-level key "${key}:"`)
  }
  if (/\t/.test(text)) warnings.push('tab characters found — YAML indentation must use spaces')

  const result = CanopyConfig.safeParse(doc)
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    return { config: null, errors, warnings }
  }
  const lint = lintConfig(result.data)
  return { config: lint.errors.length === 0 ? result.data : null, errors: lint.errors, warnings: [...warnings, ...lint.warnings] }
}

export function reportFor(parsed: CanopyYamlParse | null): CanopyYamlReport {
  if (!parsed) return { present: false, valid: false, errors: [], warnings: [], services: 0, ports: 0, databases: 0 }
  const config = parsed.config
  return {
    present: true,
    valid: config !== null,
    errors: parsed.errors,
    warnings: parsed.warnings,
    services: config ? Object.keys(config.services).length : 0,
    ports: config ? Object.keys(config.ports).length : 0,
    databases: config ? Object.keys(config.databases).length : 0
  }
}

export const EMPTY_REPORT: CanopyYamlReport = reportFor(null)

/** Milliseconds for a `Duration` string. */
export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value)
  if (!match) throw new Error(`bad duration: ${value}`)
  const n = Number(match[1])
  return match[2] === 'ms' ? n : match[2] === 's' ? n * 1000 : n * 60_000
}

/** A starter canopy.yaml written by the scaffolder and the docs. */
export const STARTER_CANOPY_YAML = `version: 1
# name: my-app

# Named ports — every worktree gets its own free number. Reference as \${ports.web}.
ports:
  web: {}

# Databases forked per worktree: postgres | mysql | sqlite | redis
# databases:
#   main:
#     adapter: postgres
#     version: "16"
#     seed: { dump: ./db/seed.dump }
#     env: DATABASE_URL

# Commands run once when a worktree is provisioned (env already resolved).
setup:
  - run: npm ci
    if_changed: [package-lock.json]

services:
  web:
    run: npm run dev -- --port \${ports.web}
    health: { tcp: "\${ports.web}" }
    restart: on-failure

env_file: .env.canopy
`
