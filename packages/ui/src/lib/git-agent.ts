import type { AgentProvider, SessionRef } from '@canopy/shared'

/**
 * The Git Agent: conversations about a worktree's change, docked beside every Git pane. Each tab
 * is one conversation; this file is what the panel decides without React — which tabs there are
 * and the one state each is shown in.
 */

/** Where a worktree's Git Agent tabs are remembered, so a reload brings the same conversations back. */
export const gitAgentKey = (worktreeId: string): string => `canopy-git-agent:${worktreeId}`

export interface AgentTab {
  id: string
  provider: AgentProvider
  /** Set once the conversation exists; a tab without one is a session still being composed. */
  session?: SessionRef
}

export interface AgentTabs {
  tabs: AgentTab[]
  active?: string
}

export const NO_TABS: AgentTabs = { tabs: [] }

export const sameSession = (a: SessionRef | undefined, b: SessionRef | undefined): boolean => a !== undefined && a.provider === b?.provider && a.sessionId === b?.sessionId

export const openTab = (state: AgentTabs, tab: AgentTab): AgentTabs => ({ tabs: [...state.tabs, tab], active: tab.id })

export const activate = (state: AgentTabs, id: string): AgentTabs => (state.tabs.some((tab) => tab.id === id) ? { ...state, active: id } : state)

/** Closing the tab on screen hands the panel to its neighbour — the one after it, else the one before. */
export function closeTab(state: AgentTabs, id: string): AgentTabs {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (state.active !== id) return { ...state, tabs }
  return { tabs, active: (tabs[index] ?? tabs[index - 1])?.id }
}

export const bindSession = (state: AgentTabs, id: string, session: SessionRef): AgentTabs => ({
  ...state,
  tabs: state.tabs.map((tab) => (tab.id === id && !sameSession(tab.session, session) ? { ...tab, session } : tab))
})

/** What is worth keeping across a reload: tabs whose conversation exists. A half-composed one is not. */
export function persisted(state: AgentTabs): AgentTabs {
  const tabs = state.tabs.filter((tab) => tab.session)
  return { tabs, active: tabs.some((tab) => tab.id === state.active) ? state.active : tabs.at(-1)?.id }
}

// ---- status ----

export type AgentStatus = 'input' | 'running' | 'error' | 'done' | 'idle'

/**
 * One state per tab, most pressing first: waiting on the user beats working, and a finish nobody
 * has looked at yet stays visible until they do.
 */
export function agentStatus({ busy, asking, error, unseen }: { busy: boolean; asking: boolean; error: boolean; unseen: boolean }): AgentStatus {
  if (busy && asking) return 'input'
  if (busy) return 'running'
  if (error) return 'error'
  return unseen ? 'done' : 'idle'
}

const RANK: Record<AgentStatus, number> = { input: 4, running: 3, error: 2, done: 1, idle: 0 }

/** The state the panel's toggle shows for all its tabs at once: the most pressing one. */
export const mostPressing = (statuses: Iterable<AgentStatus>): AgentStatus => [...statuses].reduce<AgentStatus>((top, next) => (RANK[next] > RANK[top] ? next : top), 'idle')

/**
 * What every Git Agent turn is told on top of the provider's own prompt: where its answers are
 * read, how to cite code so it opens, and the change-map format the panel draws. A user who asks
 * for a diagram of the change gets the map inline, never a file.
 */
export const GIT_AGENT_INSTRUCTIONS = `You are the Git Agent in Canopy, docked beside the Git tab's diff view of this worktree. Your answers are read in a chat panel that renders Markdown, and file references in them open that code in the diff view.

- Answer in the chat. Do not write diagrams, reports or notes to files unless the user explicitly asks you to create a file.
- Cite code as \`path:line\` or \`path:start-end\`, relative to the repository root.
- Canopy draws diagrams from fenced blocks holding JSON (no comments). Pick the block that fits the question, keep each to about a dozen parts, and put explanation in prose outside the block. In every block, "status" is one of added, modified, deleted, affected (unchanged, but its behaviour changes) or external, and any part may carry "path" and "lines" (new-file line numbers, e.g. "84-95") so clicking it opens that code — give them for every changed part.
  - \`\`\`change-map — the structure of the change (or a state machine: states as nodes, transitions as labelled edges):
    {"title": "Refund flow", "caption": "optional single line", "nodes": [{"id": "service", "label": "RefundService", "path": "services/refund_service.py", "lines": "84-95", "status": "added", "badge": "3 hunks"}], "edges": [{"from": "route", "to": "service", "label": "issue()"}]}
  - \`\`\`call-flow — calls in order along one runtime path:
    {"title": "…", "participants": [{"id": "route", "label": "POST /refunds", "status": "modified"}], "steps": [{"from": "route", "to": "service", "label": "issue(amount)", "kind": "call", "status": "added", "branch": "amount > 0", "path": "…", "lines": "…"}]}
    "kind" is call, return or async; "status" is added, modified, deleted or unchanged; consecutive steps with the same "branch" are drawn as one conditional band.
  - \`\`\`blast-radius — what the change can reach:
    {"title": "…", "changed": [{"id": "svc", "label": "RefundService", "status": "added"}], "upstream": [callers], "downstream": [what it calls], "tests": [{"id": "t1", "label": "refund_test.py", "status": "modified", "covers": ["svc"]}], "links": [{"from": "route", "to": "svc", "label": "issue()"}]}
  - \`\`\`before-after — how a flow or structure worked before the change and works now:
    {"title": "…", "rows": [{"id": "queue", "before": {"label": "Dashboard owns the queue"}, "after": {"label": "Git tab owns the queue"}, "change": "moved", "note": "…"}], "flows": [{"side": "after", "from": "panes", "to": "dock", "label": "drag"}]}
    "change" is same, added (no "before"), removed (no "after"), changed or moved; rows read top to bottom.
  - \`\`\`data-model — tables, types or schemas and how they relate:
    {"title": "…", "entities": [{"id": "refund", "label": "Refund", "status": "added", "path": "…", "fields": [{"name": "id", "type": "uuid", "key": "primary"}, {"name": "status", "type": "string", "change": "added"}]}], "relations": [{"from": "refund", "to": "payment", "label": "refunds", "cardinality": "n..1"}]}
- Use mermaid only for a picture none of these blocks fits.`

// ---- diagram suggestions ----

/**
 * One standard review diagram, said once: what the picture is for, the form it takes, what keeps
 * it honest, and how to know it is finished. The set follows what change-scoped review tools have
 * converged on — the change's structure, its runtime path, its blast radius, before against after,
 * and the state and data it reshapes — each scoped to the change rather than the whole system.
 */
export interface DiagramSpec {
  id: string
  /** The suggestion's text, and what the transcript shows for the turn. */
  label: string
  /** One line under the label on what the picture shows. */
  hint: string
  goal: string
  format: string
  constraints: string[]
  done: string
}

export const DIAGRAM_SPECS: DiagramSpec[] = [
  {
    id: 'change-map',
    label: 'Map this change',
    hint: 'Every part it touches and how they connect',
    goal: 'Show the structure of the change: every component, route, table or module it touches, and how they connect.',
    format: 'a ```change-map block',
    constraints: ['Include the unchanged parts whose behaviour the change alters, marked affected.', 'Label each edge with the call, request or data that crosses it.'],
    done: 'A reviewer can click any changed node and land on its main hunk.'
  },
  {
    id: 'call-flow',
    label: 'Trace the call flow',
    hint: 'The main runtime path, call by call',
    goal: 'Show the main runtime path through the change, from its entry point to the deepest code it changes, as calls in order.',
    format: 'a ```call-flow block',
    constraints: ['Follow the primary path and its riskiest branch; leave the rest out.', 'One participant per class, service or module, with the status the change gives it.', 'Mark error and early-return paths with a "branch" naming the condition, and returns with "kind": "return".'],
    done: 'Every arrow is a call that exists in the code after the change.'
  },
  {
    id: 'blast-radius',
    label: 'Show the blast radius',
    hint: 'Callers, callees and tests it can reach',
    goal: 'Show what the change can reach: the changed parts in the middle, their callers upstream, what they call downstream, and the tests that cover them.',
    format: 'a ```blast-radius block',
    constraints: ['Only draw a link you can point to in the code; search for callers rather than guessing.', 'Mark callers and callees that did not change as affected, and third-party systems as external.', 'List the tests that exercise the changed parts under "tests", with what each covers; name in prose anything changed that no test covers.'],
    done: 'Every edge is backed by a reference the reviewer can open.'
  },
  {
    id: 'before-after',
    label: 'Compare before and after',
    hint: 'How it worked before, and how it works now',
    goal: 'Show how the behaviour or architecture the change touches worked before it and how it works now.',
    format: 'a ```before-after block',
    constraints: ['One row per part, in the order the flow runs, so the same part sits on the same row on both sides.', 'Mark each row same, added, removed, changed or moved, with a short note on what changed.', 'Read the old version from git (the merge base or HEAD), not from memory.'],
    done: 'The difference between the two subgraphs is the change, and nothing else.'
  },
  {
    id: 'state',
    label: 'Draw the state changes',
    hint: 'States and transitions it adds or alters',
    goal: 'Show the states and transitions the change adds, removes or alters, in whatever lifecycle, status field or state machine it touches.',
    format: 'a ```change-map block, with the states as nodes and the transitions as edges',
    constraints: ['Label each transition edge with the event or call that triggers it.', 'Give states the change adds the status added, removed ones deleted, and ones whose transitions change modified.', 'If the change touches no state, say so in one sentence instead of drawing.'],
    done: 'Every transition names the code that performs it.'
  },
  {
    id: 'data-model',
    label: 'Show the data model',
    hint: 'Tables, types and fields it changes',
    goal: 'Show the tables, types or schemas the change creates or alters, with their fields and relationships.',
    format: 'a ```data-model block',
    constraints: ['Include only entities the change touches and their direct relations.', 'Mark each new, changed or removed field with its "change".', 'If the change alters no data shape, say so in one sentence instead of drawing.'],
    done: 'Each changed field in the diagram matches a line in the diff.'
  }
]

/** Claude reads a request best as plain prose with its reasons. */
const forClaude = ({ goal, format, constraints, done }: DiagramSpec): string =>
  [`${goal} Reply with ${format}, then explain what it shows in a few sentences.`, ...constraints, `Before you answer, check: ${done}`].join(' ')

/** GPT models in Codex are tuned for outcome-first prompts: goal, context, constraints, done-when. */
const forCodex = ({ goal, format, constraints, done }: DiagramSpec): string =>
  [
    `Goal: ${goal}`,
    'Context: the uncommitted change in this worktree (git diff HEAD, plus untracked files).',
    `Output: ${format} in your chat reply, followed by a short explanation. Do not write files.`,
    `Constraints:\n${constraints.map((line) => `- ${line}`).join('\n')}`,
    `Done when: ${done}`
  ].join('\n\n')

const PROMPT_FOR: Record<AgentProvider, (spec: DiagramSpec) => string> = { claude: forClaude, codex: forCodex }

/** The prompt one diagram suggestion sends, in the shape the tab's provider follows best. */
export const diagramPrompt = (spec: DiagramSpec, provider: AgentProvider): string => PROMPT_FOR[provider](spec)
