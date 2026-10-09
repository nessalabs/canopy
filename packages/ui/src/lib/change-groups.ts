import { diffFingerprint, groupsFromAnswer, type ChangeGroup, type ChangeGroups, type ChangedFile, type HunkIds, type HunkRef } from '@canopy/shared'
import { AgentEventType, isEvent, isMainThread, type AgentEvent } from '@canopy/shared/agent-stream'

/**
 * The Groups pane without React: Claude's groups as the numbered sections a reviewer works
 * through, the files and hunks each one shows, and what makes a tick or a result still valid.
 */

/** A feature split into parts is announced once, above its first section. */
export interface FeatureHeading {
  title: string
  summary: string
  layers: string[]
}

/** One thing to review and tick off: a feature with no parts, or one part of a feature. */
export interface ReviewSection {
  id: string
  /** `3`, or `3.2` for the second part of the third feature. */
  number: string
  title: string
  summary: string
  layers: string[]
  refs: HunkRef[]
  heading?: FeatureHeading
}

const leaf = (part: Omit<ChangeGroup, 'parts'>, number: string, heading?: FeatureHeading): ReviewSection => ({
  id: part.id,
  number,
  title: part.title,
  summary: part.summary,
  layers: part.layers,
  refs: part.refs,
  ...(heading ? { heading } : {})
})

/**
 * Features flattened into sections in reading order. A feature with parts becomes a heading over
 * them; hunks it kept for itself come first, as the groundwork its parts build on.
 */
export function reviewSections(groups: ChangeGroup[]): ReviewSection[] {
  return groups.flatMap((group, i) => {
    const number = `${i + 1}`
    if (group.parts.length === 0) return [leaf(group, number)]
    const own = group.refs.length > 0 ? [{ ...group, id: `${group.id}.0`, title: 'Groundwork', summary: '' }] : []
    const parts = [...own, ...group.parts]
    const heading = { title: group.title, summary: group.summary, layers: group.layers }
    return parts.map((part, j) => leaf(part, `${number}.${j + 1}`, j === 0 ? heading : undefined))
  })
}

/** A section's files in the order they first appear, with the hunks it shows of each; `undefined` is the whole file. */
export function sectionFiles(refs: HunkRef[]): Array<{ path: string; hunks?: number[] }> {
  const files = new Map<string, number[] | undefined>()
  for (const { path, hunk } of refs) {
    const seen = files.has(path) ? files.get(path) : []
    files.set(path, hunk === undefined || seen === undefined ? undefined : [...seen, hunk])
  }
  return [...files].map(([path, hunks]) => (hunks ? { path, hunks } : { path }))
}

/** What a tick is kept under: the hunks it covers, so regrouping the same hunks keeps it and changing them drops it. */
export const reviewedKey = (refs: HunkRef[]): string => refs.map(({ path, hunk }) => `${path}#${hunk ?? '*'}`).join('\n')

/** Groups made from a diff that has since changed shape. */
export const isStale = (result: ChangeGroups, files: ChangedFile[]): boolean => result.fingerprint !== diffFingerprint(files)

/** One feature as the overview's card: what it is, how big, how far reviewed, and where its sections start. */
export interface FeatureCard {
  id: string
  number: string
  title: string
  summary: string
  layers: string[]
  files: number
  hunks: number
  /** Added when every file it touches is new, deleted when every one goes, modified otherwise. */
  status: 'added' | 'modified' | 'deleted'
  reviewed: number
  sections: number
  /** The index in `reviewSections` of its first section, where opening the card lands. */
  first: number
}

const KIND: Record<ChangedFile['status'], FeatureCard['status']> = { A: 'added', U: 'added', D: 'deleted', M: 'modified', T: 'modified' }

export function featureCards(groups: ChangeGroup[], sections: ReviewSection[], files: ChangedFile[], reviewed: ReadonlySet<string>): FeatureCard[] {
  const status = new Map(files.map((file) => [file.path, KIND[file.status]]))
  return groups.map((group, i) => {
    const number = `${i + 1}`
    const mine = sections.flatMap((section, index) => (section.number === number || section.number.startsWith(`${number}.`) ? [{ section, index }] : []))
    const refs = mine.flatMap(({ section }) => section.refs)
    const kinds = new Set(refs.map((ref) => status.get(ref.path) ?? 'modified'))
    return {
      id: group.id,
      number,
      title: group.title,
      summary: group.summary,
      layers: group.layers,
      files: new Set(refs.map((ref) => ref.path)).size,
      hunks: refs.length,
      status: kinds.size === 1 ? [...kinds][0]! : 'modified',
      reviewed: mine.filter(({ section }) => reviewed.has(reviewedKey(section.refs))).length,
      sections: mine.length,
      first: mine[0]?.index ?? 0
    }
  })
}

/**
 * The grouping a session last answered with: the newest main-conversation answer holding a
 * ```change-groups block, read against the brief that started it. A later "merge 3 and 4" answer
 * replaces an earlier one; a subagent's notes never count.
 */
export function latestGrouping(events: readonly AgentEvent[], ids: HunkIds, fingerprint: string): ChangeGroups | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (!isMainThread(event) || !isEvent(event, AgentEventType.AssistantText)) continue
    const found = groupsFromAnswer(event.payload.text, ids, fingerprint)
    if (found) return found
  }
  return undefined
}
