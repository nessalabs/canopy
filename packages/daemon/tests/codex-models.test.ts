import { describe, expect, it } from 'vitest'

import { codexModels } from '../src/agents/codex'

describe('codexModels', () => {
  it('lists the catalog with the efforts Canopy has a stop for', () => {
    expect(
      codexModels([
        {
          id: 'gpt-5.3-codex',
          displayName: 'GPT-5.3 Codex',
          description: 'Coding',
          supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }]
        },
        { id: 'bare' },
        { id: 'internal', hidden: true }
      ])
    ).toEqual([
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Coding', effortLevels: ['low', 'max'] },
      { id: 'bare', label: 'bare', description: undefined, effortLevels: [] }
    ])
  })

  it('reads a missing catalog as empty', () => {
    expect(codexModels(undefined)).toEqual([])
  })
})
