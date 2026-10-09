import { GroupReply, type ChangeGroup, type ChangeGroupPart, type ChangeGroups, type GroupLink, type HunkRef } from './schemas/change-groups'

/**
 * Turning an agent's grouping into groups the Groups pane can draw. The agent names hunks by the
 * short ids its brief gave them (`h12`, `f3`); this maps them back, and makes the answer whole
 * whatever the agent wrote — so it can run anywhere an answer is read.
 */

/** Hunks by the ids the brief gave them, in the order the diff reads. */
export type HunkIds = Record<string, HunkRef>

const REST: Omit<ChangeGroup, 'refs'> = { id: 'rest', title: 'Everything else', summary: 'Changes the grouping did not place.', layers: [], parts: [] }

/**
 * The reply made whole: ids mapped back to hunks in diff order, unknown ids dropped, an id named
 * twice kept where it first appears, empty groups dropped, and whatever no group claimed gathered
 * into a last group, so nothing in the change goes unreviewed.
 */
export function resolveGroups(reply: GroupReply, refs: HunkIds): ChangeGroup[] {
  const rank = new Map(Object.keys(refs).map((id, index) => [id, index]))
  const claimed = new Set<string>()
  const claim = (ids: string[]): HunkRef[] => {
    const mine = [...new Set(ids.filter((id) => rank.has(id) && !claimed.has(id)))]
    mine.forEach((id) => claimed.add(id))
    return mine.sort((a, b) => rank.get(a)! - rank.get(b)!).map((id) => refs[id]!)
  }
  const part = ({ title, summary, layers, ids }: GroupReply['groups'][number]['parts'][number], id: string): ChangeGroupPart => ({ id, title, summary, layers, refs: claim(ids) })

  const groups = reply.groups
    .map((group, i) => ({ ...part(group, `${i + 1}`), parts: group.parts.map((p, j) => part(p, `${i + 1}.${j + 1}`)).filter((p) => p.refs.length > 0) }))
    .filter((group) => group.refs.length > 0 || group.parts.length > 0)
  const rest = Object.keys(refs).filter((id) => !claimed.has(id))
  return rest.length > 0 ? [...groups, { ...REST, refs: rest.map((id) => refs[id]!) }] : groups
}

/**
 * The reply's links between features, kept only where both ends survived `resolveGroups`. Group
 * ids are their 1-based place in the reply, so a reply number is its group's id; a link to
 * itself or repeated is dropped.
 */
export function resolveLinks(reply: GroupReply, groups: ChangeGroup[]): GroupLink[] {
  const ids = new Set(groups.map((group) => group.id))
  const seen = new Set<string>()
  return reply.links.flatMap(({ from, to, label }) => {
    const [a, b] = [`${from}`, `${to}`]
    if (a === b || !ids.has(a) || !ids.has(b) || seen.has(`${a}>${b}`)) return []
    seen.add(`${a}>${b}`)
    return [{ from: a, to: b, ...(label ? { label } : {}) }]
  })
}

/** The fence an agent writes its grouping in. */
export const GROUPS_FENCE = 'change-groups'

const BLOCK = new RegExp('```' + GROUPS_FENCE + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g')

/** A grouping block's JSON, as the agent wrote it; undefined while it is still arriving or was not one. */
export function parseGroupJson(source: string): GroupReply | undefined {
  try {
    const reply = GroupReply.safeParse(JSON.parse(source))
    return reply.success ? reply.data : undefined
  } catch {
    return undefined
  }
}

/** The last grouping in an answer; undefined when there is none or it does not parse. */
export function parseGroupBlock(text: string): GroupReply | undefined {
  const body = [...text.matchAll(BLOCK)].at(-1)?.[1]
  return body === undefined ? undefined : parseGroupJson(body)
}

/** The groups an answer holds, resolved against the brief's ids; undefined when it holds none. */
export function groupsFromAnswer(text: string, ids: HunkIds, fingerprint: string): ChangeGroups | undefined {
  const reply = parseGroupBlock(text)
  if (!reply) return undefined
  const groups = resolveGroups(reply, ids)
  return { groups, links: resolveLinks(reply, groups), fingerprint }
}
