/**
 * Keeping a path out of commits. Three of the four mechanisms are local-only and therefore
 * invisible in `git status`, so this module also has to be able to list what it hid and undo it.
 *
 * The pattern files are shared with the user, who has their own lines in them, so Canopy only
 * ever appends inside a marked block and only ever claims the lines in that block as its own.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Everything below this line in a pattern file is Canopy's to list and remove. */
export const MANAGED_MARKER = '# canopy: hidden from the commit panel'

/**
 * A repo path as a gitignore pattern that matches it and nothing else: anchored to the repo root
 * with a leading slash, and with every character gitignore treats as syntax escaped. Without this
 * a real file called `foo[1].tsx` would be written as a character class and match nothing.
 */
export function toPattern(path: string, isDir: boolean): string {
  const escaped = path.replace(/[[\]*?\\]/g, (char) => `\\${char}`)
  return `/${escaped}${isDir ? '/' : ''}`
}

/** The patterns inside the managed block, in file order. */
export function managedPatterns(contents: string): string[] {
  const lines = contents.split('\n')
  const start = lines.indexOf(MANAGED_MARKER)
  if (start === -1) return []
  const patterns: string[] = []
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    // A blank line or another comment ends the block; the rest of the file is the user's.
    if (trimmed === '' || trimmed.startsWith('#')) break
    patterns.push(trimmed)
  }
  return patterns
}

/** Appends `patterns` to the managed block, creating it if needed and skipping duplicates. */
export function withPatterns(contents: string, patterns: string[]): string {
  const existing = new Set(managedPatterns(contents))
  const added = patterns.filter((pattern) => !existing.has(pattern))
  if (added.length === 0) return contents
  const lines = contents === '' ? [] : contents.replace(/\n$/, '').split('\n')
  const start = lines.indexOf(MANAGED_MARKER)
  if (start === -1) return `${[...lines, ...(lines.length > 0 ? [''] : []), MANAGED_MARKER, ...added].join('\n')}\n`
  const end = start + 1 + managedPatterns(contents).length
  return `${[...lines.slice(0, end), ...added, ...lines.slice(end)].join('\n')}\n`
}

/** Removes `patterns` from the managed block, leaving every other line of the file alone. */
export function withoutPatterns(contents: string, patterns: string[]): string {
  const drop = new Set(patterns)
  const managed = new Set(managedPatterns(contents))
  const lines = contents.replace(/\n$/, '').split('\n')
  const start = lines.indexOf(MANAGED_MARKER)
  if (start === -1) return contents
  const end = start + 1 + managed.size
  const kept = lines.slice(start + 1, end).filter((line) => !drop.has(line.trim()))
  const rest = [...lines.slice(0, start), ...(kept.length > 0 ? [MANAGED_MARKER, ...kept] : []), ...lines.slice(end)]
  return rest.length === 0 ? '' : `${rest.join('\n')}\n`
}

export const readIfPresent = async (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '')

export async function editPatternFile(file: string, edit: (contents: string) => string): Promise<void> {
  const before = await readIfPresent(file)
  const after = edit(before)
  if (after === before) return
  // `.git/info/` is not guaranteed to exist: some repos are cloned or initialised without it.
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, after, 'utf8')
}
