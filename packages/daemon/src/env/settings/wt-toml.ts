/**
 * `.config/wt.toml` writer. This file is *committed* and belongs to the team: worktrunk
 * hooks and `[list] url` are the only things Canopy owns in it, so the writer parses what is
 * there, replaces its own keys, and puts everything else back untouched. Replacing rather
 * than appending is the whole point — syncing settings twice must not leave two copies of
 * the same hook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse, stringify } from 'smol-toml'

import { WORKTRUNK_HOOKS, type WorktrunkSettings } from '@canopy/shared'

/** Written at the top so a reader knows which keys the daemon will overwrite. */
export const CANOPY_TOML_HEADER = '# Hooks and [list] url are managed by Canopy; everything else is yours.'

/** Commands Canopy has ever written into a hook; used to recognise its own leftovers. */
const CANOPY_COMMAND_MARKERS = ['canopy provision', 'canopy teardown', 'canopy forget', 'canopy start', 'canopy stop']

/** Key a preserved single-command hook gets when it has to become a table. */
const PRESERVED_KEY = 'default'

type Block = Record<string, string>

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isCanopyEntry = (key: string, command: unknown): boolean =>
  key === 'canopy' || (typeof command === 'string' && CANOPY_COMMAND_MARKERS.some((marker) => command.includes(marker)))

/** The three shapes a worktrunk hook can take, flattened to a list of concurrent blocks. */
function toBlocks(value: unknown): { blocks: Block[]; pipeline: boolean } {
  if (typeof value === 'string') return { blocks: [{ [PRESERVED_KEY]: value }], pipeline: false }
  if (Array.isArray(value)) {
    const blocks = value.filter(isPlainObject).map((entry) => Object.fromEntries(Object.entries(entry).filter(([, v]) => typeof v === 'string')) as Block)
    return { blocks, pipeline: true }
  }
  if (isPlainObject(value)) return { blocks: [Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Block], pipeline: false }
  return { blocks: [], pipeline: false }
}

/**
 * Renders the file: `existing` is the current text (null when the file does not exist) and
 * the result is the full replacement. Deterministic — same inputs, byte-identical output.
 */
export function renderWtToml(existing: string | null, settings: WorktrunkSettings): string {
  let doc: Record<string, unknown> = {}
  if (existing) {
    try {
      doc = parse(existing) as Record<string, unknown>
    } catch {
      // An unparseable file is not something to silently discard, but neither can it be
      // merged; start clean rather than writing invalid TOML back out.
      doc = {}
    }
  }

  for (const hook of WORKTRUNK_HOOKS) {
    const rules = settings.hooks.filter((rule) => rule.hook === hook)
    const claimed = new Set(rules.map((rule) => rule.name).filter((name): name is string => name !== undefined))
    const { blocks, pipeline } = toBlocks(doc[hook])

    // Drop what Canopy wrote before and anything a rule is about to replace by name.
    const kept = blocks
      .map((block) => Object.fromEntries(Object.entries(block).filter(([key, command]) => !isCanopyEntry(key, command) && !claimed.has(key))) as Block)
      .filter((block) => Object.keys(block).length > 0)

    const written: Block = {}
    let unnamed = 0
    for (const rule of rules) {
      if (rule.name) written[rule.name] = rule.command
      else {
        unnamed += 1
        written[`canopy-${unnamed}`] = rule.command
      }
    }

    const keptEntries = kept.reduce((sum, block) => sum + Object.keys(block).length, 0)
    if (keptEntries === 0 && Object.keys(written).length === 0) {
      delete doc[hook]
      continue
    }
    // A lone command reads better as `hook = "cmd"` than as a one-key table.
    if (keptEntries === 0 && rules.length === 1 && unnamed === 1) {
      doc[hook] = rules[0]?.command ?? ''
      continue
    }
    if (pipeline && kept.length > 0) {
      doc[hook] = Object.keys(written).length > 0 ? [...kept, written] : kept
      continue
    }
    doc[hook] = { ...Object.assign({}, ...kept), ...written }
  }

  const list = isPlainObject(doc['list']) ? { ...doc['list'] } : {}
  if (settings.listUrl.length > 0) list['url'] = settings.listUrl
  else delete list['url']
  if (Object.keys(list).length > 0) doc['list'] = list
  else delete doc['list']

  // stringify() drops comments, the header included, so it is re-added every time rather
  // than conditionally — the result carries exactly one copy either way.
  const body = stringify(doc)
  const text = body.length > 0 ? `${CANOPY_TOML_HEADER}\n\n${body}` : `${CANOPY_TOML_HEADER}\n`
  return text.endsWith('\n') ? text : `${text}\n`
}

/** The project's committed worktrunk config, or null when the repo has none. */
export function readWtToml(repoPath: string): string | null {
  const path = join(repoPath, '.config', 'wt.toml')
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Writes `.config/wt.toml` (creating `.config/`) and returns the path that changed. */
export function writeWtToml(repoPath: string, toml: string): string {
  const dir = join(repoPath, '.config')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'wt.toml')
  writeFileSync(path, toml.endsWith('\n') ? toml : `${toml}\n`)
  return path
}
