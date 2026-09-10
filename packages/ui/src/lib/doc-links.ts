/**
 * Where a link inside a rendered markdown file points. Docs link to their neighbours by
 * relative path (`./S06-generator-adapter.md`, `../ARCHITECTURE.md#layers`) and to their own
 * headings by fragment; anything carrying a scheme belongs to the system browser, and is left
 * for the app-wide external-link handler.
 */
export type DocLink = { kind: 'file'; path: string; hash?: string } | { kind: 'anchor'; id: string }

/** A scheme (`https:`, `mailto:`) or a protocol-relative host — both leave the worktree. */
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:|^\/\//i

/** Percent-escapes are how a doc writes a path with spaces; a malformed one is taken literally. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * Collapses `.` and `..` against the directory holding `from`. A leading `/` means the repo
 * root — the worktree is the only root the viewer can read — and a target that climbs past it
 * resolves to nothing rather than to some path outside the tree.
 */
function resolve(from: string, target: string): string | null {
  const segments = target.startsWith('/') ? [] : from.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.length > 0 ? segments.join('/') : null
}

/** What a click on `href`, in the doc at `from`, should open. Null means "not ours to handle". */
export function resolveDocLink(from: string, href: string | undefined): DocLink | null {
  if (href === undefined || href === '') return null
  if (ABSOLUTE.test(href)) return null
  if (href.startsWith('#')) {
    const id = decode(href.slice(1))
    return id === '' ? null : { kind: 'anchor', id }
  }
  const hashAt = href.indexOf('#')
  const hash = hashAt >= 0 ? decode(href.slice(hashAt + 1)) : undefined
  const target = decode((hashAt >= 0 ? href.slice(0, hashAt) : href).split('?')[0] ?? '')
  const path = target === '' ? null : resolve(from, target)
  return path === null ? null : { kind: 'file', path, hash: hash === '' ? undefined : hash }
}

/**
 * A heading's fragment id, the way GitHub writes one: lowercased, punctuation dropped, spaces
 * hyphenated. Rendered headings carry no ids, so a `#fragment` click finds its heading by
 * slugging the text of each one.
 */
export const slugify = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
