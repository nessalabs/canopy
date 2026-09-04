/**
 * Files a shell command writes, read off its text. Nothing in a Claude Code or Codex
 * transcript records what a Bash call touched, so this is the only agent-attributable
 * signal for shell edits: output redirections, in-place editors, copy/move targets,
 * and `open(..., 'w')`-style calls inside heredoc or `-c` scripts. Pure and cwd-aware.
 */
import { isAbsolute, resolve } from 'node:path'

type TokenKind = 'word' | 'op' | 'redirect' | 'heredoc'
interface Token {
  kind: TokenKind
  text: string
}

const SEGMENT_OPS = new Set(['&&', '||', '|', ';', '&', '\n'])
const REDIRECT = /^(\d?)(>>|>|&>|<<<|<<-?|<)/
const QUOTES: Record<string, string> = { "'": "'", '"': '"', '`': '`' }

/** Reads one heredoc body starting at the newline after `<<DELIM`; returns the body and where the command resumes. */
function heredocBody(source: string, from: number, delimiter: string): { body: string; end: number } {
  const start = source.indexOf('\n', from)
  if (start === -1) return { body: '', end: source.length }
  const lines = source.slice(start + 1).split('\n')
  const stop = lines.findIndex((line) => line.trim() === delimiter)
  const body = lines.slice(0, stop === -1 ? undefined : stop).join('\n')
  const consumed = stop === -1 ? source.length : start + 1 + lines.slice(0, stop + 1).join('\n').length
  return { body, end: consumed }
}

/** One shell word, honouring quotes, backslashes and `$( … )` nesting. Quotes are stripped. */
function readWord(source: string, from: number): { word: string; end: number } {
  let i = from
  let word = ''
  let depth = 0
  while (i < source.length) {
    const ch = source[i] as string
    if (depth === 0 && (/\s/.test(ch) || (/[;&|<>]/.test(ch) && !(ch === '&' && source[i + 1] === '>')))) break
    if (ch === '\\' && i + 1 < source.length) {
      word += source[i + 1]
      i += 2
      continue
    }
    if (ch in QUOTES) {
      const close = source.indexOf(QUOTES[ch] as string, i + 1)
      const stop = close === -1 ? source.length : close
      word += source.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    if (ch === '$' && source[i + 1] === '(') depth++
    if (ch === ')' && depth > 0) depth--
    word += ch
    i++
  }
  return { word, end: i }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let pendingHeredocs: string[] = []
  while (i < source.length) {
    const ch = source[i] as string
    if (ch === '\n') {
      // Heredoc bodies begin after the line that declared them.
      for (const delimiter of pendingHeredocs) {
        const { body, end } = heredocBody(source, i, delimiter)
        tokens.push({ kind: 'heredoc', text: body })
        i = end
      }
      pendingHeredocs = []
      tokens.push({ kind: 'op', text: ';' })
      i = i < source.length && source[i] === '\n' ? i + 1 : i
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const two = source.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      tokens.push({ kind: 'op', text: two })
      i += 2
      continue
    }
    const redirect = REDIRECT.exec(source.slice(i))
    if (redirect) {
      const op = redirect[2] as string
      i += redirect[0].length
      if (op.startsWith('<<') && op !== '<<<') {
        const { word, end } = readWord(source, skipSpaces(source, i))
        pendingHeredocs.push(word)
        i = end
        continue
      }
      tokens.push({ kind: 'redirect', text: op })
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      tokens.push({ kind: 'op', text: ch })
      i++
      continue
    }
    const { word, end } = readWord(source, i)
    tokens.push({ kind: 'word', text: word })
    i = end
  }
  for (const delimiter of pendingHeredocs) tokens.push({ kind: 'heredoc', text: heredocBody(source, source.length, delimiter).body })
  return tokens
}

const skipSpaces = (source: string, from: number): number => {
  let i = from
  while (i < source.length && /[ \t]/.test(source[i] as string)) i++
  return i
}

/** A simple command: argv, its output-redirect targets, and any heredoc bodies fed to it. */
interface Segment {
  argv: string[]
  outputs: string[]
  scripts: string[]
}

function segments(tokens: Token[]): Segment[] {
  const result: Segment[] = []
  let current: Segment = { argv: [], outputs: [], scripts: [] }
  const flush = (): void => {
    if (current.argv.length > 0 || current.outputs.length > 0) result.push(current)
    current = { argv: [], outputs: [], scripts: [] }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind === 'op' && SEGMENT_OPS.has(token.text)) {
      flush()
      continue
    }
    if (token.kind === 'heredoc') {
      current.scripts.push(token.text)
      continue
    }
    if (token.kind === 'redirect') {
      const target = tokens[i + 1]
      if (target?.kind === 'word') i++
      if (target?.kind === 'word' && (token.text === '>' || token.text === '>>' || token.text === '&>')) current.outputs.push(target.text)
      continue
    }
    current.argv.push(token.text)
  }
  flush()
  return result
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const isFlag = (arg: string): boolean => arg.startsWith('-') && arg !== '-'
const positionals = (args: string[]): string[] => args.filter((arg) => !isFlag(arg))

/** Command wrappers whose real command follows. */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'deno', 'bun', 'tsx'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])

/** Per-command write targets from its positional arguments. */
const WRITERS: Record<string, (args: string[]) => string[]> = {
  tee: (args) => positionals(args),
  touch: (args) => positionals(args),
  rm: (args) => positionals(args),
  truncate: (args) => positionals(args),
  cp: (args) => positionals(args).slice(-1),
  mv: (args) => positionals(args).slice(-1),
  install: (args) => positionals(args).slice(-1),
  ln: (args) => positionals(args).slice(-1),
  // `sed -i 'expr' files…` — the first positional is the expression unless -e/-f carried it.
  sed: (args) => (args.some((a) => a.startsWith('-i')) ? positionals(withoutOptionValues(args, ['-e', '-f'])).slice(hasAny(args, ['-e', '-f']) ? 0 : 1) : []),
  perl: (args) => (args.includes('-i') || args.some((a) => a.startsWith('-pi') || a.startsWith('-i')) ? positionals(args).filter((a) => !a.startsWith('s/')) : [])
}

const hasAny = (args: string[], flags: string[]): boolean => args.some((a) => flags.includes(a))
/** `args` minus the given flags and the value each one takes. */
const withoutOptionValues = (args: string[], flags: string[]): string[] => args.filter((arg, i) => !flags.includes(arg) && !flags.includes(args[i - 1] ?? ''))

/** Write calls inside a script body: python `open(p, 'w')`, `Path(p).write_text`, node `writeFileSync(p`. */
const SCRIPT_WRITES: RegExp[] = [
  /open\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])[wax]/g,
  /Path\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.write_(?:text|bytes)/g,
  /write(?:File|FileSync)\(\s*(['"])([^'"\n]+)\1/g
]
/** `name = 'path'` … `open(name, 'w')`: a variable standing in for the path. */
const SCRIPT_VAR_WRITE = /open\(\s*([A-Za-z_]\w*)\s*,\s*(['"])[wax]/g

function scriptWrites(script: string): string[] {
  const found: string[] = []
  for (const pattern of SCRIPT_WRITES) for (const match of script.matchAll(pattern)) found.push(match[2] as string)
  for (const match of script.matchAll(SCRIPT_VAR_WRITE)) {
    // The variable's most recent assignment before this write — scripts often reuse `p` per file.
    const assignments = [...script.slice(0, match.index).matchAll(new RegExp(`\\b${match[1]}\\s*=\\s*(['"])([^'"\\n]+)\\1`, 'g'))]
    const last = assignments.at(-1)
    if (last) found.push(last[2] as string)
  }
  return found
}

/** `$NAME` / `${NAME}` from assignments seen earlier in the same command line. */
const expand = (word: string, vars: Map<string, string>): string =>
  word.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => vars.get(name) ?? whole)

const isDevice = (path: string): boolean => path.startsWith('/dev/') || /^&\d$/.test(path) || /^\d$/.test(path)

/**
 * Absolute paths the command writes, deduped. `cwd` anchors relative
 * paths and follows `cd` within the command; without it, relative paths are dropped.
 */
export function shellWriteTargets(command: string, cwd?: string): string[] {
  const vars = new Map<string, string>()
  const found: string[] = []
  let dir = cwd
  const record = (path: string): void => {
    const expanded = expand(path, vars)
    if (isDevice(expanded) || expanded.includes('$')) return
    if (isAbsolute(expanded)) found.push(expanded)
    else if (dir) found.push(resolve(dir, expanded))
  }

  for (const segment of segments(tokenize(command))) {
    const argv = segment.argv.map((word) => expand(word, vars))
    while (argv.length > 0 && ASSIGNMENT.test(argv[0] as string)) {
      const [, name, value] = ASSIGNMENT.exec(argv.shift() as string) as RegExpExecArray
      vars.set(name as string, expand(value as string, vars))
    }
    while (argv.length > 0 && WRAPPERS.has(argv[0] as string)) argv.shift()
    const [cmd = '', ...args] = argv
    segment.outputs.forEach(record)
    if (cmd === 'cd' && args[0]) dir = dir ? resolve(dir, expand(args[0], vars)) : (isAbsolute(args[0]) ? args[0] : dir)
    else if (SHELLS.has(cmd) && args.includes('-c')) found.push(...shellWriteTargets(args[args.indexOf('-c') + 1] ?? '', dir))
    else if (INTERPRETERS.has(cmd)) [...segment.scripts, ...inlineScripts(args)].flatMap(scriptWrites).forEach(record)
    else WRITERS[cmd]?.(args).forEach(record)
  }
  return [...new Set(found)]
}

/** `python -c CODE` / `node -e CODE` bodies. */
const inlineScripts = (args: string[]): string[] => args.flatMap((arg, i) => ((arg === '-c' || arg === '-e') && args[i + 1] ? [args[i + 1] as string] : []))
