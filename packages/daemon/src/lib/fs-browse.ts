/**
 * Directory listing for the folder picker: folders first (a repository is a folder, and only
 * folders can be entered or picked), then files so users can recognise a project by what is in
 * it and search by name. A cheap "is this a git repo" mark saves scanning each candidate. The
 * daemon already exposes the full contents of registered repos to token holders, so listing
 * names on the same machine widens nothing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { DirEntry, DirListing } from '@canopy/shared'

import { ApiError, badRequest } from './errors'

/** node_modules-sized folders are not what anyone browses for; the filter still works on what is returned. */
export const LISTING_CAP = 2000

const expandHome = (p: string): string => (p === '~' ? homedir() : p.replace(/^~(?=\/)/, homedir()))

const isGitRepo = (dir: string): boolean => existsSync(join(dir, '.git'))

function forbidden(path: string): ApiError {
  return new ApiError(403, 'path_forbidden', `${path} is not readable by the daemon`)
}

/** Entries of `input` (default: home): directories, then files; hidden ones last unless filtered out. */
export function listDirectories(input: string | undefined, opts: { hidden?: boolean } = {}): DirListing {
  const home = homedir()
  const path = resolve(expandHome(input?.trim() || home))
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw badRequest('path_not_found', `${path} does not exist`)
    if (code === 'EACCES' || code === 'EPERM') throw forbidden(path)
    throw error
  }
  if (!stat.isDirectory()) throw badRequest('not_a_directory', `${path} is not a directory`)

  let dirents: import('node:fs').Dirent[]
  try {
    dirents = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw forbidden(path)
    throw error
  }

  const entries: DirEntry[] = []
  for (const dirent of dirents) {
    const hidden = dirent.name.startsWith('.')
    if (hidden && !opts.hidden) continue
    const full = join(path, dirent.name)
    let isDir = dirent.isDirectory()
    if (dirent.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue // dangling link
      }
    }
    entries.push({ name: dirent.name, path: full, kind: isDir ? 'dir' : 'file', isGitRepo: isDir && isGitRepo(full), hidden })
  }
  entries.sort(
    (a, b) =>
      Number(a.kind === 'file') - Number(b.kind === 'file') || Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  )

  const parent = dirname(path)
  return { path, parent: parent === path ? null : parent, home, isGitRepo: isGitRepo(path), entries: entries.slice(0, LISTING_CAP), truncated: entries.length > LISTING_CAP }
}
