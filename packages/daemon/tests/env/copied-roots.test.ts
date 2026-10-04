import { describe, expect, it } from 'vitest'

import type { CacheRule } from '@canopy/shared'

import { copiedRoots } from '../../src/env/worktree/canopyd'

const CACHES: CacheRule[] = [
  { path: 'node_modules', strategy: 'clone' },
  { path: '*/*/node_modules', strategy: 'clone' },
  { path: '.venv/', strategy: 'clone' }
]

describe('copiedRoots', () => {
  it('tells the files under a cache directory as that directory, once', () => {
    const paths = ['node_modules/.bin/tsc', 'node_modules/zod/index.js', 'packages/ui/node_modules/.vite/results.json', '.venv/bin/python']

    expect(copiedRoots(paths, CACHES)).toEqual(['node_modules/', 'packages/ui/node_modules/', '.venv/'])
  })

  it('keeps a copied file as itself, in a folder no cache rule names too', () => {
    expect(copiedRoots(['.env', 'config/local.json', 'packages/ui/.env.local'], CACHES)).toEqual(['.env', 'config/local.json', 'packages/ui/.env.local'])
  })

  it('folds a cloned node_modules of tens of thousands of files to one entry', () => {
    const paths = Array.from({ length: 45_000 }, (_, i) => `node_modules/pkg-${i % 900}/lib/file-${i}.js`)

    expect(copiedRoots(['.env', ...paths], CACHES)).toEqual(['.env', 'node_modules/'])
  })
})
