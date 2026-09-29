/**
 * The eight provisioning steps. Each is idempotent (safe to re-run) and reports one mono
 * "detail" line for the pipeline panel. Heavy lifting lives in the modules they call.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { execa } from 'execa'

import { dbEnvKey as sharedDbEnvKey, normalizeSetupStep, type DbAdapterName, type DbInstanceInfo, type DbSource, type PortSpec } from '@canopy/shared'

import type { GitRunner } from '../../git/exec'
import type { PortAllocator } from '../ports/allocator'
import { resolveEnvironment, type ResolvedEnvironment } from '../config/resolve'
import type { DbAdapter, DbContext, ProvisionContext, ProvisionStepImpl } from '../types'
import { rulesFor, type Canopyd } from '../worktree/canopyd'
import type { WorktreeBackend } from '../worktree/backend'
import { SHARED_STORE_ENV, changedLockfiles, installCommand } from './caches'

export interface StepDeps {
  git: GitRunner
  backend: WorktreeBackend
  canopyd: Canopyd
  /** Still allocates the ports the crate has no concept of — a database fork's container port. */
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
  /** Writes the env file — through canopyd when it can see the worktree, by hand otherwise. */
  writeEnv(ctx: ProvisionContext, resolved: ResolvedEnvironment): Promise<void>
  /** Starts the worktree's services (the façade owns supervisors). */
  startServices(ctx: ProvisionContext): Promise<{ started: string[] }>
  /**
   * Whether the steps go through `canopyd`: the project allows it and it is installed. Without
   * it a worktree still gets ports and setup — from the daemon itself — but no copy rules.
   */
  toolUsable(ctx: ProvisionContext): Promise<boolean>
  /** The project's out-of-repo canopy.yaml, which `canopyd` would not otherwise find. */
  homeConfig(ctx: ProvisionContext): string | undefined
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
  /** The declared ports from the daemon's own allocator, for when `canopyd` is not there. */
  const allocateHere = async (ctx: ProvisionContext, declared: Record<string, PortSpec>): Promise<Record<string, number>> => {
    const allocated: Record<string, number> = {}
    for (const [name, spec] of Object.entries(declared)) {
      allocated[name] = await deps.ports.allocate(ctx.worktreeId, name, {
        seedKey: `${ctx.project.id}/${ctx.branch ?? ctx.worktreeName}/${name}`,
        preferred: spec.preferred,
        range: spec.range
      })
    }
    return allocated
  }

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
      return { detail: `${result.backend === 'canopyd' ? 'canopyd new' : 'git worktree add'} ${verb}` }
    }
  }

  /**
   * Copy rules and cache rules are one thing to the crate: both name gitignored paths to carry
   * into a worktree, and `node_modules` is as gitignored as `.env` is. That is why this replaced
   * two steps and two modules.
   */
  const copy: ProvisionStepImpl = {
    name: 'copy-files',
    applies: (ctx) => {
      if (same(ctx.sourcePath, ctx.worktreePath)) return { run: false, reason: 'source is this worktree' }
      return rulesFor(ctx.settings.copyFiles, ctx.settings.caches.rules).length === 0 ? { run: false, reason: 'no copy rules' } : { run: true }
    },
    async run(ctx) {
      const rules = rulesFor(ctx.settings.copyFiles, ctx.settings.caches.rules)
      if (!(await deps.toolUsable(ctx))) {
        // Copying is the crate's; the daemon no longer carries an implementation of its own.
        ctx.logs.sys(`copy rules skipped: canopyd is ${ctx.settings.worktree.tool ? 'not installed (./dev.sh install-canopyd)' : 'turned off for this project'}`)
        return { detail: 'skipped — needs canopyd' }
      }
      const branch = ctx.branch ?? ctx.worktreeName
      const outcome = await deps.canopyd.copy({
        cwd: ctx.worktreePath,
        branch,
        config: deps.homeConfig(ctx),
        source: ctx.sourcePath,
        rules,
        onLine: (_stream, text) => ctx.logs.out(text)
      })

      // Only paths that actually moved are "copied"; a skipped one was already there.
      const landed = outcome.entries.filter((entry) => entry.result !== 'skipped' && entry.result !== 'planned')
      ctx.state.copiedFiles = landed.map((entry) => entry.path)
      for (const failure of outcome.failures) ctx.logs.sys(`could not copy ${failure.path}: ${failure.message}`)

      if (ctx.settings.caches.reinstallOnLockChange) {
        ctx.state.reinstall = changedLockfiles(ctx.sourcePath, ctx.worktreePath, ctx.project.ecosystems)
        if (ctx.state.reinstall.length > 0) ctx.logs.sys(`lockfile differs for ${ctx.state.reinstall.join(', ')} — setup will reinstall`)
      }

      const cloned = landed.filter((entry) => entry.result === 'cloned').length
      const bytes = landed.reduce((total, entry) => total + entry.bytes, 0)
      const detail =
        landed.length === 0
          ? 'nothing to copy'
          : `${landed.length} path(s), ${Math.round(bytes / 1024)}KiB${cloned > 0 ? `, ${cloned} cloned (CoW)` : ''}${outcome.failures.length > 0 ? `, ${outcome.failures.length} failed` : ''}`
      return { detail }
    }
  }

  const ports: ProvisionStepImpl = {
    name: 'allocate-ports',
    applies: (ctx) => (!ctx.config ? { run: false, reason: 'no canopy.yaml' } : Object.keys(ctx.config.ports).length === 0 ? { run: false, reason: 'no ports declared' } : { run: true }),
    async run(ctx) {
      const declared = (ctx.config as NonNullable<ProvisionContext['config']>).ports
      // The crate owns the registry, shared by every project this daemon runs. Without it the
      // daemon's own allocator hands the numbers out, so services still start.
      const allocated = (await deps.toolUsable(ctx))
        ? await deps.canopyd.ports({
            cwd: ctx.worktreePath,
            branch: ctx.branch ?? ctx.worktreeName,
            config: deps.homeConfig(ctx),
            onLine: (_stream, text) => ctx.logs.out(text)
          })
        : await allocateHere(ctx, declared)
      ctx.state.ports = allocated
      // Mirrored into the daemon's table so database allocation, which the crate knows nothing
      // about, cannot hand out a number a service already has.
      for (const [name, port] of Object.entries(allocated)) deps.ports.record(ctx.worktreeId, name, port)
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
        await deps.writeEnv(ctx, resolved)
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

      // Reinstalls stay here: which command reinstalls a Node or Python project is Canopy's
      // ecosystem detection, which the crate has no notion of.
      for (const ecosystem of ctx.state.reinstall) {
        const command = installCommand(ctx.worktreePath, ecosystem)
        if (!command) continue
        ctx.logs.sys(`lockfile changed for ${ecosystem}: reinstalling`)
        await runShell(ctx, command, ctx.worktreePath, shellEnv)
        ran.push(command)
      }

      if ((ctx.config as NonNullable<ProvisionContext['config']>).setup.length > 0) {
        // The steps themselves are the crate's, so `if_changed` has one implementation rather
        // than two that can disagree about whether a lockfile moved.
        if (!(await deps.toolUsable(ctx))) {
          // The steps as the daemon resolved them, run in order. No `if_changed`: telling
          // whether a lockfile moved is the crate's, so without it every step runs.
          for (const step of resolved.setup) {
            // Created if absent, as the crate does.
            mkdirSync(step.cwd, { recursive: true })
            await runShell(ctx, step.run, step.cwd, { ...shellEnv, ...step.env })
            ran.push(step.name)
          }
          const declared = (ctx.config as NonNullable<ProvisionContext['config']>).setup.length
          return { detail: ran.length > 0 ? ran.join(' · ') : declared > 0 ? 'all steps up to date' : 'nothing to run' }
        }
        const outcome = await deps.canopyd.setup({
          cwd: ctx.worktreePath,
          branch: ctx.branch ?? ctx.worktreeName,
          config: deps.homeConfig(ctx),
          env: shellEnv,
          onLine: (_stream, text) => ctx.logs.out(text)
        })
        for (const step of outcome.steps) {
          if (step.result.kind === 'ran') ran.push(step.name)
          else if (step.result.kind === 'skipped') ctx.logs.sys(`${step.name}: skipped — ${step.result.reason}`)
        }
        const failed = outcome.steps.find((step) => step.result.kind === 'failed')
        if (failed && failed.result.kind === 'failed') {
          const tail = failed.result.tail.slice(-3).join(' | ')
          throw new Error(`setup step ${failed.name} failed (${failed.result.status})${tail ? `: ${tail}` : ''}`)
        }
      }

      const declared = (ctx.config as NonNullable<ProvisionContext['config']>).setup.length
      return { detail: ran.length > 0 ? ran.join(' · ') : declared > 0 ? 'all steps up to date' : 'nothing to run' }
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

  return [createWorktree, copy, ports, databases, env, setup, start]
}

