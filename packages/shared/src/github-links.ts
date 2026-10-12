/**
 * Reading GitHub's links the way GitHub does: which point at an issue or PR of the repository,
 * which at a file someone attached, and which `#123` in plain text GitHub would have linked.
 * Shared by the daemon, which fetches attachments, and the UI, which follows links in Canopy.
 */

/** GitHub's attachment links, and nothing else: the daemon is not a general-purpose fetcher. */
export function isAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.hostname === 'github.com') return parsed.pathname.startsWith('/user-attachments/') || /^\/[^/]+\/[^/]+\/files\//.test(parsed.pathname)
    return parsed.hostname.endsWith('.githubusercontent.com')
  } catch {
    return false
  }
}

/** Where a link in an issue goes: another issue or PR of this repository, an attachment, or out. */
export type GitHubLink = { kind: 'issue'; number: number } | { kind: 'attachment'; url: string } | { kind: 'external'; url: string }

/** `repoUrl` is the repository's own URL, `https://github.com/owner/name`. */
export function classifyGitHubLink(href: string, repoUrl: string): GitHubLink {
  if (isAttachmentUrl(href)) return { kind: 'attachment', url: href }
  const base = repoUrl.replace(/\/+$/, '').toLowerCase()
  const match = /^(.*)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(href)
  if (match && match[1]!.toLowerCase() === base) return { kind: 'issue', number: Number(match[2]) }
  return { kind: 'external', url: href }
}

/** The repository's URL from one of its issue or PR URLs. */
export const repoUrlOf = (issueUrl: string): string => issueUrl.replace(/\/(?:issues|pull)\/\d+.*$/, '')

/**
 * The text with each plain `#123` turned into a link to that issue, as GitHub renders it. Code —
 * fenced or inline — and text already inside a link or URL are left alone.
 */
export function linkIssueRefs(markdown: string, repoUrl: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/(^|[\s(,;:])#(\d+)\b(?!\])/g, (_, lead: string, n: string) => `${lead}[#${n}](${repoUrl}/issues/${n})`)))
    .join('')
}
