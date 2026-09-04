/** Extension → Shiki language for paths that show up in tool inputs and results. */
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'mdx', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  py: 'python', rs: 'rust', go: 'go', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', xml: 'xml'
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
