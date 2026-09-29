/**
 * The daemon runs as ESM under tsx, where `require` does not exist. Vitest's module runner
 * provides one anyway, so a stray `require(...)` passes every test and fails only in the real
 * daemon — which is how saving canopy.yaml broke with "require is not defined". This reads the
 * source instead of running it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|mts)$/.test(entry.name) ? [path] : []
  })

describe('daemon source', () => {
  it('never calls CommonJS require', () => {
    const offenders = sources(SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => (/(^|[^.\w])require\(/.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') ? [`${relative(SRC, file)}:${index + 1}`] : []))
    )
    expect(offenders).toEqual([])
  })
})
