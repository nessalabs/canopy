import { describe, expect, it } from 'vitest'

import { modelGroupsFor } from '../src/lib/models'

const codex = [{ id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', effortLevels: [] }]

describe('modelGroupsFor', () => {
  it('offers a tab per installed provider, the current one first when missing', () => {
    const groups = modelGroupsFor(['claude', 'codex'], 'claude', 'opus', { codex }, true)
    expect(groups.map((group) => group.id)).toEqual(['claude', 'codex'])
    expect(groups[1].models.map((model) => model.id)).toEqual(['gpt-5.3-codex'])
    expect(groups[1].models[0].disabled).toBeUndefined()
  })

  it('greys out another provider once the chat has messages', () => {
    const [, other] = modelGroupsFor(['claude', 'codex'], 'claude', 'opus', { codex }, false)
    expect(other.models[0]).toMatchObject({ disabled: true, description: 'Start a new chat to use Codex' })
  })

  it('lists only the current provider when it is the only one offered', () => {
    expect(modelGroupsFor(['claude'], 'claude', undefined, {}, true).map((group) => group.id)).toEqual(['claude'])
  })
})
