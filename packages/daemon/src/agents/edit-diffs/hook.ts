import { z } from 'zod'

/** What Claude Code pipes to a PreToolUse / PostToolUse hook command (extra fields ignored). */
export const ClaudeHookPayload = z.object({
  hook_event_name: z.enum(['PreToolUse', 'PostToolUse']),
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  tool_name: z.string().min(1),
  tool_use_id: z.string().min(1),
  tool_input: z.unknown().optional()
})
export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayload>
