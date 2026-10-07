import { AgentProvider, type SessionRef } from '@canopy/shared'

const PREFIX = 'session:'

/** The Agent tab's panel id for a session opened beside the main conversation. */
export const sessionPanelId = (ref: SessionRef): string => `${PREFIX}${ref.provider}:${ref.sessionId}`

/** The session a panel id names, or undefined for the tab's fixed panels and anything malformed. */
export function parseSessionPanelId(id: string): SessionRef | undefined {
  if (!id.startsWith(PREFIX)) return undefined
  const rest = id.slice(PREFIX.length)
  const colon = rest.indexOf(':')
  const provider = AgentProvider.safeParse(rest.slice(0, colon))
  const sessionId = rest.slice(colon + 1)
  return colon > 0 && provider.success && sessionId !== '' ? { provider: provider.data, sessionId } : undefined
}
