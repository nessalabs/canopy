import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { AgentEvent } from '../src/agent-stream'
import {
  answersIn,
  applyCall,
  boardDrawing,
  decisionMessage,
  parseWhiteboardMessage,
  PLAN_TOOL_NAMES,
  planToolSchema,
  quoteMessage,
  boxMessage,
  currentVersion,
  draftPlan,
  EMPTY_PLAN,
  foldPlan,
  parseLines,
  parseMermaid,
  planReply,
  qualifiedPlanTool,
  type DrawBoardInput,
  type PlanState
} from '../src/plan'

const note = (explain = 'A part of the system.') => ({ explain })

describe('parseMermaid', () => {
  it('reads a flowchart: shapes, labels, chained and labelled arrows, & groups, and skips styling', () => {
    const { graph, problems } = parseMermaid(`flowchart TD
      a[Composer] -->|sends| b(Daemon) --> c[(Database)]
      b -- streams --> a
      b -.-> d{Ready?}
      a & d --> e((Done))
      classDef hot fill:#f00
      style a fill:#fff
      click a "src/a.ts"
      subgraph Back
      end`)
    expect(problems).toEqual([])
    expect(graph.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ['a', 'Composer', 'box'],
      ['b', 'Daemon', 'round'],
      ['c', 'Database', 'store'],
      ['d', 'Ready?', 'decision'],
      ['e', 'Done', 'circle']
    ])
    expect(graph.edges).toEqual([
      { from: 'a', to: 'b', label: 'sends', style: 'solid' },
      { from: 'b', to: 'c', style: 'solid' },
      { from: 'b', to: 'a', label: 'streams', style: 'solid' },
      { from: 'b', to: 'd', style: 'dashed' },
      { from: 'a', to: 'e', style: 'solid' },
      { from: 'd', to: 'e', style: 'solid' }
    ])
  })

  it('reads a sequence with branches nested in frames', () => {
    const { graph, problems } = parseMermaid(`sequenceDiagram
      participant ui as Agent tab
      actor you
      ui->>hub: start(turn)
      alt turn running
        hub-->>ui: 409
      else idle
        hub-)ui: stream
      end
      Note over ui: done`)
    expect(problems).toEqual([])
    expect(graph.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ['ui', 'Agent tab', 'participant'],
      ['you', 'you', 'actor'],
      ['hub', 'hub', 'participant']
    ])
    expect(graph.edges).toEqual([
      { from: 'ui', to: 'hub', label: 'start(turn)', style: 'call' },
      { from: 'hub', to: 'ui', label: '409', style: 'return', branch: 'turn running' },
      { from: 'hub', to: 'ui', label: 'stream', style: 'async', branch: 'idle' }
    ])
  })

  it('reads a state diagram with start, end, aliases and guards', () => {
    const { graph, problems } = parseMermaid(`stateDiagram-v2
      state "Waiting" as idle
      [*] --> idle
      idle --> running : send [no turn running]
      running --> [*]
      note right of running
        a note
      end note`)
    expect(problems).toEqual([])
    expect(graph.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ['idle', 'Waiting', 'box'],
      ['__start', 'Start', 'initial'],
      ['running', 'running', 'box'],
      ['__end', 'End', 'final']
    ])
    expect(graph.edges[1]).toEqual({ from: 'idle', to: 'running', label: 'send', guard: 'no turn running', style: 'solid' })
  })

  it('reads an ER diagram with attributes and cardinalities', () => {
    const { graph, problems } = parseMermaid(`erDiagram
      PLAN ||--o{ BOARD : "has"
      BOARD {
        string id PK
        string plan_id FK "owner"
      }`)
    expect(problems).toEqual([])
    expect(graph.edges).toEqual([{ from: 'PLAN', to: 'BOARD', label: 'has', cardinality: '1:0..N', style: 'solid' }])
    expect(graph.nodes.find((n) => n.id === 'BOARD')!.fields).toEqual([
      { name: 'id', type: 'string', key: 'primary' },
      { name: 'plan_id', type: 'string', key: 'foreign', note: 'owner' }
    ])
  })

  it('reads a class diagram, pointing inheritance at the parent', () => {
    const { graph, problems } = parseMermaid(`classDiagram
      class Adapter {
        <<interface>>
        +send(text) Stream
        +provider string
      }
      Adapter <|-- ClaudeAdapter
      ClaudeAdapter : +live Map`)
    expect(problems).toEqual([])
    expect(graph.nodes.find((n) => n.id === 'Adapter')!.fields).toEqual([
      { name: 'send(text)', type: 'Stream' },
      { name: 'provider', type: 'string' }
    ])
    expect(graph.edges).toEqual([{ from: 'ClaudeAdapter', to: 'Adapter', label: 'extends', style: 'solid' }])
    expect(graph.nodes.find((n) => n.id === 'ClaudeAdapter')!.fields).toEqual([{ name: 'live', type: 'Map' }])
  })

  it('keeps boxes named like Mermaid keywords, and an & inside a label', () => {
    const { graph, problems } = parseMermaid('flowchart TD\n title[Title] --> style[Style]\n direction[Dir] --> a[Read & write]')
    expect(problems).toEqual([])
    expect(graph.nodes.map((n) => [n.id, n.label])).toEqual([['title', 'Title'], ['style', 'Style'], ['direction', 'Dir'], ['a', 'Read & write']])
    expect(graph.edges).toHaveLength(2)
  })

  it('names the line it cannot read, numbered as written, and needs a header', () => {
    expect(parseMermaid('flowchart LR\n  a --> b\n  a ~> b').problems).toEqual(['line 3: "a ~> b" — not a node or arrow; write `a[Label]`, `a --> b` or `a -->|label| b`'])
    expect(parseMermaid('```mermaid\nflowchart LR\na --> b\n```').problems).toEqual([])
    expect(parseMermaid('a --> b').problems[0]).toMatch(/first line must name the diagram/)
  })
})

const overview: DrawBoardInput = {
  id: 'overview',
  title: 'How a message reaches the agent',
  story: 'The composer sends your message to the daemon, which runs the agent.',
  mermaid: 'flowchart LR\n  ui[Composer] -->|sends| d[Daemon]\n  d --> a[Agent]',
  notes: { ui: { ...note(), status: 'changed', ref: 'packages/ui/src/composer.tsx:10-40' }, d: note(), a: note() }
}

const drawn = (): PlanState => applyCall(EMPTY_PLAN, 'draw_board', overview).state

describe('applyCall', () => {
  it('draws a board and tells the agent briefly', () => {
    const { state, problems, summary } = applyCall(EMPTY_PLAN, 'draw_board', overview)
    expect(problems).toEqual([])
    expect(summary).toBe('Drawn: board "overview" v1, 3 boxes.')
    expect(state.order).toEqual(['overview'])
    expect(state.drawings).toBe(1)
  })

  it('refuses a board too big to read', () => {
    const many = Array.from({ length: 10 }, (_, i) => `  n${i}[Box ${i}]`).join('\n')
    const notes = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}`, note()]))
    const { state, problems } = applyCall(EMPTY_PLAN, 'draw_board', { ...overview, mermaid: `flowchart TD\n${many}`, notes })
    expect(state).toBe(EMPTY_PLAN)
    expect(problems).toEqual(['10 boxes; at most 9 — group some into one box and draw its inside as a detail board'])
  })

  it('accepts a board with gaps in its notes, and asks for just those as a patch', () => {
    const applied = applyCall(EMPTY_PLAN, 'draw_board', { ...overview, notes: { ui: { explain: 'x', ref: 'a b.ts' }, d: note(), ghost: note() } })
    const { state, problems, followUps } = applied
    const summary = planReply(applied)
    expect(problems).toEqual([])
    expect(state.order).toEqual(['overview'])
    expect(followUps).toEqual(['box "a" has no note; every box needs one that explains it in plain words', 'note "ghost" names no box on the board', 'note "ui": ref "a b.ts" should be path or path:start-end'])
    expect(summary).toMatch(/^Drawn: board "overview" v1, 3 boxes\. Patch with edit_board \(send only these\):\n- box "a"/)
  })

  it('refuses malformed input with the field that is wrong', () => {
    expect(applyCall(EMPTY_PLAN, 'draw_board', { ...overview, story: undefined }).problems).toEqual(['story: Invalid input: expected string, received undefined'])
  })

  it('places a detail board under a box that exists', () => {
    const detail = { ...overview, id: 'daemon', parent: 'overview/d', mermaid: 'flowchart TD\n  h[Turn runner]', notes: { h: note() } }
    expect(applyCall(drawn(), 'draw_board', detail).state.boards.daemon!.parent).toEqual({ board: 'overview', box: 'd' })
    expect(applyCall(drawn(), 'draw_board', { ...detail, parent: 'overview/zzz' }).problems).toEqual(['board "overview" has no box "zzz"'])
  })

  it('refuses a parent that would put a board inside its own detail boards', () => {
    const a = { ...overview, id: 'a', parent: 'overview/d', mermaid: 'flowchart TD\n  y[Y]', notes: { y: note() } }
    const b = { ...overview, id: 'b', parent: 'a/y', mermaid: 'flowchart TD\n  z[Z]', notes: { z: note() } }
    const nested = applyCall(applyCall(drawn(), 'draw_board', a).state, 'draw_board', b).state
    expect(applyCall(nested, 'draw_board', { ...a, parent: 'b/z' }).problems).toEqual(['a board cannot be inside itself: "b" is inside "a"'])
    expect(applyCall(nested, 'draw_board', { ...a, parent: 'a/y' }).problems).toEqual(['a board cannot be inside itself: "a" is inside "a"'])
  })

  it('edits only what the lines name, keeps the old version and outlines what changed', () => {
    const { state, problems, summary } = applyCall(drawn(), 'edit_board', {
      id: 'overview',
      mermaid: 'd[Canopy daemon] -->|resumes| a\n  a --> q[Queue]',
      remove: ['ui->d'],
      notes: { q: note('Holds messages sent while the agent is busy.') }
    })
    expect(problems).toEqual([])
    const board = state.boards.overview!
    expect(board.versions).toHaveLength(2)
    const now = currentVersion(board)
    expect(now.graph.nodes.map((n) => [n.id, n.label])).toEqual([
      ['ui', 'Composer'],
      ['d', 'Canopy daemon'],
      ['a', 'Agent'],
      ['q', 'Queue']
    ])
    expect(now.graph.edges).toEqual([
      { from: 'd', to: 'a', label: 'resumes', style: 'solid' },
      { from: 'a', to: 'q', style: 'solid' }
    ])
    expect(now.changed).toEqual(['d', 'q'])
    expect(summary).toBe('Edited: board "overview" v2, changed d, q.')
  })

  it('reads an edit that repeats the header or a fence, as the agent often sends it', () => {
    for (const mermaid of ['flowchart LR\n d[Canopy daemon]', '```mermaid\nflowchart TD\nd[Canopy daemon]\n```']) {
      const { problems, state } = applyCall(drawn(), 'edit_board', { id: 'overview', mermaid })
      expect(problems).toEqual([])
      expect(currentVersion(state.boards.overview!).graph.nodes.find((n) => n.id === 'd')?.label).toBe('Canopy daemon')
    }
  })

  it('refuses a board with nothing on it', () => {
    expect(applyCall(EMPTY_PLAN, 'draw_board', { id: 'o', title: 'Empty', story: 'Nothing.', mermaid: 'flowchart TD', notes: {} }).problems).toEqual(['no boxes; draw at least one'])
    expect(applyCall(EMPTY_PLAN, 'draw_board', { id: 'o', title: 'Empty', story: 'Nothing.', mermaid: 'sequenceDiagram\n participant a as A', notes: {} }).problems).toEqual(['no messages; a sequence needs at least one `a ->> b: text`'])
  })

  it('removes a box with its arrows and note, and refuses removing what is not there', () => {
    const removed = applyCall(drawn(), 'edit_board', { id: 'overview', remove: ['a'] })
    expect(removed.problems).toEqual([])
    const now = currentVersion(removed.state.boards.overview!)
    expect(now.graph.edges).toEqual([{ from: 'ui', to: 'd', label: 'sends', style: 'solid' }])
    expect(now.notes.a).toBeUndefined()
    expect(applyCall(drawn(), 'edit_board', { id: 'overview', remove: ['nope'] }).problems).toEqual(['remove: "nope" is not a box or arrow on the board'])
  })

  it('replaces all of a sequence’s messages when an edit sends any', () => {
    const seq = applyCall(EMPTY_PLAN, 'draw_board', { ...overview, mermaid: 'sequenceDiagram\n a->>b: one\n b-->>a: two', notes: { a: note(), b: note() } }).state
    const edited = applyCall(seq, 'edit_board', { id: 'overview', mermaid: 'a->>b: only' }).state
    expect(currentVersion(edited.boards.overview!).graph.edges).toEqual([{ from: 'a', to: 'b', label: 'only', style: 'call' }])
  })

  it('adds a member line to a class instead of replacing its other members', () => {
    const base = applyCall(EMPTY_PLAN, 'draw_board', { id: 'types', title: 'Types', story: 'The types.', mermaid: 'classDiagram\n class A {\n +x int\n +y int\n }', notes: { A: note() } }).state
    const { problems, state } = applyCall(base, 'edit_board', { id: 'types', mermaid: 'A : +z int' })
    expect(problems).toEqual([])
    expect(currentVersion(state.boards.types!).graph.nodes[0]!.fields!.map((f) => f.name)).toEqual(['x', 'y', 'z'])
  })

  it('warns when a redraw or edit takes away the box a detail board hangs from, and lets a redraw move the board', () => {
    const withDetail = applyCall(drawn(), 'draw_board', { id: 'daemon', parent: 'overview/d', title: 'Daemon', story: 'Inside.', mermaid: 'flowchart TD\n t[Turn]', notes: { t: note() } }).state
    const edited = applyCall(withDetail, 'edit_board', { id: 'overview', remove: ['d'] })
    expect(edited.problems).toEqual([])
    expect(edited.followUps).toEqual(['box "d" opened detail board "daemon"; keep the box, or redraw "daemon" with another parent'])
    const moved = applyCall(edited.state, 'draw_board', { id: 'daemon', parent: 'overview/a', title: 'Daemon', story: 'Inside.', mermaid: 'flowchart TD\n t[Turn]', notes: { t: note() } })
    expect(moved.problems).toEqual([])
    expect(moved.state.boards.daemon!.parent).toEqual({ board: 'overview', box: 'a' })
  })

  it('marks progress on boxes that exist', () => {
    expect(applyCall(drawn(), 'set_progress', { doing: ['overview/d'], done: ['overview/ui'] }).state.progress).toEqual({ 'overview/d': 'doing', 'overview/ui': 'done' })
    expect(applyCall(drawn(), 'set_progress', { done: ['overview/x'] }).problems).toEqual(['"overview/x" is not a box; write "board/box"'])
  })
})

const event = (seq: number, payload: AgentEvent['payload'], agentPath: string[] = []): AgentEvent => ({ id: `e${seq}`, sessionId: 's', seq, ts: null, agentPath, payload, raw: null })
const result = (isError: boolean) => ({ text: '', isError, structured: null, images: [] })

describe('draftPlan', () => {
  it('is empty until a board is drawn', () => {
    expect(draftPlan(EMPTY_PLAN)).toBe('')
  })

  it('reads every board story in the order drawn', () => {
    const { state } = applyCall(EMPTY_PLAN, 'draw_board', overview)
    const board = currentVersion(state.boards.overview!)
    expect(draftPlan(state)).toBe(`# Draft plan\n\n_The agent has not written the plan yet — this is what its boards say so far._\n\n## ${board.title}\n\n${board.story}`)
  })
})

describe('foldPlan', () => {
  it('replays accepted plan calls in the order they finished, skipping refused ones and subagents', () => {
    const draw = qualifiedPlanTool('draw_board')
    const events = [
      event(0, { type: 'tool_call_started', callId: 'c1', name: draw, kind: 'other', input: { ...overview, id: 'bad', notes: {} }, title: '' }),
      event(1, { type: 'tool_call_completed', callId: 'c1', result: result(true) }),
      event(2, { type: 'tool_call_started', callId: 'c2', name: draw, kind: 'other', input: overview as never, title: '' }),
      event(3, { type: 'tool_call_completed', callId: 'c2', result: result(false) }),
      event(4, { type: 'tool_call_started', callId: 'c3', name: draw, kind: 'other', input: { ...overview, id: 'sub' } as never, title: '' }, ['task']),
      event(5, { type: 'tool_call_completed', callId: 'c3', result: result(false) }, ['task']),
      event(6, { type: 'user_message', text: boxMessage({ board: 'overview', box: 'd' }, 'Daemon', 'Why here?'), synthetic: false }),
      event(7, { type: 'tool_call_started', callId: 'c4', name: qualifiedPlanTool('edit_board'), kind: 'other', input: { id: 'overview' }, title: '' })
    ]
    const view = foldPlan(events)
    expect(view.state.order).toEqual(['overview'])
    expect(view.threads).toEqual({ 'overview/d': ['e6'] })
    expect(view.drawing).toBe(true)
    expect(view.approvals).toBe(0)
  })

  it('knows the plan was approved once ExitPlanMode went through', () => {
    const exit = (callId: string, isError: boolean, seq: number) => [
      event(seq, { type: 'tool_call_started', callId, name: 'ExitPlanMode', kind: 'other', input: {}, title: '' }),
      event(seq + 1, { type: 'tool_call_completed', callId, result: result(isError) })
    ]
    expect(foldPlan(exit('x1', true, 0)).approvals).toBe(0)
    expect(foldPlan([...exit('x1', true, 0), ...exit('x2', false, 2)]).approvals).toBe(1)
    expect(foldPlan([...exit('x1', false, 0), ...exit('x2', false, 2)]).approvals).toBe(2)
  })
})

describe('boardDrawing', () => {
  it('draws a flowchart as a map of parts, with status and code location from the notes', () => {
    const drawing = boardDrawing(currentVersion(drawn().boards.overview!))
    expect(drawing.type).toBe('change-map')
    expect(drawing.type === 'change-map' && drawing.spec.nodes[0]).toEqual({ id: 'ui', label: 'Composer', status: 'modified', path: 'packages/ui/src/composer.tsx', lines: '10-40' })
  })

  it('draws a flowchart with decisions as an activity, start and end told apart by their arrows', () => {
    const { graph } = parseMermaid('flowchart TD\n s((Start)) --> q{Busy?}\n q -->|yes| w[Wait]\n q -->|no| e((End))')
    const drawing = boardDrawing({ graph, notes: {} })
    expect(drawing.type === 'activity' && drawing.spec.steps.map((step) => step.kind)).toEqual(['start', 'decision', 'action', 'end'])
    const loop = parseMermaid('flowchart TD\n s((Start)) --> a[Do] --> d{Ok?}\n d -->|no| s\n d -->|yes| e((End))').graph
    const again = boardDrawing({ graph: loop, notes: {} })
    expect(again.type === 'activity' && again.spec.steps.map((step) => step.kind)).toEqual(['start', 'action', 'decision', 'end'])
  })

  it('draws a state diagram with its start and end as states', () => {
    const { graph } = parseMermaid('stateDiagram-v2\n [*] --> a\n a --> [*]')
    const drawing = boardDrawing({ graph, notes: {} })
    expect(drawing.type === 'state-machine' && drawing.spec.states.map((state) => state.kind)).toEqual(['initial', 'normal', 'final'])
  })

  it('reads a fragment without its header', () => {
    expect(parseLines('flowchart', 'a --> b').graph.edges).toEqual([{ from: 'a', to: 'b', style: 'solid' }])
  })
})

describe('plan tool schemas', () => {
  it('stay JSON schemas Claude Code lists: no records (propertyNames) and no top-level defaults', () => {
    for (const name of PLAN_TOOL_NAMES) {
      const json = JSON.stringify(z.toJSONSchema(planToolSchema(name)))
      expect(json, name).not.toContain('propertyNames')
      expect(
        Object.values(planToolSchema(name).shape).some((field) => field instanceof z.ZodDefault),
        name
      ).toBe(false)
    }
  })
})

describe('today and after', () => {
  const change = { ...overview, before: 'flowchart LR\n  ui[Composer] --> d[Daemon]\n  d --> old[Old queue]', notes: { ...overview.notes, old: { explain: 'Goes away.', status: 'removed' as const } } }

  it('keeps a picture of today beside the board, drawn on request, and asks a note for boxes only today has', () => {
    const version = currentVersion(applyCall(EMPTY_PLAN, 'draw_board', change).state.boards.overview!)
    expect(version.before?.nodes.map((n) => n.id)).toEqual(['ui', 'd', 'old'])
    const today = boardDrawing(version, true)
    expect(today.type === 'change-map' && today.spec.nodes.find((n) => n.id === 'old')?.status).toBe('deleted')
    expect(today.type === 'change-map' && today.spec.nodes.find((n) => n.id === 'ui')?.status).toBe('external')
    expect(applyCall(EMPTY_PLAN, 'draw_board', { ...change, notes: overview.notes }).followUps).toContain('box "old" has no note; every box needs one that explains it in plain words')
  })

  it('keeps the note of a box an edit takes away while today\'s picture still shows it', () => {
    const both = { ...change, mermaid: `${overview.mermaid}\n  d --> old[Old queue]` }
    const edited = applyCall(applyCall(EMPTY_PLAN, 'draw_board', both).state, 'edit_board', { id: 'overview', remove: ['old'] })
    expect(edited.problems).toEqual([])
    expect(edited.followUps).toEqual([])
    const now = currentVersion(edited.state.boards.overview!)
    expect(now.graph.nodes.some((n) => n.id === 'old')).toBe(false)
    expect(now.notes.old).toEqual({ explain: 'Goes away.', status: 'removed' })
  })

  it('wants today drawn as the same kind of diagram, and keeps it across edits', () => {
    expect(applyCall(EMPTY_PLAN, 'draw_board', { ...change, before: 'sequenceDiagram\n a->>b: x' }).problems).toContain("before: draw today's picture as the same kind of diagram as the board (flowchart)")
    const drawn = applyCall(EMPTY_PLAN, 'draw_board', change).state
    expect(currentVersion(applyCall(drawn, 'edit_board', { id: 'overview', mermaid: 'a[Agent v2]' }).state.boards.overview!).before?.nodes).toHaveLength(3)
  })
})

describe('decisions', () => {
  const decision = {
    id: 'storage',
    about: 'overview/d',
    question: 'Where should uploads live?',
    context: 'Today every upload is read into the agent.',
    options: [
      { id: 's3', label: 'Copy to S3', explain: 'Nothing passes through the agent.', mermaid: 'flowchart LR\n a[Upload] --> b[S3]', recommended: true },
      { id: 'read', label: 'Keep reading', explain: 'Simple, but fills the agent.' }
    ]
  }

  it('posts a decision beside its box once a board exists, and tells the agent to stop', () => {
    expect(applyCall(EMPTY_PLAN, 'ask_decision', decision).problems).toEqual(['draw the overview board first: the reader decides with the picture in front of them', 'about "overview/d" is not a box; write "board/box"'])
    const { state, summary } = applyCall(drawn(), 'ask_decision', decision)
    expect(Object.keys(state.decisions)).toEqual(['storage'])
    expect(summary).toMatch(/End your turn now/)
  })

  it('refuses two recommendations or a picture it cannot read', () => {
    const both = { ...decision, options: decision.options.map((o) => ({ ...o, recommended: true })) }
    expect(applyCall(drawn(), 'ask_decision', both).problems).toEqual(['recommend one option at most'])
    const bad = { ...decision, options: [{ ...decision.options[0]!, mermaid: 'not a diagram' }, decision.options[1]!] }
    expect(applyCall(drawn(), 'ask_decision', bad).problems[0]).toMatch(/^option "s3" picture: /)
  })

  it('settles a decision from the reader’s answer in the transcript', () => {
    const ask = qualifiedPlanTool('ask_decision')
    const events = [
      event(0, { type: 'tool_call_started', callId: 'c1', name: qualifiedPlanTool('draw_board'), kind: 'other', input: overview as never, title: '' }),
      event(1, { type: 'tool_call_completed', callId: 'c1', result: result(false) }),
      event(2, { type: 'tool_call_started', callId: 'c2', name: ask, kind: 'other', input: decision as never, title: '' }),
      event(3, { type: 'tool_call_completed', callId: 'c2', result: result(false) }),
      event(4, {
        type: 'user_message',
        text: decisionMessage([
          { id: 'storage', question: 'Where should uploads live?', option: 's3', label: 'Copy to S3', note: 'but keep a size cap' },
          { id: 'ghost', question: 'Gone?', option: 'x', label: 'X', note: '' }
        ]),
        synthetic: false
      })
    ]
    const view = foldPlan(events)
    expect(view.state.decisions.storage?.answer).toEqual({ option: 's3', note: 'but keep a size cap' })
    expect(view.asked.map((a) => a.message.kind)).toEqual(['decision'])
  })
})

describe('whiteboard messages', () => {
  it('reads each kind back from the text the agent receives', () => {
    expect(parseWhiteboardMessage(quoteMessage('overview', 'reason about the wording', 'What is this?'))).toEqual({ kind: 'quote', ref: 'overview', quote: 'reason about the wording', text: 'What is this?' })
    expect(parseWhiteboardMessage(boxMessage({ board: 'b', box: 'x' }, 'X "one"', 'Why?'))).toEqual({ kind: 'box', ref: 'b/x', label: 'X ”one”', text: 'Why?' })
    expect(parseWhiteboardMessage('just typed')).toBeUndefined()
  })

  it('keeps the plan document the agent asked approval with', () => {
    const events = [event(0, { type: 'tool_call_started', callId: 'x', name: 'ExitPlanMode', kind: 'other', input: { plan: '# The plan' }, title: '' })]
    expect(foldPlan(events).document).toBe('# The plan')
  })
})

describe('the decision trail', () => {
  it('reads the answers Claude Code reports for questions it asked', () => {
    const text = 'Your questions have been answered: "Bad code?"="Ignore it (Recommended)", "Say \\"hi\\"?"="Yes". You can now continue.'
    expect(answersIn(text)).toEqual({ 'Bad code?': 'Ignore it (Recommended)', 'Say "hi"?': 'Yes' })
  })

  it('keeps the agent’s chat questions with their answers, and how each decision was built', () => {
    const events = [
      event(0, { type: 'tool_call_started', callId: 'q', name: 'AskUserQuestion', kind: 'other', input: { questions: [{ question: 'Bad code?', header: 'Bad code' }] }, title: '' }),
      event(1, { type: 'tool_call_completed', callId: 'q', result: { ...result(false), text: 'Your questions have been answered: "Bad code?"="Ignore it". Continue.' } }),
      event(2, {
        type: 'tool_call_started',
        callId: 'l',
        name: qualifiedPlanTool('link_decision'),
        kind: 'other',
        input: { decision: 'Bad code?', how: 'Unknown codes are skipped.', ref: 'src/discounts.ts:4-9' },
        title: ''
      }),
      event(3, { type: 'tool_call_completed', callId: 'l', result: result(false) })
    ]
    const view = foldPlan(events)
    expect(view.questions).toEqual([{ callId: 'q', seq: 0, questions: [{ question: 'Bad code?', header: 'Bad code' }], answers: { 'Bad code?': 'Ignore it' } }])
    expect(view.state.links).toEqual({ 'Bad code?': { how: 'Unknown codes are skipped.', ref: 'src/discounts.ts:4-9' } })
    expect(applyCall(EMPTY_PLAN, 'link_decision', { decision: 'x', how: 'y', ref: 'a b' }).problems).toEqual(['ref "a b" should be path or path:start-end'])
  })
})
