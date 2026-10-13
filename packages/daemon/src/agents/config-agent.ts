import { CheckServicesInput, CONFIG_AGENT_INSTRUCTIONS, CONFIG_SERVER, CONFIG_TOOL_DESCRIPTIONS, CONFIG_TOOLS, parseCanopyYaml, ProposeConfigInput } from '@canopy/shared'

import { CHECK_TIMEOUT_MS } from '../env/config-check'
import { reply, type Toolkit, type ToolReply } from './toolkit'
import { READ_COMMANDS, READING } from './whiteboard'

/**
 * The Canopy Agent's tools. Proposing only lints — the draft reaches the editor through the
 * transcript, and the user saves it — so the agent never writes canopy.yaml itself. Checking runs
 * the saved file in a throwaway worktree.
 */

const list = (items: string[]): string => items.map((item) => `- ${item}`).join('\n')

/** Lints a proposal: refused with its errors, accepted with its warnings for the agent to weigh. */
export async function proposeConfig(input: unknown): Promise<ToolReply> {
  const { yaml } = ProposeConfigInput.parse(input)
  const { errors, warnings } = parseCanopyYaml(yaml)
  if (errors.length > 0) return reply(`Not proposed: canopy.yaml has errors. Fix exactly these and call again:\n${list(errors)}`, true)
  const caveats = warnings.length > 0 ? `\n\nIt lints with warnings — tell the user which matter:\n${list(warnings)}` : ''
  return reply(`Shown to the user as an unsaved draft beside the saved file. Ask them to review the diff and press Save; do not check services until they say it is saved.${caveats}`)
}

export function configToolkit(check: (base: string) => Promise<string>): Toolkit {
  return {
    server: CONFIG_SERVER,
    tools: [
      { name: CONFIG_TOOLS.propose, description: CONFIG_TOOL_DESCRIPTIONS.propose_config, shape: ProposeConfigInput.shape, handler: proposeConfig, readOnly: true },
      {
        name: CONFIG_TOOLS.check,
        description: CONFIG_TOOL_DESCRIPTIONS.check_services,
        shape: CheckServicesInput.shape,
        // A base that does not exist, a worktree git refuses: the agent reads why and asks again.
        handler: async (input) => check(CheckServicesInput.parse(input).base).then(
          (report) => reply(report),
          (error: unknown) => reply(`The check could not run: ${error instanceof Error ? error.message : String(error)}`, true)
        )
      }
    ],
    instructions: CONFIG_AGENT_INSTRUCTIONS,
    builtins: READING,
    allowed: [...READ_COMMANDS, 'Bash(git branch:*)', 'Bash(git rev-parse:*)', 'Bash(cat:*)'],
    focused: true,
    // A check provisions and starts a whole worktree; leave it its own deadline and a margin.
    timeoutMs: CHECK_TIMEOUT_MS + 60_000
  }
}
