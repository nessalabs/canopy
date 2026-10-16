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

const attribute = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((value) => value !== undefined)

/**
 * Code as CommonMark reads it: fenced blocks (``` or ~~~, any length, closed by a run at least as
 * long), indented blocks after a blank line, and inline spans (a backtick run closed by one of the
 * same length). Rewrites of GitHub's HTML must never reach inside these.
 */
const CODE = /^ {0,3}((`|~)\2{2,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1\2*[ \t]*(?=\n|$)|$(?![\s\S]))|(?:^|\n)\n(?:(?: {4}|\t)[^\n]*(?:\n|$))+|(`+)(?!`)[\s\S]*?[^`]\3(?!`)/gm

/**
 * Runs `rewrite` over the text with every code region set aside, then puts the code back. The
 * stand-ins hold no spaces or markup, so a rewrite can move them — into a bold summary, say —
 * without breaking them.
 */
function outsideCode(markdown: string, rewrite: (text: string) => string): string {
  const code: string[] = []
  const held = markdown.replace(CODE, (match) => `\u0000${code.push(match) - 1}\u0000`)
  return rewrite(held).replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)]!)
}

const images = (text: string): string =>
  text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attribute(tag, 'src')
    if (!src) return tag
    const alt = (attribute(tag, 'alt') ?? '').replace(/[[\]]/g, '')
    return `![${alt}](<${src}>)`
  })

/**
 * The text with each HTML `<img>` tag — what GitHub's editor writes for a pasted screenshot —
 * turned into a markdown image, since the renderer shows raw HTML as text. Only the source and
 * alt text carry over; code is left alone.
 */
export function htmlImagesToMarkdown(markdown: string): string {
  return outsideCode(markdown, images)
}

/**
 * GitHub's own HTML in a comment, as markdown the renderer shows: pasted `<img>` tags become
 * images, and the `<details>`/`<summary>` folds review bots write become a bold summary line with
 * the folded text under it. Only the blockquote a fold wraps its text in is dropped with it; a
 * quote someone wrote stays as written. Code is left alone.
 */
export function githubBodyToMarkdown(markdown: string): string {
  return outsideCode(markdown, (text) =>
    images(text)
      .replace(/(<\/summary>)\s*<blockquote>/gi, '$1')
      .replace(/<\/blockquote>(\s*<\/details>)/gi, '$1')
      .replace(/<summary>\s*([\s\S]*?)\s*<\/summary>/gi, (_, title: string) => `\n\n**${title.replace(/\s+/g, ' ')}**\n\n`)
      .replace(/<\/?details\b[^>]*>/gi, '\n\n')
      // Blank lines left around the dropped tags (some holding only spaces) close up to one.
      .replace(/\n(?:[ \t]*\n)+/g, '\n\n')
  )
}
