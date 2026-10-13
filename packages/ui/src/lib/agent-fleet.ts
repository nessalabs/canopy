/**
 * The Agents panel's view of the fleet: which filter keeps which agent, and the sections it is
 * read in — Canopy's own agents first, then each project's. Pure functions over the wire types,
 * so the panel stays a rendering of these.
 */
import type { AgentActivity, FleetAgent, Project } from '@canopy/shared'

/** Waiting on approval is still a turn in progress, so it shows with the working ones. */
export type FleetFilter = 'all' | 'working' | 'done'

const FILTER_KEEPS: Record<FleetFilter, (activity: AgentActivity) => boolean> = {
  all: () => true,
  working: (activity) => activity !== 'done',
  done: (activity) => activity === 'done'
}

/** In the order the panel offers them; labels stay short so the row fits a narrow panel. */
export const FLEET_FILTERS: ReadonlyArray<{ value: FleetFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'working', label: 'Working' },
  { value: 'done', label: 'Done' }
]

/** How many agents each filter would show. */
export function fleetCounts(agents: FleetAgent[]): Record<FleetFilter, number> {
  return { all: agents.length, working: filterFleet(agents, 'working').length, done: filterFleet(agents, 'done').length }
}

export const filterFleet = (agents: FleetAgent[], filter: FleetFilter): FleetAgent[] => agents.filter((agent) => FILTER_KEEPS[filter](agent.activity))

export interface FleetSection {
  id: string
  label: string
  agents: FleetAgent[]
}

/** The agents waiting on someone lead each section, then the ones working, then the rest — newest first within each. */
const RANK: Record<AgentActivity, number> = { approval: 0, running: 1, done: 2 }
const byUrgency = (a: FleetAgent, b: FleetAgent): number => RANK[a.activity] - RANK[b.activity] || b.updatedAt - a.updatedAt

/** Canopy's agents, then one section per project in the sidebar's order; empty sections are left out. */
export function fleetSections(agents: FleetAgent[], projects: Project[]): FleetSection[] {
  const sections: FleetSection[] = [
    { id: 'canopy', label: 'Canopy agents', agents: agents.filter((agent) => agent.kind === 'canopy') },
    ...projects.map((project) => ({ id: project.id, label: project.name, agents: agents.filter((agent) => agent.kind === 'project' && agent.projectId === project.id) }))
  ]
  return sections.filter((section) => section.agents.length > 0).map((section) => ({ ...section, agents: [...section.agents].sort(byUrgency) }))
}

/** Where opening an agent lands: the Git Agent lives in the Git tab, every other session in the Agent tab. */
export const agentHref = (agent: FleetAgent): string => `/worktrees/${agent.worktreeId}?tab=${agent.kind === 'canopy' ? 'git' : 'agent'}`
