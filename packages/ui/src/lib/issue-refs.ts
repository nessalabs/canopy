import { linkText, type LinkedPart, type MdNode } from './remark-link-text'

/**
 * `#123` in an agent's answer — an issue or PR of the repository, the way GitHub writes them —
 * as a link the conversation opens in its reader. The link is an in-page anchor, so anything
 * that does not claim it goes nowhere.
 */
const PREFIX = '#canopy-issue-'

export const issueHref = (number: number): string => `${PREFIX}${number}`

/** The issue an `issueHref` names, or null for any other link. */
export function parseIssueHref(href: string): number | null {
  if (!href.startsWith(PREFIX)) return null
  const number = Number(href.slice(PREFIX.length))
  return Number.isInteger(number) && number > 0 ? number : null
}

// Not after a word, a path, an `&` (an HTML entity) or another `#` (a heading or a colour).
const IN_TEXT = /(?<![\w/&#])#(\d+)\b/g

export function splitIssueRefs(text: string): LinkedPart[] {
  const parts: LinkedPart[] = []
  let last = 0
  for (const match of text.matchAll(IN_TEXT)) {
    const index = match.index ?? 0
    if (index > last) parts.push(text.slice(last, index))
    parts.push({ raw: match[0], url: issueHref(Number(match[1])) })
    last = index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** A remark plugin: every `#123` in prose, or alone in a code span, becomes a link to that issue. */
export const remarkIssueRefs = () => (tree: MdNode) =>
  linkText(tree, splitIssueRefs, (value) => (/^#\d+$/.test(value.trim()) ? issueHref(Number(value.trim().slice(1))) : null))
