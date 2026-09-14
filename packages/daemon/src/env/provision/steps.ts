/**
 * The eight provisioning steps. Each is idempotent (safe to re-run) and reports one mono
 * "detail" line for the pipeline panel. Heavy lifting lives in the modules they call.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { execa } from 'execa'

import { dbEnvKey as sharedDbEnvKey, normalizeSetupStep, type DbAdapterName, type DbInstanceInfo, type DbSource } from '@canopy/shared'

import type { GitRunner } from '../../git/exec'
import type { PortAllocator } from '../ports/allocator'
import { resolveEnvironment, writeEnvFile, type ResolvedEnvironment } from '../config/resolve'
import type { DbAdapter, DbContext, ProvisionContext, ProvisionStepImpl } from '../types'
import type { WorktreeBackend } from '../worktree/backend'
import { SHARED_STORE_ENV, changedLockfiles, installCommand, linkCaches } from './caches'
import { copyFiles } from './copy-files'

export interface StepDeps {
  git: GitRunner
  backend: WorktreeBackend
  ports: PortAllocator
  databases: { adapterFor(name: DbAdapterName): DbAdapter }
  /** Builds the adapter context for a worktree (the façade knows data dirs and port allocation). */
  dbContext(ctx: ProvisionContext, env: Record<string, string>): DbContext
  /** Context of another worktree, for `{ fromWorktree }` sources; null when it does not exist. */
  dbContextFor(worktreeId: string): DbContext | null
  /** Persists one fork as it lands so the dashboard shows databases before the run finishes. */
  onDatabase(ctx: ProvisionContext, db: DbInstanceInfo): void
  /** Resolves the environment with everything known so far (ports, databases); the façade caches it. */
  resolve(ctx: ProvisionContext): ResolvedEnvironment
  /** Starts the worktree's services (the façade owns supervisors). */
  startServices(ctx: ProvisionContext): Promise<{ started: string[] }>
}

const same = (a: string, b: string): boolean => a.replace(/\/$/, '') === b.replace(/\/$/, '')

/** Runs a shell command in the worktree streaming output to the provision log; rejects with a short error. */
async function runShell(ctx: ProvisionContext, command: string, cwd: string, env: Record<string, string>): Promise<void> {
  ctx.logs.sys(`$ ${command}`)
  const child = execa('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...env }, reject: false, cancelSignal: ctx.signal, all: false, stdout: 'pipe', stderr: 'pipe' })
  const tail: string[] = []
  const pump = async (stream: NodeJS.ReadableStream | null | undefined, sink: (text: string) => void): Promise<void> => {
    if (!stream) return
    let buffer = ''
    for await (const chunk of stream) {
      buffer += String(chunk)
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        sink(part)
        tail.push(part)
        if (tail.length > 8) tail.shift()
      }
    }
    if (buffer) sink(buffer)
  }
  await Promise.all([pump(child.stdout, (t) => ctx.logs.out(t)), pump(child.stderr, (t) => ctx.logs.err(t))])
  const result = await child
  if (result.exitCode !== 0) {
    throw new Error(`\`${command}\` exited with ${result.exitCode ?? 'signal'}${tail.length ? `: ${tail.slice(-3).join(' | ')}` : ''}`)
  }
}

export function createSteps(deps: StepDeps): ProvisionStepImpl[] {
  const createWorktree: ProvisionStepImpl = {
    name: 'create-worktree',
    applies: (ctx) => (existsSync(ctx.worktreePath) ? { run: false, reason: 'worktree exists' } : ctx.branchSpec ? { run: true } : { run: false, reason: 'no branch to create from' }),
    async run(ctx) {
      const spec = ctx.branchSpec as NonNullable<ProvisionContext['branchSpec']>
      const result = await deps.backend.create({
        repoPath: ctx.project.path,
        path: ctx.worktreePath,
        branch: spec,
        useTool: ctx.settings.worktree.tool,
        env: { CANOPY_WORKTREE_ID: ctx.worktreeId },
        onLine: (_stream, text) => ctx.logs.out(text)
      })
      const verb = spec.mode === 'new' ? `${spec.name} from ${spec.base}` : spec.name
      return { detail: `${result.backend === 'canopywt' ? 'canopywt new' : 'git worktree add'} ${verb}` }
    }
  }

  const copy: ProvisionStepImpl = {
    name: 'copy-files',
    applies: (ctx) =>
      same(ctx.sourcePath, ctx.worktreePath) ? { run: false, reason: 'source is this worktree' } : ctx.settings.copyFiles.length === 0 ? { run: false, reason: 'no copy rules' } : { run: true },
    async run(ctx) {
      const copied = await copyFiles({ git: deps.git, sourceRoot: ctx.sourcePath, targetRoot: ctx.worktreePath, rules: ctx.settings.copyFiles, logs: ctx.logs })
      ctx.state.copiedFiles = copied
      return { detail: copied.length > 0 ? copied.join(', ') : 'nothing to copy' }
    }
  }

  const caches: ProvisionStepImpl = {
    name: 'link-caches',
    applies: (ctx) =>
      same(ctx.sourcePath, ctx.worktreePath) ? { run: false, reason: 'source is this worktree' } : ctx.settings.caches.rules.length === 0 ? { run: false, reason: 'no cache rules' } : { run: true },
    async run(ctx) {
      const results = await linkCaches({ sourceRoot: ctx.sourcePath, targetRoot: ctx.worktreePath, rules: ctx.settings.caches.rules, overrides: ctx.options.caches, logs: ctx.logs, signal: ctx.signal })
      ctx.state.caches = results
      if (ctx.settings.caches.reinstallOnLockChange) {
        ctx.state.reinstall = changedLockfiles(ctx.sourcePath, ctx.worktreePath, ctx.project.ecosystems)
        if (ctx.state.reinstall.length > 0) ctx.logs.sys(`lockfile differs for ${ctx.state.reinstall.join(', ')} — setup will reinstall`)
      }
      const applied = results.filter((r) => r.result !== 'skipped' && r.result !== 'missing')
      const summary = applied.map((r) => `${r.path} ${r.result}${r.result === 'cloned' ? ' (CoW)' : ''}`)
      return { detail: summary.length > 0 ? summary.join(' · ') : results.length > 0 ? 'nothing to link' : 'no caches in source' }
    }
  }

  const ports: ProvisionStepImpl = {
    name: 'allocate-ports',
    applies: (ctx) => (!ctx.config ? { run: false, reason: 'no canopy.yaml' } : Object.keys(ctx.config.ports).length === 0 ? { run: false, reason: 'no ports declared' } : { run: true }),
    async run(ctx) {
      const config = ctx.config as NonNullable<ProvisionContext['config']>
      const allocated: Record<string, number> = {}
      for (const [name, spec] of Object.entries(config.ports)) {
        allocated[name] = await deps.ports.allocate(ctx.worktreeId, name, { seedKey: `${ctx.project.id}/${ctx.branch ?? ctx.worktreeName}/${name}`, preferred: spec.preferred, range: spec.range })
      }
      ctx.state.ports = allocated
      return { detail: Object.entries(allocated).map(([name, port]) => `${name}=${port}`).join(' ') }
    }
  }

  const databases: ProvisionStepImpl = {
    name: 'fork-databases',
    applies: (ctx) => (!ctx.config ? { run: false, reason: 'no canopy.yaml' } : Object.keys(ctx.config.databases).length === 0 ? { run: false, reason: 'no databases declared' } : { run: true }),
    async run(ctx) {
      const config = ctx.config as NonNullable<ProvisionContext['config']>
      const envSoFar = Object.fromEntries(deps.resolve(ctx).env.map((v) => [v.key, v.value]))
      const dbCtx = deps.dbContext(ctx, envSoFar)
      const source: DbSource = ctx.options.dbSource
      const sourceCtx = typeof source === 'object' ? (deps.dbContextFor(source.fromWorktree) ?? undefined) : undefined
      if (typeof source === 'object' && !sourceCtx) throw new Error(`source worktree ${source.fromWorktree} no longer exists`)
      const results: DbInstanceInfo[] = []
      for (const [name, spec] of Object.entries(config.databases)) {
        const existing = ctx.state.databases.find((db) => db.name === name)
        if (existing?.status === 'ready') {
          results.push(existing)
          continue
        }
        const adapter = deps.databases.adapterFor(spec.adapter)
        const availability = await adapter.available()
        const envKey = sharedDbEnvKey(name, spec)
        const forkedFrom = source === 'template' ? 'seed template' : source === 'empty' ? 'empty' : `worktree ${sourceCtx?.worktreeName ?? '?'}`
        const pending: DbInstanceInfo = { name, adapter: spec.adapter, status: 'forking', connectionUrl: null, envKey, forkedFrom, forkedFromDatabase: null, forkedFromBranch: sourceCtx?.worktreeBranch ?? null, sizeMb: null, seededAt: null, detail: {}, error: null }
        deps.onDatabase(ctx, pending)
        if (!availability.ok) {
          const failed = { ...pending, status: 'error' as const, error: availability.reason ?? `${spec.adapter} is not available` }
          deps.onDatabase(ctx, failed)
          throw new Error(`${name}: ${failed.error}`)
        }
        try {
          if (source === 'template') await adapter.ensureSource(name, spec, dbCtx, { refresh: false })
          const fork = await adapter.fork(name, spec, dbCtx, source, sourceCtx)
          const ready: DbInstanceInfo = { ...pending, status: 'ready', connectionUrl: fork.url, forkedFromDatabase: fork.sourceDatabase, sizeMb: fork.sizeMb, seededAt: Date.now(), detail: fork.detail }
          deps.onDatabase(ctx, ready)
          results.push(ready)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          deps.onDatabase(ctx, { ...pending, status: 'error', error: message })
          throw new Error(`${name}: ${message}`)
        }
      }
      ctx.state.databases = results
      return { detail: results.map((db) => `${db.name} ← ${db.forkedFromDatabase ?? `${db.forkedFrom} (empty)`}`).join(' · ') }
    }
  }

  const env: ProvisionStepImpl = {
    name: 'write-env',
    applies: (ctx) => (ctx.config ? { run: true } : { run: false, reason: 'no canopy.yaml' }),
    async run(ctx) {
      const resolved = deps.resolve(ctx)
      ctx.state.env = resolved.env
      ctx.state.envFile = null
      if (resolved.envFile) {
        writeEnvFile(resolved.envFile, resolved.env)
        ctx.state.envFile = resolved.envFile.startsWith(ctx.worktreePath) ? resolved.envFile.slice(ctx.worktreePath.length + 1) : resolved.envFile
      }
      return { detail: ctx.state.envFile ? `${ctx.state.envFile} · ${resolved.env.length} vars` : `${resolved.env.length} vars (env_file: false)` }
    }
  }

  const setup: ProvisionStepImpl = {
    name: 'run-setup',
    applies: (ctx) => {
      if (!ctx.config) return { run: false, reason: 'no canopy.yaml' }
      if (ctx.options.skipSetup) return { run: false, reason: 'skipped by request' }
      if (ctx.config.setup.length === 0 && ctx.state.reinstall.length === 0) return { run: false, reason: 'no setup commands' }
      return { run: true }
    },
    async run(ctx) {
      const resolved = deps.resolve(ctx)
      const shellEnv = { ...resolved.envMap, ...(ctx.settings.caches.sharedStores ? SHARED_STORE_ENV : {}) }
      const ran: string[] = []
      for (const ecosystem of ctx.state.reinstall) {
        const command = installCommand(ctx.worktreePath, ecosystem)
        if (!command) continue
        ctx.logs.sys(`lockfile changed for ${ecosystem}: reinstalling`)
        await runShell(ctx, command, ctx.worktreePath, shellEnv)
        ran.push(command)
      }
      for (const step of resolved.setup) {
        if (step.if_changed && step.if_changed.length > 0 && !same(ctx.sourcePath, ctx.worktreePath)) {
          const changed = await anyChanged(ctx.sourcePath, ctx.worktreePath, step.if_changed)
          if (!changed) {
            ctx.logs.sys(`${step.name}: skipped — ${step.if_changed.join(', ')} unchanged`)
            continue
          }
        }
        mkdirSync(step.cwd, { recursive: true })
        await runShell(ctx, step.run, step.cwd, { ...shellEnv, ...step.env })
        ran.push(step.run)
      }
      const normalized = (ctx.config as NonNullable<ProvisionContext['config']>).setup.map(normalizeSetupStep)
      return { detail: ran.length > 0 ? ran.join(' · ') : normalized.length > 0 ? 'all steps up to date' : 'nothing to run' }
    }
  }

  const start: ProvisionStepImpl = {
    name: 'start-services',
    applies: (ctx) => {
      if (!ctx.config) return { run: false, reason: 'no canopy.yaml' }
      if (!ctx.autoStart) return { run: false, reason: 'create only' }
      if (Object.keys(ctx.config.services).length === 0) return { run: false, reason: 'no services declared' }
      return { run: true }
    },
    async run(ctx) {
      const { started } = await deps.startServices(ctx)
      return { detail: started.length > 0 ? started.join(', ') : 'no services selected' }
    }
  }

  return [createWorktree, copy, caches, ports, databases, env, setup, start]
}

/** True when any of the globbed files differs between the two roots (content hash), or exists in one only. */
async function anyChanged(sourceRoot: string, targetRoot: string, patterns: string[]): Promise<boolean> {
  const { createHash } = await import('node:crypto')
  const { readFileSync, statSync } = await import('node:fs')
  const picomatch = (await import('picomatch')).default
  const hash = (path: string): string | null => {
    try {
      if (!statSync(path).isFile()) return null
      return createHash('sha1').update(readFileSync(path)).digest('hex')
    } catch {
      return null
    }
  }
  const { execa: run } = await import('execa')
  const list = async (root: string): Promise<string[]> => {
    const out = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, reject: false })
    return String(out.stdout ?? '').split('\0').filter(Boolean)
  }
  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true }))
  const files = new Set([...(await list(sourceRoot)), ...(await list(targetRoot))].filter((file) => matchers.some((m) => m(file))))
  for (const file of files) if (hash(join(sourceRoot, file)) !== hash(join(targetRoot, file))) return true
  return false
}
