import type { SupportedLanguages } from '@pierre/diffs'

/**
 * Extension → Shiki grammar. One table for both jobs it serves: highlighting a tool call's
 * text, and warming the grammars a change set will need before its first diff renders.
 */
const BY_EXTENSION: Record<string, SupportedLanguages> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', md: 'markdown', mdx: 'mdx',
  css: 'css', scss: 'scss', html: 'html', svelte: 'svelte', vue: 'vue',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', sql: 'sql', graphql: 'graphql',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', lua: 'lua'
}

const extensionOfPath = (path: string): string => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''

/** Extensions whose contents read as prose; `.mdx` renders its markdown and leaves JSX as text. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

/** Whether a path holds markdown, and so should open rendered rather than as source. */
export const isMarkdownPath = (path: string): boolean => MARKDOWN_EXTENSIONS.has(extensionOfPath(path))

/**
 * The grammars a set of changed files needs, deduped and in a stable order. Shiki resolves a
 * grammar the first time it highlights one, so knowing the whole set up front is what lets the
 * downloads happen while the user is still picking a file instead of mid-render.
 */
export function grammarsFor(paths: readonly string[]): SupportedLanguages[] {
  const langs = paths.map((path) => BY_EXTENSION[extensionOfPath(path)]).filter((lang) => lang !== undefined)
  return [...new Set(langs)].sort()
}

/** Tools whose input is code in a fixed language. */
const BY_TOOL: Record<string, string> = { Bash: 'bash', Grep: 'bash', Glob: 'bash' }

const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text) && /[\]}]\s*$/.test(text)
const looksLikeDiff = (text: string): boolean => /^(diff --git|@@ |--- a\/|\+\+\+ b\/)/m.test(text)
const extensionOf = (text: string): string | undefined => /\.([a-z0-9]+)(?::\d+)?\s*$/i.exec(text.trim().split('\n')[0] ?? '')?.[1]?.toLowerCase()

/** Best-effort language for a tool call's text so CodeBlock can highlight it. */
export function guessLanguage(tool: string | undefined, text: string): string {
  if (tool && BY_TOOL[tool]) return BY_TOOL[tool]
  if (looksLikeDiff(text)) return 'diff'
  if (looksLikeJson(text)) return 'json'
  const ext = extensionOf(text)
  return (ext && BY_EXTENSION[ext]) ?? 'text'
}
