import * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

interface JsonTreeSettings {
  collapsible: boolean
  defaultExpandedDepth: number
}

const JsonTreeContext = React.createContext<JsonTreeSettings>({
  collapsible: false,
  defaultExpandedDepth: Number.POSITIVE_INFINITY,
})

/**
 * Only arrays and plain objects recurse as containers; class instances
 * (Date, Map, hosts' richer values) render as the leaf JSON.stringify would
 * produce for them, mirroring what the payload would actually serialize to.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Describes a container value's brackets and entries, or null for leaves. */
function containerOf(value: unknown) {
  if (Array.isArray(value)) {
    return {
      open: "[",
      close: "]",
      unit: "item",
      // Array.from visits holes too — a sparse array must not render fewer
      // rows than its folded count reports. Holes and explicit undefined
      // both serialize as null inside an array, so that is what they show.
      entries: Array.from(value, (entry, index) => ({
        key: String(index),
        name: null as string | null,
        value: (entry === undefined ? null : entry) as unknown,
      })),
    }
  }
  if (isPlainObject(value)) {
    // Object.entries invokes getters; a host object with a throwing getter
    // degrades to a leaf instead of taking down the surface mid-render.
    let entries: [string, unknown][]
    try {
      entries = Object.entries(value)
    } catch {
      return null
    }
    return {
      open: "{",
      close: "}",
      unit: "key",
      entries: entries.map(([name, entry]) => ({
        key: name,
        name,
        value: entry,
      })),
    }
  }
  return null
}

/** Formats a leaf the way JSON prints it; non-JSON values degrade safely. */
function leafText(value: unknown) {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "function") return "[function]"
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return "[unserializable]"
    }
  }
  return String(value)
}

/**
 * Hosts pass arbitrary objects, not just parsed JSON, so rendering is
 * bounded on every axis: a value already on its own ancestor path renders
 * as a circular marker instead of recursing forever, containers past the
 * depth cap render as their folded summary, and containers wider than the
 * entry cap render their head plus an explicit overflow row — the person
 * always sees that more exists, and the surface never freezes building
 * tens of thousands of rows.
 */
const maxRenderDepth = 64
const maxEntriesPerContainer = 500

/** The quoted key plus colon leading an entry; keys tint muted so values pop. */
function JsonTreeKey({ name }: { name: string | null }) {
  if (name === null) return null
  return (
    <span className="text-muted-foreground">
      <span data-slot="json-tree-key">&quot;{name}&quot;</span>
      {": "}
    </span>
  )
}

/** A folded container's brackets and entry count, e.g. `{…} 4 keys`. */
function JsonTreeFoldedSummary({
  container,
}: {
  container: NonNullable<ReturnType<typeof containerOf>>
}) {
  return (
    <>
      {`${container.open}…${container.close} `}
      <span data-slot="json-tree-count" className="text-muted-foreground">
        {container.entries.length}{" "}
        {container.entries.length === 1
          ? container.unit
          : `${container.unit}s`}
      </span>
    </>
  )
}

function JsonTreeNode({
  name,
  value,
  depth,
  ancestors,
}: {
  name: string | null
  value: unknown
  depth: number
  /** The container values on this node's path, for cycle detection. */
  ancestors: readonly object[]
}) {
  const { collapsible, defaultExpandedDepth } =
    React.useContext(JsonTreeContext)
  const [expanded, setExpanded] = React.useState(depth < defaultExpandedDepth)
  const circular =
    typeof value === "object" && value !== null && ancestors.includes(value)
  const capped = !circular && depth >= maxRenderDepth
  const container = circular ? null : containerOf(value)
  // When toggles exist every row leads with a 1rem cell, so primitive keys
  // stay aligned with container keys whether or not a chevron is present.
  const leadingCell = collapsible ? (
    container && !capped ? (
      <button
        type="button"
        data-slot="json-tree-toggle"
        aria-expanded={expanded}
        aria-label={name === null ? "Toggle item" : `Toggle ${name}`}
        title={name === null ? "Toggle item" : `Toggle ${name}`}
        onClick={() => setExpanded((current) => !current)}
        className="flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground outline-none transition-colors [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] hover:text-foreground focus-visible:[outline-style:solid] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 transition-transform [transition-duration:var(--nessa-motion-duration-fast)] [transition-timing-function:var(--nessa-motion-easing-standard)] motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
      </button>
    ) : (
      <span aria-hidden="true" className="size-4 shrink-0" />
    )
  ) : null
  if (!container) {
    return (
      <div
        data-slot="json-tree-row"
        className="flex min-w-0 items-start gap-1"
      >
        {leadingCell}
        <span className="min-w-0 break-words">
          <JsonTreeKey name={name} />
          <span data-slot="json-tree-value">
            {circular ? "[Circular]" : leafText(value)}
          </span>
        </span>
      </div>
    )
  }
  // Past the depth cap a container renders as its folded summary — never a
  // serialized dump of the remaining subtree, which could be enormous.
  if (capped) {
    return (
      <div data-slot="json-tree-row" className="flex min-w-0 items-start gap-1">
        {leadingCell}
        <span className="min-w-0 break-words">
          <JsonTreeKey name={name} />
          <JsonTreeFoldedSummary container={container} />
        </span>
      </div>
    )
  }
  const open = !collapsible || expanded
  return (
    <div data-slot="json-tree-node" className="min-w-0">
      <div data-slot="json-tree-row" className="flex min-w-0 items-start gap-1">
        {leadingCell}
        <span className="min-w-0 break-words">
          <JsonTreeKey name={name} />
          {open ? (
            container.open
          ) : (
            <JsonTreeFoldedSummary container={container} />
          )}
        </span>
      </div>
      {open && (
        <>
          <div data-slot="json-tree-children" className="pl-4">
            {container.entries
              .slice(0, maxEntriesPerContainer)
              .map((entry) => (
                <JsonTreeNode
                  key={entry.key}
                  name={entry.name}
                  value={entry.value}
                  depth={depth + 1}
                  ancestors={[...ancestors, value as object]}
                />
              ))}
            {container.entries.length > maxEntriesPerContainer && (
              <div
                data-slot="json-tree-overflow"
                className="flex min-w-0 items-start gap-1 text-muted-foreground"
              >
                {collapsible && (
                  <span aria-hidden="true" className="size-4 shrink-0" />
                )}
                <span className="min-w-0 break-words">
                  …{container.entries.length - maxEntriesPerContainer} more{" "}
                  {container.entries.length - maxEntriesPerContainer === 1
                    ? container.unit
                    : `${container.unit}s`}{" "}
                  not shown
                </span>
              </div>
            )}
          </div>
          <div
            data-slot="json-tree-row"
            className="flex min-w-0 items-start gap-1"
          >
            {collapsible && <span aria-hidden="true" className="size-4 shrink-0" />}
            <span>{container.close}</span>
          </div>
        </>
      )}
    </div>
  )
}

export interface JsonTreeProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /**
   * The already-parsed value to render. Parsing a JSON string is the host's
   * job — a string here renders as a string leaf, quotes and all.
   */
  value: unknown
  /**
   * Renders a disclosure chevron on every object and array so the person can
   * fold branches away. Off by default: the static render has no focusable
   * parts, which is what consent surfaces that must show everything want.
   */
  collapsible?: boolean
  /**
   * With `collapsible`, containers at this depth or deeper start folded —
   * `1` shows only the top level. Everything starts open by default.
   */
  defaultExpandedDepth?: number
}

/**
 * A structured JSON renderer: keys tint muted so values carry the emphasis,
 * containers indent with real JSON punctuation, and the text stays real and
 * selectable. With `collapsible`, every branch gains a disclosure toggle;
 * fold state is per-node and uncontrolled, so hosts showing a NEW payload
 * should re-key the tree — reconciling different data into old nodes would
 * inherit their fold state. Circular references render as a `[Circular]`
 * marker instead of recursing. The surface is deliberately unopinionated —
 * monospace at the small size, semantic tokens only — and every part carries
 * a `data-slot` (`json-tree`, `-row`, `-key`, `-value`, `-count`, `-toggle`,
 * `-children`, `-overflow`) so hosts can restyle it for whatever surface it
 * lands on.
 */
function JsonTree({
  value,
  collapsible = false,
  defaultExpandedDepth = Number.POSITIVE_INFINITY,
  className,
  ...props
}: JsonTreeProps) {
  const settings = React.useMemo(
    () => ({ collapsible, defaultExpandedDepth }),
    [collapsible, defaultExpandedDepth],
  )
  return (
    <div
      data-slot="json-tree"
      data-collapsible={collapsible ? "true" : undefined}
      className={cn(
        "min-w-0 font-mono nessa-text-2 leading-5 text-foreground",
        className,
      )}
      {...props}
    >
      <JsonTreeContext.Provider value={settings}>
        <JsonTreeNode name={null} value={value} depth={0} ancestors={[]} />
      </JsonTreeContext.Provider>
    </div>
  )
}

export { JsonTree }
