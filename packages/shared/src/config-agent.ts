/**
 * The Canopy Agent: a conversation on a project's canopy.yaml page that writes the file with the
 * user and checks its services come up. What the daemon serves it and what the page reads back out
 * of its transcript are defined once here, so the two cannot drift apart.
 */
import { z } from 'zod'

import type { AgentEvent } from './agent-stream'

/** The in-process MCP server the agent's tools are served under. */
export const CONFIG_SERVER = 'canopy_config'

export const CONFIG_TOOLS = {
  propose: 'propose_config',
  check: 'check_services'
} as const
export type ConfigTool = (typeof CONFIG_TOOLS)[keyof typeof CONFIG_TOOLS]

export const qualifiedConfigTool = (name: ConfigTool): string => `mcp__${CONFIG_SERVER}__${name}`

export const ProposeConfigInput = z.object({
  /** The whole canopy.yaml, not a patch. */
  yaml: z.string().min(1).describe('The complete canopy.yaml to propose, not a fragment.'),
  summary: z.string().min(1).describe('One sentence on what changed and why, shown above the diff.')
})
export type ProposeConfigInput = z.infer<typeof ProposeConfigInput>

export const CheckServicesInput = z.object({
  base: z.string().min(1).describe('The branch or commit the throwaway worktree starts from, as the user chose it.')
})
export type CheckServicesInput = z.infer<typeof CheckServicesInput>

export const CONFIG_TOOL_DESCRIPTIONS: Record<ConfigTool, string> = {
  propose_config:
    'Put a complete canopy.yaml in front of the user as an unsaved draft, shown as a diff against the saved file. It is linted first: a file with errors is refused with them, so fix them and call again. The user reviews and saves it themselves.',
  check_services:
    'Check the SAVED canopy.yaml for real: create a throwaway worktree from `base`, provision it with that file (ports, databases, setup), start every service, wait until each is healthy or has failed, then destroy the worktree. Returns each setup step and service with its status, and the log tail of anything that failed. Takes minutes.'
}

export const CONFIG_AGENT_INSTRUCTIONS = `You are the Canopy Agent, on this project's canopy.yaml page. canopy.yaml tells Canopy what a worktree of this repo runs: named ports, databases forked per worktree, setup commands, services with health checks, and the env file it writes. Your job is to write that file with the user and prove it works.

How to work:
- Read the repo first (package manifests, lockfiles, docker-compose files, Procfiles, READMEs, .env examples) and the saved canopy.yaml if there is one.
- Ask before you assume. Use AskUserQuestion for every choice the repo does not settle: which services should run, host vs docker for each, which database and whether forks need a seed, which ports are fixed. Give two to four options with a one-line trade-off each, and recommend one.
- Propose with propose_config — the whole file, with a short comment above each section saying why. Never write canopy.yaml with any other tool. After proposing, stop and ask the user to review the diff and press Save.
- Once the user says it is saved, ask which branch the check should start from (offer the default branch and the current one), then call check_services with it.
- Read the report. If a step or service failed, explain the cause from its log in plain words, propose a fix, and check again after it is saved. Stop when every service is healthy, and say so with what runs on which port.

Answer in chat, briefly. Do not edit other files in the repo; if the app itself needs a change to run under Canopy (a hard-coded port, say), say what and where instead.`

/** A proposal the agent made, as the page shows it: the file, why, and the call that made it. */
export interface ConfigProposal {
  callId: string
  yaml: string
  summary: string
}

const PROPOSE = qualifiedConfigTool(CONFIG_TOOLS.propose)

/**
 * The newest proposal in a transcript the daemon accepted. A refused one (it did not lint) never
 * reaches the editor, and a subagent's calls are not the conversation's.
 */
export function latestProposal(events: readonly AgentEvent[]): ConfigProposal | undefined {
  const started = new Map<string, ProposeConfigInput>()
  let latest: ConfigProposal | undefined
  for (const { payload, agentPath } of events) {
    if (agentPath.length > 0) continue
    if (payload.type === 'tool_call_started' && payload.name === PROPOSE) {
      const input = ProposeConfigInput.safeParse(payload.input)
      if (input.success) started.set(payload.callId, input.data)
    }
    if (payload.type !== 'tool_call_completed') continue
    const input = started.get(payload.callId)
    if (input && !payload.result.isError) latest = { callId: payload.callId, ...input }
  }
  return latest
}

/** What the page says once the user saves a proposal, so the agent can go on to check it. */
export const SAVED_MESSAGE = 'I saved your proposal to canopy.yaml.'
