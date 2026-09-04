import * as React from "react"
import { parsePatchFiles } from "@pierre/diffs"
import type {
  DiffLineAnnotation,
  DiffsThemeNames,
  FileDiffMetadata,
  FileDiffOptions,
  GetHoveredLineResult,
  SelectedLineRange,
  ThemesType,
} from "@pierre/diffs"
import { FileDiff } from "@pierre/diffs/react"

import { cn } from "@/lib/utils"
import { useCodeBlockConfig, type CodeBlockMode } from "./code-block"

/** @responsibility Renders a single-file code diff on Pierre's engine — unified or split, Nessa-themed — with typed passthroughs for line annotations, the gutter comment utility, and header metadata. */

/**
 * `"unified"` interleaves old and new lines in one column; `"split"` puts
 * the old file on the left and the new file on the right.
 */
export type DiffViewMode = "unified" | "split"

/**
 * The default syntax theme pair, mirroring CodeBlock's defaults so diffs
 * match every other code surface (Nessa's restrained near-black dark theme
 * and Light+, both chosen to keep WCAG AA contrast on diff-wash rows).
 */
const defaultDiffTheme: ThemesType = {
  dark: "nessa-dark",
  light: "light-plus",
}

export interface DiffViewProps<TAnnotation = undefined>
  extends Omit<React.ComponentProps<"div">, "children"> {
  /**
   * A unified patch string (git or plain unified format). The first file
   * of the first patch renders; parse a multi-file patch yourself with
   * `parsePatchFiles` (re-exported below) and render one DiffView per
   * file. Ignored when `fileDiff` is given; nothing renders while neither
   * source is present or the patch has no parseable file.
   */
  patch?: string
  /**
   * An already-parsed file diff — the shape `parsePatchFiles` and
   * `parseDiffFromFile` return. Takes precedence over `patch`, and is the
   * cheaper input when the host already parsed the patch once (to build a
   * file list, count changes, key comment stores). Pierre caches highlight
   * results by the diff's `cacheKey`, so when showing different revisions
   * of the same file path over time, give each revision a distinct
   * `cacheKey` (the `patch` input derives one from the content for you).
   */
  fileDiff?: FileDiffMetadata
  /** Layout: one interleaved column (default) or old/new side by side. */
  mode?: DiffViewMode
  /**
   * The syntax theme: a single Shiki theme name or a `{ dark, light }`
   * pair. Resolves from this prop, then the nearest CodeBlockProvider,
   * then Nessa's default pair — so diffs follow the same app-wide code
   * theming as every other code surface.
   */
  theme?: DiffsThemeNames | ThemesType
  /**
   * Which side of the theme pair renders: `system` follows the OS scheme,
   * `light` and `dark` pin one side. Falls back to the nearest
   * CodeBlockProvider's `mode`, then `system`.
   */
  colorMode?: CodeBlockMode
  /**
   * Line-number gutters. Resolves from this prop, then the nearest
   * CodeBlockProvider's `lineNumbers`, then on — reviews talk in line
   * numbers, so a provider configured for bare snippets hides diff
   * gutters too; pass `lineNumbers` here to override it.
   */
  lineNumbers?: boolean
  /**
   * Wrap long lines instead of scrolling horizontally. Resolves from this
   * prop, then the nearest CodeBlockProvider's `wrap`, then off — code
   * keeps its shape and the scroll stays contained inside the diff.
   */
  wrap?: boolean
  /**
   * Anchors for host-owned comment threads: each entry names a side
   * (`"deletions"` or `"additions"`), a line number in that side's file,
   * and whatever `metadata` the host's store carries (`TAnnotation`).
   * Rendered by `renderAnnotation` in order, full-width under their lines.
   */
  lineAnnotations?: readonly DiffLineAnnotation<TAnnotation>[]
  /**
   * Renders one entry of `lineAnnotations` — a comment thread, a composer.
   * The result renders in the host's own React tree (slotted under the
   * diff line), so state, context, and event handlers all work normally.
   */
  renderAnnotation?: (
    annotation: DiffLineAnnotation<TAnnotation>,
  ) => React.ReactNode
  /**
   * Whether the hover-revealed per-line gutter button — the "add a
   * comment on this line" affordance — shows at all. Defaults to true,
   * but the button only exists while one of the two gutter APIs below is
   * provided; pass `false` to hide it (a read-only review) without
   * unwiring the handlers.
   */
  enableGutterUtility?: boolean
  /**
   * Gutter API one: keep DiffView's accessible default button (labelled
   * "Comment on this line") and receive its clicks as the line range —
   * line number plus which side (`"deletions"` or `"additions"`) it names.
   * The host opens its composer and, once a comment exists, feeds it back
   * through `lineAnnotations`. Unused when `renderGutterUtility` is given.
   */
  onGutterUtilityClick?: (range: SelectedLineRange) => void
  /**
   * Gutter API two: replace the button entirely and own its behavior —
   * attach your handlers to what you render and read the target line
   * with `getHoveredLine` (line number plus side) when they fire. Takes
   * precedence over `onGutterUtilityClick`.
   */
  renderGutterUtility?: (
    getHoveredLine: () => GetHoveredLineResult<"diff"> | undefined,
  ) => React.ReactNode
  /**
   * Right-aligned slot in the file header — the place for change stats
   * (a DiffStat), a status badge, or review controls. The header itself
   * always renders; DiffView deliberately never disables it.
   */
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => React.ReactNode
}

/**
 * A stable content-derived cache prefix for patch-string input, so two
 * different patches can never share Pierre's highlight cache entry while
 * identical content still reuses it. (FNV-1a over the patch text.)
 */
function patchCacheKeyPrefix(patch: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `nessa-diff-${(hash >>> 0).toString(36)}`
}

/**
 * The accessible default gutter utility: a labelled button that reads the
 * hovered line at click time and reports it as a single-line range.
 * (Pierre's own default button has no accessible name, so DiffView always
 * renders this one — or the host's `renderGutterUtility` — instead.)
 */
function DefaultGutterUtility({
  getHoveredLine,
  onGutterUtilityClick,
}: {
  getHoveredLine: () => GetHoveredLineResult<"diff"> | undefined
  onGutterUtilityClick: (range: SelectedLineRange) => void
}) {
  return (
    <button
      type="button"
      aria-label="Comment on this line"
      data-slot="diff-view-gutter-utility"
      // before: expands the hit target to ~24px while the visible chip
      // stays gutter-sized.
      className="relative flex size-4 cursor-pointer items-center justify-center rounded-sm border-0 bg-primary font-sans nessa-text-2 leading-none text-primary-foreground outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={() => {
        const hovered = getHoveredLine()
        if (hovered === undefined) return
        onGutterUtilityClick({
          start: hovered.lineNumber,
          end: hovered.lineNumber,
          side: hovered.side,
        })
      }}
    >
      <span aria-hidden="true">+</span>
    </button>
  )
}

/**
 * A single-file code-diff renderer on Pierre's engine: syntax-highlighted
 * unified or split layouts, line-number gutters, semantic add/delete row
 * washes, and horizontal scrolling contained inside the diff. Theming
 * resolves like CodeBlock's — props first, then the nearest
 * CodeBlockProvider, then Nessa's dark/light pair — so diffs match every
 * other code surface in the app.
 *
 * Commenting stays with the host: `lineAnnotations` anchors host-rendered
 * threads under their lines, and the gutter utility (enable it, handle its
 * click) is the "comment on this line" affordance. DiffView owns no
 * comment state.
 *
 * Feed it a unified `patch` string or an already-parsed `fileDiff`. The
 * file header always renders, naming the file; put stats or controls in
 * it with `renderHeaderMetadata`.
 *
 * @param props - Diff source, layout, theming, and comment hooks plus host `div` props.
 * @returns The rendered diff inside a `data-slot="diff-view"` wrapper.
 */
function DiffView<TAnnotation = undefined>({
  patch,
  fileDiff,
  mode = "unified",
  theme,
  colorMode,
  lineNumbers,
  wrap,
  lineAnnotations,
  renderAnnotation,
  enableGutterUtility,
  onGutterUtilityClick,
  renderGutterUtility,
  renderHeaderMetadata,
  className,
  style,
  ...props
}: DiffViewProps<TAnnotation>) {
  const config = useCodeBlockConfig()
  const resolved = {
    theme: theme ?? config.theme ?? defaultDiffTheme,
    colorMode: colorMode ?? config.mode ?? "system",
    lineNumbers: lineNumbers ?? config.lineNumbers ?? true,
    wrap: wrap ?? config.wrap ?? false,
  }

  const resolvedDiff = React.useMemo(() => {
    if (fileDiff !== undefined) return fileDiff
    if (patch === undefined) return undefined
    return parsePatchFiles(patch, patchCacheKeyPrefix(patch))[0]?.files[0]
  }, [fileDiff, patch])

  const annotations = React.useMemo(
    () => (lineAnnotations === undefined ? undefined : [...lineAnnotations]),
    [lineAnnotations],
  )

  // Both gutter APIs funnel through Pierre's render slot: the host's
  // renderer verbatim, or the accessible default wired to the range
  // callback. Pierre's own onGutterUtilityClick option is never used —
  // its built-in button carries no accessible name.
  const gutterUtility = React.useMemo(() => {
    if (renderGutterUtility !== undefined) return renderGutterUtility
    if (onGutterUtilityClick === undefined) return undefined
    return (getHoveredLine: () => GetHoveredLineResult<"diff"> | undefined) => (
      <DefaultGutterUtility
        getHoveredLine={getHoveredLine}
        onGutterUtilityClick={onGutterUtilityClick}
      />
    )
  }, [onGutterUtilityClick, renderGutterUtility])

  // The utility is on exactly while something renders into it: enabling
  // it with no gutter API wired would surface Pierre's unlabeled
  // fallback button, and an explicit `false` hides it without unwiring.
  const gutterUtilityEnabled =
    (enableGutterUtility ?? true) && gutterUtility !== undefined

  const options = React.useMemo<FileDiffOptions<TAnnotation>>(
    () => ({
      diffStyle: mode,
      disableLineNumbers: !resolved.lineNumbers,
      overflow: resolved.wrap ? ("wrap" as const) : ("scroll" as const),
      themeType: resolved.colorMode,
      theme: resolved.theme,
      enableGutterUtility: gutterUtilityEnabled,
    }),
    [
      gutterUtilityEnabled,
      mode,
      resolved.colorMode,
      resolved.lineNumbers,
      resolved.theme,
      resolved.wrap,
    ],
  )

  return (
    <div
      data-slot="diff-view"
      data-mode={mode}
      className={cn(
        "w-full min-w-0 max-w-full overflow-hidden rounded-xl nessa-text-3 leading-6",
        className,
      )}
      // Custom properties inherit through Pierre's shadow root. The light
      // change colors move onto the semantic diff tokens — Pierre's own
      // #0dbe4e/#ff2e3f header counters and line numbers sit below 4.5:1
      // on white — and the dark and wash overrides are ToolCallDiff's, so
      // the two diff surfaces match: a deepened dark addition green and
      // dark row washes carrying a stronger share of the change color,
      // keeping added and deleted lines legible on the near-black ground.
      style={
        {
          "--diffs-light-addition-color": "var(--nessa-diff-addition)",
          "--diffs-light-deletion-color": "var(--nessa-diff-deletion)",
          "--diffs-dark-addition-color": "var(--nessa-diff-dark-addition)",
          "--diffs-bg-addition-override":
            "light-dark(color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 68%, var(--diffs-addition-base)))",
          "--diffs-bg-deletion-override":
            "light-dark(color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 76%, var(--diffs-deletion-base)))",
          ...style,
        } as React.CSSProperties
      }
      {...props}
    >
      {resolvedDiff !== undefined ? (
        <FileDiff<TAnnotation>
          fileDiff={resolvedDiff}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={gutterUtility}
          renderHeaderMetadata={renderHeaderMetadata}
        />
      ) : null}
    </div>
  )
}

export { DiffView, parsePatchFiles }
export type {
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
}
