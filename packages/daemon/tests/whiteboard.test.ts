import { describe, expect, it } from 'vitest'

import { EMPTY_PLAN, type PlanState } from '@canopy/shared'

import { checkoutFiles, whiteboardHandler } from '../src/agents/whiteboard'

const board = {
  id: 'overview',
  title: 'Overview',
  story: 'How a message reaches the agent.',
  mermaid: 'flowchart LR\n  ui[Composer] --> d[Daemon]',
  notes: { ui: { explain: 'Where you type.', ref: 'src/composer.tsx:1-9' }, d: { explain: 'Runs agents.', status: 'new', ref: 'src/new.ts' } }
}

describe('checkoutFiles', () => {
  it('knows files by their path from the repository root, and nothing outside or absolute', () => {
    const exists = checkoutFiles(process.cwd())
    expect(exists('package.json')).toBe(true)
    expect(exists('./package.json')).toBe(true)
    expect(exists('nope/package.json')).toBe(false)
    expect(exists('../package.json')).toBe(false)
    expect(exists('..')).toBe(false)
    expect(exists(`${process.cwd()}/package.json`)).toBe(false)
  })
})

describe('whiteboard tools', () => {
  it('draws, answers in one line and keeps the plan for the next call', async () => {
    const plan = { state: EMPTY_PLAN as PlanState }
    const draw = whiteboardHandler('draw_board', plan, (path) => path === 'src/composer.tsx')
    expect(await draw(board)).toEqual({ content: [{ type: 'text', text: 'Drawn: board "overview" v1, 2 boxes.' }] })
    expect(plan.state.order).toEqual(['overview'])
    const edit = whiteboardHandler('edit_board', plan, () => true)
    expect((await edit({ id: 'overview', mermaid: 'd[Canopy daemon]' })).content[0]!.text).toBe('Edited: board "overview" v2, changed d.')
  })

  it('keeps a board that cites a missing file, unless the box is new, and asks for a patch', async () => {
    const plan = { state: EMPTY_PLAN as PlanState }
    const result = await whiteboardHandler('draw_board', plan, () => false)(board)
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe(
      'Drawn: board "overview" v1, 2 boxes. Patch with edit_board (send only these):\n- note "ui": "src/composer.tsx" is not in this checkout; cite a file you read (path from the repository root), or mark the box new'
    )
    expect(plan.state.order).toEqual(['overview'])
  })

  it('refuses a drawing it cannot read and changes nothing', async () => {
    const plan = { state: EMPTY_PLAN as PlanState }
    const result = await whiteboardHandler('draw_board', plan, () => true)({ ...board, mermaid: 'a --> b' })
    expect(result.isError).toBe(true)
    expect(plan.state).toBe(EMPTY_PLAN)
  })
})
