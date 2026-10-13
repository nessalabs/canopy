import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ZodRawShape } from 'zod'

import type { SdkModule } from './claude'

/**
 * Tools a surface serves its Claude turns from inside the daemon — the whiteboard's, the Canopy
 * Agent's — and how a turn mounts them. A surface describes its tools without the SDK; the
 * adapter, which loads the SDK, mounts them.
 */

export type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export const reply = (text: string, isError = false): ToolReply => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) })

export interface ToolkitTool {
  name: string
  description: string
  shape: ZodRawShape
  handler: (input: unknown) => Promise<ToolReply>
  /** Changes nothing in the checkout, which is what lets plan mode run it. */
  readOnly?: boolean
}

export interface Toolkit {
  server: string
  tools: ToolkitTool[]
  /** Added to the turn's system prompt. */
  instructions: string
  /** Built-in tools the turn keeps; every other one is out of reach. Omitted keeps them all. */
  builtins?: string[]
  /** Tools beyond the toolkit's own that run without asking, such as read-only shell commands. */
  allowed?: string[]
  /** Keeps every other MCP server out — the user's own and their claude.ai connectors. */
  focused?: boolean
  /** How long one call may run, for tools that take minutes. */
  timeoutMs?: number
}

const qualified = (server: string, name: string): string => `mcp__${server}__${name}`

/** The SDK options that put a toolkit in front of a turn. */
export function toolkitOptions(
  sdk: Pick<SdkModule, 'createSdkMcpServer' | 'tool'>,
  kit: Omit<Toolkit, 'instructions'>
): Pick<Options, 'mcpServers' | 'allowedTools' | 'tools' | 'strictMcpConfig' | 'env'> {
  const tools = kit.tools.map((t) => sdk.tool(t.name, t.description, t.shape, t.handler as never, { annotations: { readOnlyHint: t.readOnly === true } }))
  const server: McpSdkServerConfigWithInstance = sdk.createSdkMcpServer({ name: kit.server, version: '1.0.0', tools })
  return {
    mcpServers: { [kit.server]: server },
    allowedTools: [...kit.tools.map((t) => qualified(kit.server, t.name)), ...(kit.allowed ?? [])],
    ...(kit.builtins ? { tools: kit.builtins } : {}),
    ...(kit.focused ? { strictMcpConfig: true } : {}),
    // Deferred MCP tools would have the agent search for its own tools before every call.
    env: {
      ...process.env,
      ENABLE_TOOL_SEARCH: 'false',
      ...(kit.focused ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {}),
      ...(kit.timeoutMs ? { MCP_TOOL_TIMEOUT: String(kit.timeoutMs) } : {})
    }
  }
}

/** Whether a call is to one of the toolkit's own tools, which never need the user's say-so. */
export const ownsTool = (kit: Pick<Toolkit, 'server' | 'tools'>, toolName: string): boolean => kit.tools.some((t) => qualified(kit.server, t.name) === toolName)
