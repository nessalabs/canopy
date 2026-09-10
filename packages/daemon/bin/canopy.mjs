#!/usr/bin/env node
// `canopy` — the hook-facing CLI. Worktrunk hooks (see .config/wt.toml) call it so a worktree
// created or removed from a terminal is provisioned / torn down by the running daemon:
//
//   canopy provision --path <worktree>   [--no-start]   adopt + provision (+ start) a worktree
//   canopy teardown  --path <worktree>                  stop services, drop forks, free ports
//   canopy forget    --path <worktree>                  drop a worktree whose checkout is gone (post-remove)
//   canopy start     --path <worktree>
//   canopy stop      --path <worktree>
//   canopy status    [--json]                            list worktrees and their environment state
//
// Exit code is always 0 from hooks (a missing daemon must never break `wt`); pass --strict to
// surface failures. When the daemon itself drives `wt` it sets CANOPY_DAEMON=1 and this command
// is a no-op — the daemon is already provisioning that worktree.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const command = args[0]
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : (args[index + 1] ?? '')
}
const has = (name) => args.includes(`--${name}`)
const strict = has('strict')

if (process.env.CANOPY_DAEMON === '1' && command !== 'status') process.exit(0)

const home = process.env.CANOPY_HOME ?? join(homedir(), '.canopy')
const port = process.env.CANOPY_PORT ?? '9483'
const base = `http://127.0.0.1:${port}/api/v1`

function fail(message) {
  console.error(`canopy: ${message}`)
  process.exit(strict ? 1 : 0)
}

function token() {
  try {
    return readFileSync(join(home, 'token'), 'utf8').trim()
  } catch {
    return fail(`no token at ${join(home, 'token')} — is canopyd running?`)
  }
}

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000)
  })
  if (response.status === 204) return undefined
  const text = await response.text()
  const json = text ? JSON.parse(text) : undefined
  if (!response.ok) throw new Error(json?.error?.message ?? `${response.status} ${response.statusText}`)
  return json
}

async function worktreeByPath(path) {
  const { worktrees } = await call('GET', '/worktrees')
  const target = resolve(path)
  return worktrees.find((wt) => resolve(wt.path) === target)
}

async function main() {
  const path = flag('path') ?? process.cwd()
  switch (command) {
    case 'provision': {
      const worktree = await call('POST', '/worktrees/adopt', { path: resolve(path), autoStart: !has('no-start') })
      console.log(`canopy: provisioning ${worktree.worktree.name} (${worktree.worktree.environment.state})`)
      return
    }
    case 'teardown':
    case 'forget':
    case 'start':
    case 'stop': {
      const worktree = await worktreeByPath(path)
      if (!worktree) return fail(`no worktree registered at ${path}`)
      if (command === 'forget') {
        if (worktree.isMain) return fail('refusing to forget the primary checkout')
        await call('DELETE', `/worktrees/${worktree.id}?force=true`)
        console.log(`canopy: forgot ${worktree.name}`)
        return
      }
      if (command === 'teardown') {
        await call('POST', `/worktrees/${worktree.id}/teardown`)
        console.log(`canopy: tore down ${worktree.name}`)
        return
      }
      await call('POST', `/worktrees/${worktree.id}/${command}`)
      console.log(`canopy: ${command} ${worktree.name}`)
      return
    }
    case 'status': {
      const { worktrees } = await call('GET', '/worktrees')
      if (has('json')) return console.log(JSON.stringify(worktrees, null, 2))
      for (const wt of worktrees) {
        const env = wt.environment
        const ports = Object.entries(env.ports).map(([name, p]) => `${name}=${p}`).join(' ')
        console.log(`${env.state.padEnd(12)} ${wt.name.padEnd(28)} ${(wt.branch ?? 'detached').padEnd(32)} ${ports}`)
      }
      return
    }
    default:
      console.error('usage: canopy <provision|teardown|forget|start|stop|status> [--path <worktree>] [--no-start] [--json] [--strict]')
      process.exit(strict ? 2 : 0)
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
