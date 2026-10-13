import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk'
import { applyCall, EMPTY_PLAN, planReply, planToolOf, type WhiteboardMode, PLAN_SERVER, PLAN_TOOL_DESCRIPTIONS, PLAN_TOOL_NAMES, planToolSchema, qualifiedPlanTool, refProblems, type PlanState, type PlanTool } from '@canopy/shared'

import type { SdkModule } from './claude'

/**
 * The whiteboard's tools, served to a Claude turn from inside the daemon. Each call runs the same
 * `applyCall` the client replays the transcript with, so what the agent is told and what the
 * reader sees cannot drift apart. A refused call answers with its problems as a tool error, and
 * the agent redraws in the same turn.
 */

export interface WhiteboardDeps {
  /** The plan as the session left it — folded from its transcript — so a resumed turn edits the same boards. */
  initial?: PlanState
  /** Whether a path a note cites is in the checkout. */
  exists?: (path: string) => boolean
}

/** A file check rooted at the checkout, refusing paths that climb out of it. */
export const checkoutFiles =
  (cwd: string) =>
  (path: string): boolean => {
    const full = isAbsolute(path) ? path : join(cwd, path)
    return !relative(cwd, full).startsWith('..') && existsSync(full)
  }

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const reply = (text: string, isError = false): ToolReply => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) })

/** The notes a call cites code in — a draw's and an edit's alike. */
const citedNotes = (input: unknown): Parameters<typeof refProblems>[0] => (input as { notes?: Parameters<typeof refProblems>[0] } | null)?.notes

/** One tool's handler over the turn's running plan. Exported for tests, which hold no SDK. */
export function whiteboardHandler(name: PlanTool, plan: { state: PlanState }, exists: (path: string) => boolean) {
  return async (input: unknown): Promise<ToolReply> => {
    const applied = applyCall(plan.state, name, input)
    if (applied.problems.length > 0) return reply(`Not applied. Fix exactly these and call again:\n- ${applied.problems.join('\n- ')}`, true)
    plan.state = applied.state
    // A citation of a missing file is a gap to patch like a missing note; the board still stands.
    return reply(planReply(applied, refProblems(citedNotes(input), exists)))
  }
}

/** The in-process MCP server a whiteboard turn is handed, and the tool names to allow without asking. */
export function whiteboardServer(sdk: Pick<SdkModule, 'createSdkMcpServer' | 'tool'>, deps: WhiteboardDeps & { cwd: string }): { server: McpSdkServerConfigWithInstance; allowed: string[] } {
  const plan = { state: deps.initial ?? EMPTY_PLAN }
  const exists = deps.exists ?? checkoutFiles(deps.cwd)
  // Read-only as far as the codebase goes — they draw, they never write — which is what lets plan
  // mode run them; plan mode asks about any other tool whatever the allow list says.
  const tools = PLAN_TOOL_NAMES.map((name) =>
    sdk.tool(name, PLAN_TOOL_DESCRIPTIONS[name], planToolSchema(name).shape, whiteboardHandler(name, plan, exists) as never, { annotations: { readOnlyHint: true } })
  )
  return { server: sdk.createSdkMcpServer({ name: PLAN_SERVER, version: '1.0.0', tools }), allowed: [...PLAN_TOOL_NAMES.map(qualifiedPlanTool), ...READ_COMMANDS] }
}

const READING = ['Read', 'Grep', 'Glob', 'Bash', 'AskUserQuestion']
const EDITING = ['Edit', 'Write', 'NotebookEdit', 'TodoWrite']

/** Shell reads a whiteboard turn runs without asking: looking around and at git history. */
export const READ_COMMANDS = ['Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)', 'Bash(git ls-files:*)', 'Bash(ls:*)', 'Bash(wc:*)']

/**
 * How each whiteboard mode runs. Plan mode is Claude's own: read-only until `ExitPlanMode` is
 * approved, after which the same turn may build. Explain never ends in approval, so it runs in
 * plan mode too — the one mode in which Claude Code itself refuses writes, including shell
 * commands that write, whatever the user's own allow rules say — but without `ExitPlanMode`, so
 * there is nothing to approve. Both get a short list of built-in tools: with the whole set,
 * the agent hands its reading to subagents and background tasks and ends the turn before drawing.
 * `focused` also keeps every other MCP server out — the user's own and their claude.ai connectors —
 * since a tool named for documents or boards draws the agent away from the whiteboard's.
 * Build keeps whatever the user's autonomy and setup allow.
 */
export const WHITEBOARD_MODES: Record<WhiteboardMode, { permissionMode?: 'plan'; tools?: string[]; focused?: boolean }> = {
  explain: { permissionMode: 'plan', tools: READING, focused: true },
  plan: { permissionMode: 'plan', tools: [...READING, 'ExitPlanMode', ...EDITING], focused: true },
  build: {}
}

/** The SDK options a whiteboard turn adds to an ordinary one. */
export function whiteboardOptions(mode: WhiteboardMode, board: ReturnType<typeof whiteboardServer>): Pick<Options, 'mcpServers' | 'allowedTools' | 'tools' | 'strictMcpConfig' | 'env'> {
  const { tools, focused } = WHITEBOARD_MODES[mode]
  return {
    mcpServers: { [PLAN_SERVER]: board.server },
    allowedTools: board.allowed,
    ...(tools ? { tools } : {}),
    ...(focused ? { strictMcpConfig: true } : {}),
    // Deferred MCP tools would have the agent search for its own drawing tools before every call.
    env: { ...process.env, ENABLE_TOOL_SEARCH: 'false', ...(focused ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {}) }
  }
}

/** Whether a tool is one of the whiteboard's own, which never needs the user's say-so. */
export const isWhiteboardTool = (toolName: string): boolean => planToolOf(toolName) !== undefined
