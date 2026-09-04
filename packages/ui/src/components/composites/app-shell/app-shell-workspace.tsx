"use client"

/** @responsibility Renders the recursive workspace tree as nested SplitViews and routes pane focus and resizes back to the layout document. */

import * as React from "react"

import { cn } from "@/lib/utils"
import {
  SplitView,
  SplitViewPanel,
  SplitViewSeparator,
  type SplitViewLayout,
  type SplitViewSize,
} from "@/components/split-view"
import {
  PaneDropRegion,
  findNode,
  setSplitWeights,
  focusPane,
  type LayoutNode,
  type LayoutNodeId,
  type PaneNode,
  type SplitNode,
} from "@/lib/app-shell-layout"

import { useAppShellContext } from "./app-shell"
import { AppShellDragProvider, useAppShellDrag } from "./app-shell-drag"

/** Properties accepted by the workspace region. */
interface AppShellWorkspaceProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /**
   * Renders the content of one pane. Receives the pane node; resolve its
   * views to application content here. The layout document never holds
   * elements, so panes stay serializable.
   */
  renderPane: (pane: PaneNode) => React.ReactNode
  /**
   * Smallest size of every workspace pane: a percentage number, "Npx", or
   * "N%".
   * @defaultValue "96px"
   */
  minPaneSize?: SplitViewSize
  /**
   * Accessible name of every separator between workspace panes. Override it
   * to localize or reword what screen readers announce.
   * @defaultValue "Resize workspace panes"
   */
  separatorLabel?: string
}

/**
 * Renders one workspace pane shell with focus tracking.
 *
 * @param props - The pane node, active state, and the pane renderer.
 * @returns The pane container hosting application content.
 */
function WorkspacePane({
  pane,
  active,
  renderPane,
}: {
  pane: PaneNode
  active: boolean
  renderPane: AppShellWorkspaceProps["renderPane"]
}) {
  const { updateLayout } = useAppShellContext()
  const { draggingPaneId, dropTarget } = useAppShellDrag()

  /** Promotes this pane to the active pane when interaction enters it. */
  const activate = () => {
    if (!active) {
      updateLayout((current) => focusPane(current, { paneId: pane.id }), {
        operation: "focus",
        phase: "settled",
      })
    }
  }

  /**
   * Fills a preview container with a snapshot of another pane's content.
   * Used in both directions while a swap is being previewed: the target
   * shows the dragged pane's content, and the dragged pane's emptied slot
   * shows the target's content as the shadow moving in.
   *
   * @param element - The preview container, when mounted.
   * @param paneId - The pane whose content to snapshot.
   */
  const fillPreviewWith = (
    element: HTMLDivElement | null,
    paneId: LayoutNodeId | null,
  ) => {
    if (!element || paneId === null) return

    const workspace = element.closest('[data-slot="app-shell-workspace"]')
    const panes =
      workspace?.querySelectorAll<HTMLElement>('[data-slot="app-shell-pane"]') ??
      []
    const content = [...panes]
      .find((candidate) => candidate.dataset.paneId === paneId)
      ?.querySelector<HTMLElement>('[data-slot="app-shell-pane-content"]')

    if (!content) return

    const snapshot = content.cloneNode(true) as HTMLElement
    snapshot.removeAttribute("data-slot")
    snapshot.classList.remove("invisible")
    snapshot.style.width = "100%"
    snapshot.style.height = "100%"
    element.replaceChildren(snapshot)
  }

  const isDropTarget = dropTarget?.paneId === pane.id
  const isDragSource = draggingPaneId === pane.id
  // While a drag is running, panes not involved in it fade slightly so the
  // lifted source and the highlighted target stand out.
  const dimmed = draggingPaneId !== null && !isDragSource && !isDropTarget

  return (
    <div
      data-slot="app-shell-pane"
      data-pane-id={pane.id}
      data-active={active || undefined}
      data-drag-source={isDragSource || undefined}
      data-drag-dimmed={dimmed || undefined}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-opacity",
        "data-active:ring-1 data-active:ring-inset data-active:ring-ring/40",
        "data-drag-dimmed:opacity-75",
      )}
      onFocusCapture={activate}
      onPointerDownCapture={activate}
    >
      {/* While this pane is being dragged, its content lifts out — mounted
          (state survives) but invisible, with the emptied slot shown below.
          While this pane is hovered as the drop target, the swap preview's
          scrim fades it visually. */}
      <div
        data-slot="app-shell-pane-content"
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1 flex-col",
          isDragSource && "invisible",
        )}
      >
        {renderPane(pane)}
      </div>
      {isDragSource ? (
        // The emptied slot. While a target is hovered, the target pane's
        // content appears here as a faint shadow — the other half of the
        // swap being previewed.
        <div
          aria-hidden
          inert
          data-slot="app-shell-pane-lift"
          // Opaque, so nothing beneath can bleed through the preview.
          className="absolute inset-1 z-10 overflow-hidden rounded-md border-2 border-dashed border-ring/50 bg-muted"
        >
          {dropTarget ? (
            <div
              key={dropTarget.paneId}
              ref={(element) => fillPreviewWith(element, dropTarget.paneId)}
              className="h-full w-full bg-background opacity-60"
            />
          ) : null}
        </div>
      ) : null}
      {isDropTarget ? (
        // The whole pane highlights and previews the swap: an opaque card
        // fully covers this pane's own content (nothing bleeds through)
        // and shows the dragged pane's content in its place. Releasing
        // here swaps the two.
        <div
          aria-hidden
          inert
          data-slot="app-shell-drop-preview"
          className="pointer-events-none absolute inset-1 z-20 overflow-hidden rounded-md bg-background ring-2 ring-inset ring-ring/70"
        >
          <div
            ref={(element) => fillPreviewWith(element, draggingPaneId)}
            className="h-full w-full opacity-90"
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Renders one node of the workspace tree.
 *
 * Maximizing never removes anything. The other panes are simply rendered at
 * 0% width, so their content (scroll position, typed text, and so on) stays
 * alive and comes back untouched on restore:
 *
 * ```txt
 *   normal      │ A 30% │ B 40% │ C 30% │
 *   maximize B  │         B 100%        │   A and C still mounted, at 0%
 * ```
 *
 * The saved layout document is not touched either — the 100/0 sizes are
 * made up at render time from `maximizedPaneId`.
 *
 * @param props - The node, active and maximized pane ids, the pane
 * renderer, and the minimum pane size.
 * @returns The rendered subtree.
 */
function WorkspaceNode({
  node,
  activePaneId,
  maximizedPaneId,
  renderPane,
  minPaneSize,
  separatorLabel,
}: {
  node: LayoutNode
  activePaneId: LayoutNodeId
  maximizedPaneId: LayoutNodeId | undefined
  renderPane: AppShellWorkspaceProps["renderPane"]
  minPaneSize: SplitViewSize
  separatorLabel: string
}) {
  const { updateLayout } = useAppShellContext()

  if (node.type === "pane") {
    return (
      <WorkspacePane
        pane={node}
        active={node.id === activePaneId}
        renderPane={renderPane}
      />
    )
  }

  const split: SplitNode = node
  // The 100/0 sizing only applies to splits on the path to the maximized
  // pane. Splits inside hidden branches keep their normal proportions —
  // they are invisible anyway, and an all-zero layout would be unusable.
  const maximizing =
    maximizedPaneId !== undefined &&
    findNode(split, maximizedPaneId) !== undefined
  const layout: SplitViewLayout = {}

  for (const child of split.children) {
    layout[child.id] = maximizing
      ? findNode(child, maximizedPaneId) !== undefined
        ? 100
        : 0
      : child.weight * 100
  }

  /**
   * Writes a SplitView percentage layout back as sibling weights.
   *
   * @param next - The SplitView layout produced by an interaction.
   * @param phase - Whether the gesture is ongoing or settled.
   */
  const applyWeights = (next: SplitViewLayout, phase: "live" | "settled") => {
    if (maximizing) {
      return
    }

    updateLayout(
      (current) =>
        setSplitWeights(current, {
          splitId: split.id,
          weights: split.children.map(
            (child) => (next[child.id] ?? child.weight * 100) / 100,
          ),
        }),
      { operation: "pane-resize", phase },
    )
  }

  return (
    <SplitView
      orientation={split.orientation}
      layout={layout}
      onLayoutChange={(next) => applyWeights(next, "live")}
      onLayoutCommit={(next) => applyWeights(next, "settled")}
      className="h-full w-full"
    >
      {split.children.flatMap((child, index) => {
        const hiddenByMaximize = maximizing && layout[child.id] === 0

        const panel = (
          <SplitViewPanel
            key={child.id}
            id={child.id}
            minSize={maximizing ? 0 : minPaneSize}
            // Panes squeezed to zero width stay mounted (their content
            // state survives) but become inert: not tabbable and hidden
            // from screen readers until the workspace is restored.
            inert={hiddenByMaximize || undefined}
          >
            <WorkspaceNode
              node={child}
              activePaneId={activePaneId}
              maximizedPaneId={maximizedPaneId}
              renderPane={renderPane}
              minPaneSize={minPaneSize}
              separatorLabel={separatorLabel}
            />
          </SplitViewPanel>
        )

        if (index === 0) {
          return [panel]
        }

        return [
          <SplitViewSeparator
            key={`separator:${child.id}`}
            aria-label={separatorLabel}
            className={cn(maximizedPaneId !== undefined && "hidden")}
          />,
          panel,
        ]
      })}
    </SplitView>
  )
}

/**
 * Renders the shell's recursive center region. Panes and splits come from
 * the shared layout document; a maximized pane temporarily fills the whole
 * region while the document — and every mounted pane — stays untouched.
 *
 * @param props - The pane renderer, minimum pane size, and native container
 * properties.
 * @returns The workspace region bound to the shell's layout document.
 */
function AppShellWorkspace({
  renderPane,
  minPaneSize = "96px",
  separatorLabel = "Resize workspace panes",
  className,
  ...props
}: AppShellWorkspaceProps) {
  const { layout } = useAppShellContext()
  const { workspace } = layout
  const workspaceRef = React.useRef<HTMLDivElement>(null)

  return (
    <div
      ref={workspaceRef}
      data-slot="app-shell-workspace"
      data-maximized={workspace.maximizedPaneId !== undefined || undefined}
      className={cn("relative flex min-h-0 min-w-0 flex-1", className)}
      {...props}
    >
      <AppShellDragProvider workspaceRef={workspaceRef}>
        <WorkspaceNode
          node={workspace.root}
          activePaneId={workspace.activePaneId}
          maximizedPaneId={workspace.maximizedPaneId}
          renderPane={renderPane}
          minPaneSize={minPaneSize}
          separatorLabel={separatorLabel}
        />
      </AppShellDragProvider>
    </div>
  )
}

export { AppShellWorkspace, type AppShellWorkspaceProps }
