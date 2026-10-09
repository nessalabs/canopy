import { rounded, type ChangeMapBox, type ChangeMapPoint } from "../change-map/change-map-layout"

export interface CallFlowLayoutInput {
  participants: readonly { id: string; width: number }[]
  steps: readonly { from: string; to: string; labelWidth: number; branch?: string }[]
  headerHeight: number
  /** Room for one step: its label above, its arrow below. */
  rowHeight: number
  /** The narrowest gap between two participants' cards. */
  minGap: number
  /** How far a call to oneself loops out to the right. */
  loopWidth: number
  /** Room above a branch's first step for the branch's name. */
  branchLabelHeight: number
}

export interface CallFlowStepLayout {
  index: number
  /** The arrow's height; the number sits on the caller's lifeline here. */
  y: number
  fromX: number
  toX: number
  self: boolean
  path: string
  /** Where the label's centre goes (its left edge, for a call to oneself). */
  label: ChangeMapPoint
  /** How wide the label may draw before it is cut. */
  labelRoom: number
}

export interface CallFlowLayout {
  boxes: ReadonlyMap<string, ChangeMapBox>
  /** Each participant's lifeline, by the x it runs down. */
  lifelines: ReadonlyMap<string, number>
  steps: CallFlowStepLayout[]
  branches: { label: string; x: number; y: number; width: number; height: number }[]
  width: number
  height: number
}

/** Keeps a label clear of the lifelines it sits between. */
const LABEL_PAD = 24
/** The number's circle on the caller's lifeline; the arrow starts past it. */
const NUMBER_RADIUS = 10
const ARROW_FROM_TOP = 30
const BRANCH_PAD = 28

/**
 * A sequence of calls read left to right and top to bottom: participants as cards across the
 * top, each step a row whose arrow runs between two lifelines. Participants spread apart until
 * every label fits between the lifelines its arrow spans, so no label crosses a lifeline, and a
 * run of steps on the same branch is wrapped in a band named after it.
 */
export function layoutCallFlow({ participants, steps, headerHeight, rowHeight, minGap, loopWidth, branchLabelHeight }: CallFlowLayoutInput): CallFlowLayout {
  const order = new Map(participants.map((p, i) => [p.id, i]))
  const valid = steps.map((step, index) => ({ ...step, index, a: order.get(step.from), b: order.get(step.to) })).filter((step) => step.a !== undefined && step.b !== undefined) as Array<CallFlowLayoutInput["steps"][number] & { index: number; a: number; b: number }>

  // Centres left to right: past the previous card, and far enough from every earlier lifeline
  // that a label spanning to it fits. A call to oneself needs its loop and label before the next.
  const centres: number[] = []
  participants.forEach((p, i) => {
    let centre = i === 0 ? p.width / 2 : centres[i - 1]! + participants[i - 1]!.width / 2 + minGap + p.width / 2
    for (const step of valid) {
      const [lo, hi] = [Math.min(step.a, step.b), Math.max(step.a, step.b)]
      if (step.a === step.b && step.a === i - 1) centre = Math.max(centre, centres[i - 1]! + loopWidth + step.labelWidth + LABEL_PAD)
      else if (hi === i && lo < i) centre = Math.max(centre, centres[lo]! + step.labelWidth + LABEL_PAD + NUMBER_RADIUS)
    }
    centres.push(centre)
  })
  const boxes = new Map(participants.map((p, i) => [p.id, { x: centres[i]! - p.width / 2, y: 0, width: p.width, height: headerHeight }]))
  const lifelines = new Map(participants.map((p, i) => [p.id, centres[i]!]))

  let top = headerHeight + 16
  let previous: string | undefined
  const placed: CallFlowStepLayout[] = []
  const runs: Array<{ label: string; first: number; top: number; bottom: number; lo: number; hi: number }> = []
  for (const step of valid) {
    if (step.branch && step.branch !== previous) {
      top += branchLabelHeight
      runs.push({ label: step.branch, first: step.index, top: top - branchLabelHeight - 6, bottom: 0, lo: Infinity, hi: -Infinity })
    }
    previous = step.branch
    const self = step.a === step.b
    const y = top + ARROW_FROM_TOP
    const [fromX, toX] = [centres[step.a]!, centres[step.b]!]
    const dir = Math.sign(toX - fromX)
    const path = self
      ? rounded([{ x: fromX + NUMBER_RADIUS, y }, { x: fromX + loopWidth, y }, { x: fromX + loopWidth, y: y + 16 }, { x: fromX + 2, y: y + 16 }])
      : `M ${fromX + dir * NUMBER_RADIUS} ${y} L ${toX - dir * 2} ${y}`
    placed.push({
      index: step.index,
      y,
      fromX,
      toX,
      self,
      path,
      label: self ? { x: fromX + loopWidth + 8, y: y + 8 } : { x: (fromX + toX) / 2, y: y - 14 },
      labelRoom: self ? step.labelWidth + 8 : Math.abs(toX - fromX) - LABEL_PAD,
    })
    top += self ? rowHeight + 18 : rowHeight
    const run = step.branch ? runs.at(-1) : undefined
    if (run) {
      run.bottom = top
      run.lo = Math.min(run.lo, fromX, toX)
      run.hi = Math.max(run.hi, self ? fromX + loopWidth + step.labelWidth + 8 : Math.max(fromX, toX))
    }
  }

  const branches = runs.map((run) => ({ label: run.label, x: run.lo - BRANCH_PAD, y: run.top, width: run.hi - run.lo + BRANCH_PAD * 2, height: run.bottom - run.top }))
  const last = participants.length - 1
  const width = Math.max(
    last < 0 ? 0 : centres[last]! + participants[last]!.width / 2,
    ...placed.filter((s) => s.self).map((s) => s.label.x + s.labelRoom),
    ...branches.map((b) => b.x + b.width),
  )
  return { boxes, lifelines, steps: placed, branches, width, height: top + 8 }
}
