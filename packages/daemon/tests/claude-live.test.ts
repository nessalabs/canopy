import { describe, expect, it } from 'vitest'
import { createLiveTurn, type LiveQuery } from '../src/agents/claude-live'

describe('live turn permission mode', () => {
  const turnWith = (refuse: string[]) => {
    const modes: string[] = []
    const query = {
      setPermissionMode: async (mode: string) => {
        if (refuse.includes(mode)) throw new Error(`Cannot set permission mode to ${mode}: auto mode unavailable for this model`)
        modes.push(mode)
      }
    } as unknown as LiveQuery
    return { modes, turn: createLiveTurn(query, { push: () => {} } as never) }
  }

  it('steps down to acceptEdits when the CLI refuses auto mode', async () => {
    const { modes, turn } = turnWith(['auto'])
    await turn.setPermissionMode('auto')
    expect(modes).toEqual(['acceptEdits'])
  })

  it('switches straight to auto mode where the CLI allows it', async () => {
    const { modes, turn } = turnWith([])
    await turn.setPermissionMode('auto')
    expect(modes).toEqual(['auto'])
  })

  it('does not swap in another mode when a different switch is refused', async () => {
    const { modes, turn } = turnWith(['bypassPermissions'])
    await turn.setPermissionMode('bypassPermissions')
    expect(modes).toEqual([])
  })
})
