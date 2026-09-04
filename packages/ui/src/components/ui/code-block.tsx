"use client"

import * as React from "react"
import { preloadHighlighter, registerCustomTheme } from "@pierre/diffs"
import { File } from "@pierre/diffs/react"
import type {
  DiffsThemeNames,
  SupportedLanguages,
  ThemesType,
} from "@pierre/diffs"
import { Check, Copy } from "lucide-react"

import { cn } from "@/lib/utils"

export type CodeBlockMode = "system" | "light" | "dark"

/**
 * Appearance shared by every code block. Set once with CodeBlockProvider to
 * theme all code surfaces — direct CodeBlock uses and the fenced blocks
 * MessageMarkdown renders — from one place; any CodeBlock prop still
 * overrides per instance.
 */
export interface CodeBlockConfig {
  /**
   * The syntax theme: a single Shiki theme name, or a `{ dark, light }` pair
   * picked from by `mode`. Defaults to Nessa's own restrained "nessa-dark"
   * (dark) and Light+ (light). Pierre's own themes remain available by name.
   */
  theme?: DiffsThemeNames | ThemesType
  /**
   * Which side of the theme pair renders: `system` follows the OS scheme,
   * `light` and `dark` pin one side. Hosts that resolve their own color mode
   * pass it here so code blocks follow the app instead of the OS.
   */
  mode?: CodeBlockMode
  /** Show line numbers in the gutter. Off by default. */
  lineNumbers?: boolean
  /** Wrap long lines instead of scrolling horizontally. */
  wrap?: boolean
}

/**
 * Nessa's own dark syntax theme: a neutral near-black ground that sits flush
 * with the neutral dark palette, and a deliberately restrained token set —
 * calm periwinkle keywords, sage strings, one soft accent per role instead of
 * a rainbow. Every color is chosen to clear WCAG AA 4.5:1 on the ground and
 * on diff-wash rows, comments included, so the a11y gate never trips on
 * rendered code.
 */
const nessaDarkTheme = {
  name: "nessa-dark",
  type: "dark" as const,
  bg: "#101010",
  fg: "#e6e6e6",
  colors: {
    "editor.background": "#101010",
    "editor.foreground": "#e6e6e6",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#9aa3ad" },
    },
    {
      scope: ["string", "punctuation.definition.string"],
      settings: { foreground: "#9ecb9a" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character",
        "constant.other",
      ],
      settings: { foreground: "#d8b078" },
    },
    {
      scope: [
        "keyword",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "entity.name.tag",
      ],
      settings: { foreground: "#a8b8f8" },
    },
    {
      scope: ["keyword.operator", "punctuation"],
      settings: { foreground: "#b0b6bd" },
    },
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: "#cbb0f0" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
      ],
      settings: { foreground: "#8fd1e3" },
    },
    {
      scope: [
        "support.type.property-name",
        "variable.other.property",
        "variable.other.object.property",
        "entity.other.attribute-name",
        "meta.object-literal.key",
      ],
      settings: { foreground: "#9fc6e9" },
    },
    {
      scope: ["variable", "variable.parameter", "meta.definition.variable"],
      settings: { foreground: "#e6e6e6" },
    },
    {
      scope: ["markup.heading"],
      settings: { foreground: "#e6e6e6", fontStyle: "bold" },
    },
    {
      scope: ["markup.inline.raw", "markup.raw.block"],
      settings: { foreground: "#c9d1d9" },
    },
  ],
}

registerCustomTheme("nessa-dark", async () => nessaDarkTheme)

/**
 * The default syntax theme pair: Nessa's own restrained near-black dark
 * theme, and Light+ — the bundled light theme with the highest minimum WCAG
 * contrast.
 */
const defaultCodeTheme: ThemesType = {
  dark: "nessa-dark",
  light: "light-plus",
}

/**
 * Loads the syntax highlighter's themes and grammars ahead of the first
 * code block that needs them. Shiki resolves both lazily, on first render,
 * so a code surface that appears during a busy moment — a streamed message,
 * a route transition — pays that cost while the user is watching. An app
 * that knows it will render code can call this once at boot and move the
 * work to an idle moment; skipping it changes nothing but the timing.
 *
 * `langs` are the file types the app expects to render, and `theme`
 * defaults to the same pair CodeBlock itself uses. Resolves when the
 * highlighter is warm, and rejects only if the load itself fails — nothing
 * downstream depends on it, so a rejection is safe to ignore.
 */
export async function preloadCodeHighlighter(
  langs: readonly SupportedLanguages[],
  theme: DiffsThemeNames | ThemesType = defaultCodeTheme,
): Promise<void> {
  const themes =
    typeof theme === "string" ? [theme] : [theme.dark, theme.light]
  await preloadHighlighter({ themes, langs: [...langs] })
}

const CodeBlockContext = React.createContext<CodeBlockConfig>({})

/**
 * Reads the shared code appearance from the nearest CodeBlockProvider. Other
 * code surfaces — MermaidDiagram, custom renderers — use this to follow the
 * same app-wide mode and theming as code blocks.
 */
function useCodeBlockConfig(): CodeBlockConfig {
  return React.useContext(CodeBlockContext)
}

export interface CodeBlockProviderProps extends CodeBlockConfig {
  children?: React.ReactNode
}

/**
 * Provides the shared code appearance for a subtree — typically the app root,
 * so one theme choice applies to every code block, including those rendered
 * inside MessageMarkdown.
 */
function CodeBlockProvider({
  children,
  theme,
  mode,
  lineNumbers,
  wrap,
}: CodeBlockProviderProps) {
  const parent = React.useContext(CodeBlockContext)
  const value = React.useMemo(
    () => ({
      theme: theme ?? parent.theme,
      mode: mode ?? parent.mode,
      lineNumbers: lineNumbers ?? parent.lineNumbers,
      wrap: wrap ?? parent.wrap,
    }),
    [lineNumbers, mode, parent, theme, wrap],
  )
  return (
    <CodeBlockContext.Provider value={value}>
      {children}
    </CodeBlockContext.Provider>
  )
}

/**
 * The floating copy control shared by Nessa's rendered content surfaces. It
 * copies `text` and flips to a check mark for a moment as feedback. Reveal is
 * hover/focus-driven via the `group/copy` parent set by the owning surface.
 */
function CopyButton({
  text,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> & {
  /** The exact text placed on the clipboard. */
  text: string
  /** Accessible name for the control, e.g. "Copy code". */
  label: string
}) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<number>(undefined)
  React.useEffect(() => () => window.clearTimeout(resetTimer.current), [])
  return (
    <button
      type="button"
      data-slot="copy-button"
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        // Clipboard access is absent in insecure contexts and writes can be
        // denied; only show the copied state once the write actually landed.
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            window.clearTimeout(resetTimer.current)
            resetTimer.current = window.setTimeout(() => setCopied(false), 2000)
          })
          .catch(() => {})
      }}
      className={cn(
        "absolute right-2 top-2 flex size-7 items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 [&_svg]:size-3.5",
        className,
      )}
      {...props}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  )
}

export interface CodeBlockProps
  extends Omit<React.ComponentProps<"div">, "children">,
    CodeBlockConfig {
  /** The source code to render. */
  code: string
  /** Language for syntax highlighting, e.g. "tsx". Inferred from `filename` when omitted. */
  language?: string
  /** When set, renders Pierre's file header above the code. */
  filename?: string
}

/**
 * A syntax-highlighted code block backed by Pierre's rendering engine
 * (Shiki-based highlighting with dark and light themes). Standalone it
 * renders any snippet; MessageMarkdown composes it automatically for fenced
 * code. Appearance resolves from props first, then the nearest
 * CodeBlockProvider, then defaults, so hosts theme every code surface from
 * one place.
 */
function CodeBlock({
  code,
  language,
  filename,
  theme,
  mode,
  lineNumbers,
  wrap,
  className,
  ...props
}: CodeBlockProps) {
  const config = React.useContext(CodeBlockContext)
  const resolved = {
    theme: theme ?? config.theme ?? defaultCodeTheme,
    mode: mode ?? config.mode ?? "system",
    lineNumbers: lineNumbers ?? config.lineNumbers ?? false,
    wrap: wrap ?? config.wrap ?? false,
  }
  const file = React.useMemo(
    () => ({
      name: filename ?? `snippet.${language ?? "txt"}`,
      contents: code,
      ...(language !== undefined && {
        lang: language as SupportedLanguages,
      }),
    }),
    [code, filename, language],
  )
  const options = React.useMemo(
    () => ({
      disableFileHeader: filename === undefined,
      disableLineNumbers: !resolved.lineNumbers,
      overflow: resolved.wrap ? ("wrap" as const) : ("scroll" as const),
      themeType: resolved.mode,
      ...(resolved.theme !== undefined && { theme: resolved.theme }),
    }),
    [filename, resolved.lineNumbers, resolved.mode, resolved.theme, resolved.wrap],
  )
  return (
    <div
      data-slot="code-block"
      className={cn(
        "group/copy relative min-w-0 max-w-full overflow-hidden rounded-xl nessa-text-3 leading-6",
        className,
      )}
      {...props}
    >
      <File file={file} options={options} />
      <CopyButton text={code} label="Copy code" />
    </div>
  )
}

export { CodeBlock, CodeBlockProvider, CopyButton, useCodeBlockConfig }
