import * as React from "react"
import {
  Braces,
  Database,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileLock2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType2,
  FileVideo,
  Folder,
  FolderOpen,
  GitBranch,
  Package,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

/** The glyph and tint chosen for a file, resolved from its name. */
export interface FileIconSpec {
  Icon: LucideIcon
  /** Tailwind text color class; hues follow editor conventions (yellow JS, blue TS, …). */
  className: string
}

type Rule = readonly [names: readonly string[], spec: FileIconSpec]

/** Exact file names first (Dockerfile, package.json), then extensions. Lookup is case-insensitive. */
const BY_NAME: readonly Rule[] = [
  [["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"], { Icon: Package, className: "text-red-400" }],
  [["dockerfile", "docker-compose.yml", "docker-compose.yaml"], { Icon: FileCog, className: "text-sky-500" }],
  [[".gitignore", ".gitattributes", ".gitmodules"], { Icon: GitBranch, className: "text-orange-500" }],
  [[".env", ".env.local", ".env.example"], { Icon: FileLock2, className: "text-yellow-600" }],
]

const BY_EXTENSION: readonly Rule[] = [
  [["ts", "tsx", "mts", "cts"], { Icon: FileCode2, className: "text-blue-500" }],
  [["js", "jsx", "mjs", "cjs"], { Icon: FileCode2, className: "text-yellow-500" }],
  [["py", "pyi"], { Icon: FileCode2, className: "text-sky-400" }],
  [["rb"], { Icon: FileCode2, className: "text-red-500" }],
  [["go"], { Icon: FileCode2, className: "text-cyan-500" }],
  [["rs"], { Icon: FileCode2, className: "text-orange-600" }],
  [["java", "kt", "scala"], { Icon: FileCode2, className: "text-orange-500" }],
  [["c", "h", "cpp", "hpp", "cc", "cs", "swift"], { Icon: FileCode2, className: "text-violet-500" }],
  [["php"], { Icon: FileCode2, className: "text-indigo-400" }],
  [["html", "htm", "vue", "svelte", "astro"], { Icon: FileCode2, className: "text-orange-500" }],
  [["css", "scss", "sass", "less"], { Icon: Braces, className: "text-purple-500" }],
  [["json", "jsonc", "json5"], { Icon: FileJson, className: "text-yellow-600" }],
  [["yml", "yaml", "toml", "ini", "cfg", "conf"], { Icon: FileCog, className: "text-pink-500" }],
  [["md", "mdx", "rst", "txt"], { Icon: FileText, className: "text-sky-600" }],
  [["sh", "bash", "zsh", "fish", "ps1", "bat"], { Icon: FileTerminal, className: "text-green-600" }],
  [["sql", "db", "sqlite"], { Icon: Database, className: "text-amber-600" }],
  [["csv", "tsv", "xls", "xlsx"], { Icon: FileSpreadsheet, className: "text-green-600" }],
  [["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"], { Icon: FileImage, className: "text-fuchsia-500" }],
  [["mp4", "mov", "webm", "mkv"], { Icon: FileVideo, className: "text-rose-500" }],
  [["zip", "tar", "gz", "tgz", "bz2", "7z", "rar"], { Icon: FileArchive, className: "text-stone-500" }],
  [["ttf", "otf", "woff", "woff2"], { Icon: FileType2, className: "text-stone-500" }],
  [["lock"], { Icon: FileLock2, className: "text-stone-500" }],
]

const FALLBACK_FILE: FileIconSpec = { Icon: File, className: "text-muted-foreground" }
const FOLDER: FileIconSpec = { Icon: Folder, className: "text-sky-500" }
const FOLDER_OPEN: FileIconSpec = { Icon: FolderOpen, className: "text-sky-500" }

const lookup = (rules: readonly Rule[], key: string): FileIconSpec | undefined =>
  rules.find(([names]) => names.includes(key))?.[1]

/**
 * The icon and tint for a path or file name. Pure, so hosts can reuse the
 * mapping in tabs, chips, and trees alike.
 */
function fileIconFor(name: string, kind: "file" | "dir" = "file", expanded = false): FileIconSpec {
  if (kind === "dir") return expanded ? FOLDER_OPEN : FOLDER
  const base = (name.split("/").pop() ?? name).toLowerCase()
  const extension = base.includes(".") ? (base.split(".").pop() ?? "") : ""
  return lookup(BY_NAME, base) ?? lookup(BY_EXTENSION, extension) ?? FALLBACK_FILE
}

export interface FileIconProps extends Omit<React.ComponentProps<"svg">, "name"> {
  /** File name or path; the extension (or a well-known name) selects the glyph. */
  name: string
  /** Directories get a folder glyph, open or closed. @defaultValue "file" */
  kind?: "file" | "dir"
  /** Whether a directory is open. Ignored for files. */
  expanded?: boolean
}

/**
 * An editor-style file-type glyph — TypeScript, Python, JSON, images, folders
 * and so on — sized to sit inline with a file name. Decorative: the name next
 * to it carries the meaning, so the glyph is hidden from assistive tech.
 */
function FileIcon({ name, kind = "file", expanded = false, className, ...props }: FileIconProps) {
  const { Icon, className: tint } = fileIconFor(name, kind, expanded)
  return (
    <Icon
      data-slot="file-icon"
      data-kind={kind}
      aria-hidden="true"
      className={cn("size-4 shrink-0", tint, className)}
      {...props}
    />
  )
}

export { FileIcon, fileIconFor }
