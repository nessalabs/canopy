/** Pure helpers for the folder picker. */

export interface Crumb {
  label: string
  path: string
}

/** `/Users/me/dev` → [/, Users, me, dev] with the absolute path of each crumb. */
export function breadcrumbs(path: string): Crumb[] {
  const clean = path.replace(/\/+$/, '')
  if (clean === '') return [{ label: '/', path: '/' }]
  const parts = clean.split('/').filter(Boolean)
  const crumbs: Crumb[] = [{ label: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}

/** Collapses the home directory prefix to `~` for display. */
export const withTilde = (path: string, home: string): string => (path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** Case-insensitive substring match on names; an empty query keeps everything. */
export function filterEntries<T extends { name: string }>(entries: T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
}
