import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runGit } from '../src/git/exec'

describe('runGit', () => {
  it('names the missing directory when git cannot be started there', async () => {
    const gone = join(tmpdir(), 'canopy-not-here-' + Date.now())
    // execa reports an unspawnable command with no exit code at all; reading that as exit 1
    // used to surface as "git diff exited with 1", which says nothing about the cause.
    await expect(runGit(gone, ['diff', '--name-only'])).rejects.toThrow(`git diff could not run: ${gone} does not exist`)
  })

  it('reports what git itself said when it ran and failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopy-notrepo-'))
    try {
      await expect(runGit(dir, ['status'])).rejects.toThrow(/not a git repository/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
