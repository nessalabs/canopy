import { describe, expect, it } from 'vitest'

import type { AgentCommand } from '@canopy/shared'

import { CANOPY_PROMPTS, agentMention, commandMenu, isHiddenCommand, isNewSessionCommand } from '../src/lib/compose'

const command = (name: string, source: AgentCommand['source'], extra: Partial<AgentCommand> = {}): AgentCommand => ({
  name,
  description: `${name} does a thing`,
  source,
  ...extra
})

describe('commandMenu', () => {
  it('groups what the provider advertises and keeps Canopy’s prompts last', () => {
    const items = commandMenu([
      command('review', 'custom'),
      command('pdf', 'plugin', { plugin: 'docs' }),
      command('compact', 'builtin'),
      command('postgresql', 'skill')
    ])
    expect(items.map((item) => item.group)).toEqual(['Commands', 'Skills', 'Custom commands', 'Plugins', ...CANOPY_PROMPTS.map(() => 'Canopy prompts')])
    expect(items[0]).toMatchObject({ name: 'compact', group: 'Commands' })
    expect(items.at(-1)?.group).toBe('Canopy prompts')
  })

  it('sorts by name inside a group', () => {
    const items = commandMenu([command('zeta', 'builtin'), command('alpha', 'builtin')])
    expect(items.slice(0, 2).map((item) => item.name)).toEqual(['alpha', 'zeta'])
  })

  it('leaves out what a remote UI cannot run', () => {
    const hidden = [
      command('color', 'terminal'),
      command('__internal', 'builtin'),
      command('heapdump', 'builtin'),
      command('design-consent', 'builtin'),
      // Measured: these answer "not available" through the SDK, or open a browser on the daemon's host.
      command('help', 'builtin'),
      command('fast', 'builtin'),
      command('usage-credits', 'builtin'),
      command('loop', 'builtin')
    ]
    for (const entry of hidden) expect(isHiddenCommand(entry)).toBe(true)
    expect(commandMenu(hidden).every((item) => item.group === 'Canopy prompts')).toBe(true)
  })

  it('keeps the built-ins that answer through the SDK', () => {
    // Measured on 2026-09-10: each of these produced its output when sent as the prompt.
    for (const name of ['context', 'usage', 'compact', 'model', 'effort', 'config', 'mcp', 'rename', 'reload-skills', 'reload-plugins', 'skill-doctor', 'goal', 'recap', 'init', 'insights', 'schedule', 'doctor', 'clear', 'list-agents'])
      expect(isHiddenCommand(command(name, 'builtin'))).toBe(false)
  })

  it('keeps a builtin name that only a plugin would hide', () => {
    // `import` is hidden as a builtin; a skill of the same name is the user's own.
    expect(isHiddenCommand(command('import', 'skill'))).toBe(false)
    expect(isHiddenCommand(command('import', 'builtin'))).toBe(true)
  })

  it('carries the argument hint and aliases a row is searched by', () => {
    const [item] = commandMenu([command('commit', 'custom', { argumentHint: '<message>', aliases: ['ci'] })])
    expect(item).toMatchObject({ name: 'commit', argumentHint: '<message>', aliases: ['ci'] })
  })

  it('is Canopy’s own prompts alone when the provider has said nothing yet', () => {
    const items = commandMenu(undefined)
    expect(items).toHaveLength(CANOPY_PROMPTS.length)
    expect(items.map((item) => item.name).sort()).toEqual(CANOPY_PROMPTS.map((item) => item.name).sort())
    expect(items.every((item) => item.prompt)).toBe(true)
  })
})

describe('isNewSessionCommand', () => {
  it('catches the commands that end a conversation rather than speak in it', () => {
    for (const draft of ['/clear', '/reset', '/new', '  /clear  ']) expect(isNewSessionCommand(draft)).toBe(true)
  })

  it('leaves everything else to the agent', () => {
    for (const draft of ['/clearly explain this', '/compact', 'clear the cache', '/clear the desk', '']) {
      expect(isNewSessionCommand(draft)).toBe(false)
    }
  })
})

describe('agentMention', () => {
  it('writes the CLI’s own syntax, with the space that ends the token', () => {
    expect(agentMention('explorer')).toBe('@agent-explorer ')
  })
})
