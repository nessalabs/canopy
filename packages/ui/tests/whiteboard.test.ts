import { describe, expect, it } from 'vitest'

import { applyCall, boxMessage, decisionMessage, EMPTY_VIEW, EMPTY_PLAN, type DrawBoardInput, type PlanState } from '@canopy/shared'
import type { AgentEvent, Turn } from '@canopy/shared/agent-stream'

import { BOARD_SIZE, boardOutline, boundsOf, boxLines, decisionsOn, mentionedBoxes, notesMessage, tourSteps, trailOf, viewportFor, zoomAround, boxInfo, threadOf, layoutBoards, nextMode, approvalStep, progressOn, progressSummary, refTarget } from '../src/lib/whiteboard'

const board = (id: string, boxes: string[], parent?: string): DrawBoardInput => ({
  id,
  ...(parent ? { parent } : {}),
  title: `Board ${id}`,
  story: 'What this shows.',
  mermaid: `flowchart LR\n${boxes.map((box) => `  ${box}[${box.toUpperCase()}]`).join('\n')}`,
  notes: Object.fromEntries(boxes.map((box) => [box, { explain: `About ${box}.`, ref: `src/${box}.ts:3-9` }]))
})

const plan = (...inputs: DrawBoardInput[]): PlanState => inputs.reduce((state, input) => applyCall(state, 'draw_board', input).state, EMPTY_PLAN)

describe('layoutBoards', () => {
  it('puts detail boards in the next column, a parent level with its first child, subtrees apart', () => {
    const nested = plan(board('overview', ['a', 'b']), board('a', ['x'], 'overview/a'), board('a1', ['y'], 'a/x'), board('b', ['z'], 'overview/b'))
    const { width, height, gap } = BOARD_SIZE
    expect(layoutBoards(nested)).toEqual({
      overview: { x: 0, y: 0 },
      a: { x: width + gap, y: 0 },
      a1: { x: 2 * (width + gap), y: 0 },
      b: { x: width + gap, y: height + gap }
    })
  })
})

describe('layoutBoards with measured sizes', () => {
  it('makes a column as wide as its widest board and stacks a tall subtree before the next', () => {
    const nested = plan(board('overview', ['a', 'b']), board('a', ['x'], 'overview/a'), board('b', ['z'], 'overview/b'))
    const placed = layoutBoards(nested, { overview: { width: 1000, height: 300 }, a: { width: 500, height: 900 } })
    expect(placed.a).toEqual({ x: 1000 + BOARD_SIZE.gap, y: 0 })
    expect(placed.b).toEqual({ x: 1000 + BOARD_SIZE.gap, y: 900 + BOARD_SIZE.gap })
  })
})

describe('boardOutline', () => {
  it('lists boards in reading order, indented under the box they open', () => {
    const nested = plan(board('overview', ['a', 'b']), board('b', ['z'], 'overview/b'))
    expect(boardOutline(nested)).toEqual([
      { id: 'overview', title: 'Board overview', depth: 0 },
      { id: 'b', title: 'Board b', depth: 1, via: 'B' }
    ])
  })
})

describe('boxInfo', () => {
  it('reads a box with its note, citations, progress and detail board', () => {
    const marked = applyCall(plan(board('overview', ['a', 'b']), board('b', ['z'], 'overview/b')), 'set_progress', { doing: ['overview/b'] }).state
    const info = boxInfo(marked, { board: 'overview', box: 'b' })
    expect(info).toMatchObject({ node: { id: 'b', label: 'B' }, note: { explain: 'About b.' }, refs: ['src/b.ts:3-9'], progress: 'doing', detail: 'b' })
    expect(boxInfo(marked, { board: 'overview', box: 'nope' })).toBeUndefined()
    expect(progressSummary(marked)).toEqual({ done: 0, doing: 1 })
    expect(progressOn(marked, 'overview')).toEqual({ b: 'doing' })
    expect(progressOn(marked, 'b')).toEqual({})
  })
})

describe('threadOf', () => {
  const prompt = (id: string, text: string): AgentEvent => ({ id, sessionId: 's', seq: 0, ts: null, agentPath: [], raw: null, payload: { type: 'user_message', text, synthetic: false } })
  const turn = (event: AgentEvent, finalText: string | null): Turn => ({ key: event.id, prompt: event, work: [], completed: null, finalText, toolCalls: 0, usage: null })

  it('pairs each question about the box with the answer its turn ended on', () => {
    const asked = prompt('q1', boxMessage({ board: 'overview', box: 'a' }, 'A', 'Why here?'))
    const other = prompt('q2', 'Something else')
    expect(threadOf([turn(asked, 'Because.'), turn(other, 'Sure.')], ['q1'])).toEqual([{ id: 'q1', question: 'Why here?', answer: 'Because.' }])
    expect(threadOf([turn(asked, null)], undefined)).toEqual([])
  })
})

describe('nextMode', () => {
  it('turns an approved plan into a build and leaves every other mode alone', () => {
    expect(nextMode('plan', true)).toBe('build')
    expect(nextMode('plan', false)).toBe('plan')
    expect(nextMode('explain', true)).toBe('explain')
    expect(nextMode(undefined, true)).toBeUndefined()
  })
})

describe('refTarget', () => {
  it('splits a citation into the file and its lines', () => {
    expect(refTarget('src/a.ts:3-9')).toEqual({ path: 'src/a.ts', lines: '3-9' })
    expect(refTarget('src/a.ts')).toEqual({ path: 'src/a.ts' })
  })
})

describe('the canvas view', () => {
  it('fits a small board at full size, centred', () => {
    expect(viewportFor({ x: 100, y: 0, width: 400, height: 200 }, 1000, 600)).toEqual({ zoom: 1, x: 300 - 100, y: 200 })
  })

  it('keeps a wide board readable: never below the floor, lined up on its left edge', () => {
    const view = viewportFor({ x: 0, y: 0, width: 4000, height: 300 }, 1000, 600, 0.7)
    expect(view.zoom).toBe(0.7)
    expect(view.x).toBe(48)
  })

  it('bounds every board, and zooms around a point that stays put', () => {
    expect(boundsOf([{ x: 0, y: 0, width: 10, height: 10 }, { x: 50, y: 20, width: 10, height: 30 }])).toEqual({ x: 0, y: 0, width: 60, height: 50 })
    const zoomed = zoomAround({ x: 0, y: 0, zoom: 1 }, 2, { x: 100, y: 100 })
    expect(zoomed).toEqual({ zoom: 2, x: -100, y: -100 })
    expect(zoomAround({ x: 0, y: 0, zoom: 2 }, 4, { x: 0, y: 0 }).zoom).toBe(2)
  })
})

describe('what each box says beyond its label', () => {
  const decision = { id: 'd', about: 'overview/b', question: 'Which?', context: 'Why it matters.', options: [{ id: 'x', label: 'X', explain: 'x' }, { id: 'y', label: 'Y', explain: 'y' }] }
  const planned = applyCall(plan(board('overview', ['a', 'b', 'c']), board('c', ['z'], 'overview/c')), 'ask_decision', decision).state
  const marked = applyCall(planned, 'set_progress', { doing: ['overview/a'] }).state

  it('says progress first, then an open decision, then a detail board', () => {
    expect(boxLines(marked, 'overview')).toEqual({ a: 'In progress…', b: 'Needs your decision', c: 'Opens a detail board ↗' })
    expect(decisionsOn(marked, 'overview').map((d) => d.id)).toEqual(['d'])
    expect(decisionsOn(marked, 'c')).toEqual([])
  })

  it('finds the boxes a passage names, whole words only', () => {
    const nodes = [{ id: 'q', label: 'Queue', shape: 'box' as const }, { id: 'r', label: 'Run', shape: 'box' as const }]
    expect(mentionedBoxes('The queue holds messages; nothing runs twice.', nodes)).toEqual(['q'])
  })

  it('walks each board, then its boxes, in reading order', () => {
    expect(tourSteps(planned).map((step) => `${step.board}/${step.box ?? ''}`)).toEqual(['overview/', 'overview/a', 'overview/b', 'overview/c', 'c/', 'c/z'])
  })

  it('gathers notes under the boxes they are about, by name', () => {
    const { title, brief } = notesMessage(planned, { 'overview/a': ['Why not reuse it?'], 'overview/b': [] })
    expect(title).toBe('My notes on the plan (1)')
    expect(brief).toContain('On “A” (overview/a):\n- Why not reuse it?')
  })

  it('lays out the trail in order, each choice with how it was built', () => {
    const linked = applyCall(planned, 'link_decision', { decision: 'd', how: 'Went with X.', ref: 'src/x.ts:1-4' }).state
    const asked = [{ id: 'e1', seq: 5, message: { kind: 'decision' as const, choices: [{ id: 'd', question: 'Which?', option: 'x', label: 'X', note: '' }] } }]
    const answered = { ...linked, decisions: { d: { ...linked.decisions.d!, answer: { option: 'x' } } } }
    const trail = trailOf({ ...EMPTY_VIEW, state: answered, asked }, [])
    expect(trail).toEqual([{ key: 'decision:d', kind: 'decision', question: 'Which?', answer: 'X', built: { how: 'Went with X.', ref: 'src/x.ts:1-4' }, seq: 5 }])
    expect(decisionMessage(asked[0]!.message.choices)).toContain('<canopy-decision id="d"')
  })
})

describe('approvalStep', () => {
  it("takes a session's first count as where it stands, not as an approval", () => {
    expect(approvalStep(undefined, 2)).toEqual({ acted: 2, approved: false })
  })

  it('counts an approval above the stored count once, wherever it landed', () => {
    expect(approvalStep(1, 2)).toEqual({ acted: 2, approved: true })
    expect(approvalStep(2, 2)).toEqual({ acted: 2, approved: false })
  })

  it('keeps the stored count when a shorter history is read', () => {
    expect(approvalStep(3, 0)).toEqual({ acted: 3, approved: false })
  })
})
