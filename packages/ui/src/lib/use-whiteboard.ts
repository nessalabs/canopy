import { useEffect, useMemo, useRef, useState } from 'react'

import { boxKey, boxMessage, decisionMessage, foldPlan, quoteMessage, taskMessage, type BoxRef, type Choice, type PlanView, type WhiteboardMode } from '@canopy/shared'
import type { AgentEvent } from '@canopy/shared/agent-stream'
import { AgentEventType, isEvent } from '@canopy/shared/agent-stream'

import { replayBefore, type TranscriptModel } from './use-transcript-model'
import type { WorktreeAgent } from './use-worktree-agent'
import { boxInfo, DEEPER, detailBoard, nextMode, notesCount, notesMessage, PLAN_EVENTS, readLayout, readNotes, sessionCost, writeLayout, writeNotes, type BoardLayout, type BoxNotes } from './whiteboard'

/**
 * The whiteboard of the conversation on screen: the plan its transcript adds up to (replay plus the
 * live turn), the approval it may be waiting on, and the actions a box offers — each a message to
 * the agent in whiteboard mode.
 */
export function useWhiteboard(agent: WorktreeAgent, model: TranscriptModel) {
  const history = agent.history.data
  const live = agent.turn.events
  // Streaming tokens arrive as events too; the plan only moves on calls and prompts, so the fold is
  // keyed on those alone.
  const relevant = useMemo(
    () => [...replayBefore(history?.events ?? [], live[0]?.seq), ...live].filter((event: AgentEvent) => PLAN_EVENTS.has(event.payload.type)),
    [history, live]
  )
  const signature = `${relevant.length}:${relevant.at(-1)?.id ?? ''}`
  const view: PlanView = useMemo(() => foldPlan(relevant), [signature])

  // Approving the plan (in the transcript or on the board) starts the build: later turns say so. Only
  // the moment of approval switches, so the reader can still go back to planning afterwards — and
  // approve again, which counts as a new moment.
  const sessionId = agent.selected?.sessionId
  const seen = useRef({ sessionId, approvals: view.approvals })
  useEffect(() => {
    if (seen.current.sessionId === sessionId && view.approvals > seen.current.approvals) agent.setWhiteboard(nextMode(agent.whiteboard, true))
    seen.current = { sessionId, approvals: view.approvals }
  }, [view.approvals, sessionId])

  const approval = model.transcript.pendingAsks.find((ask) => ask.agentPath.length === 0 && isEvent(ask, AgentEventType.PermissionRequested) && ask.payload.toolName === 'ExitPlanMode')

  // A turn without the board tools cannot draw: a message from the board waits until it ends.
  const waiting = agent.turn.busy && agent.whiteboard === undefined

  /** A message from the board: in whiteboard mode even when the composer is not, so the answer can draw. */
  const send = (text: string, display: string, mode?: WhiteboardMode): void => {
    if (waiting) return
    const drawing = mode ?? agent.whiteboard ?? 'explain'
    if (!agent.whiteboard) agent.setWhiteboard(drawing)
    const shown = { display, attachments: [], images: [] }
    // A running turn takes the message as it is — it already runs in whiteboard mode.
    void (agent.turn.busy ? agent.turn.queueMessage(text, shown) : agent.turn.sendMessage(text, { ...shown, options: { whiteboard: drawing } }))
  }

  // Notes and where boards were dragged stay in this browser, per session.
  const [notes, setNotesState] = useState<BoxNotes>(() => readNotes(sessionId))
  const [moved, setMoved] = useState<BoardLayout>(() => readLayout(sessionId))
  useEffect(() => {
    setNotesState(readNotes(sessionId))
    setMoved(readLayout(sessionId))
  }, [sessionId])
  const move = (board: string, at: { x: number; y: number }): void => {
    const next = { ...moved, [board]: at }
    setMoved(next)
    if (sessionId) writeLayout(sessionId, next)
  }
  const setNotes = (next: BoxNotes): void => {
    setNotesState(next)
    if (sessionId) writeNotes(sessionId, next)
  }
  const editNotes = (ref: BoxRef, change: (list: readonly string[]) => readonly string[]): void => setNotes({ ...notes, [boxKey(ref)]: change(notes[boxKey(ref)] ?? []) })

  /**
   * Every note at once. While the plan waits for approval the notes are the reason not to approve
   * yet, so they go back as "keep planning"; otherwise they are the next message.
   */
  const sendNotes = (): void => {
    if (notesCount(notes) === 0) return
    const { title, brief } = notesMessage(view.state, notes)
    if (approval && isEvent(approval, AgentEventType.PermissionRequested)) agent.turn.answerPermission({ requestId: approval.payload.requestId, behavior: 'deny', message: `Not yet — keep planning. ${brief}` })
    // A turn that cannot take the message keeps the notes, for when it can.
    else if (waiting) return
    else send(taskMessage(title, brief), title)
    setNotes({})
  }

  return {
    view,
    approval,
    mode: agent.whiteboard,
    waiting,
    moved,
    move,
    cost: useMemo(() => sessionCost(model.transcript.turns), [model.transcript.turns]),
    ask: (ref: BoxRef, label: string, question: string) => send(boxMessage(ref, label, question), `About ${label}: ${question}`),
    deeper: (ref: BoxRef, label: string) => send(boxMessage(ref, label, DEEPER), `Go deeper into ${label}`),
    /**
     * Into a box: its detail board when it has one (`show` brings it up), else the agent is asked to
     * draw it. Answers what happened, so the host can show the box while the drawing is on its way.
     */
    drill: (ref: BoxRef, show: (board: string) => void): 'shown' | 'asked' | 'none' => {
      const detail = detailBoard(view.state, ref)
      if (detail) {
        show(detail.id)
        return 'shown'
      }
      const label = boxInfo(view.state, ref)?.node.label
      if (!label) return 'none'
      send(boxMessage(ref, label, DEEPER), `Go deeper into ${label}`)
      return 'asked'
    },
    /** A question about a passage the reader selected on a board (`ref` its id) or in the plan document (`plan`). */
    quote: (ref: string, passage: string, question: string = EXPLAIN_PASSAGE) => send(quoteMessage(ref, passage, question), question),
    /** The reader's choices on decision cards, all in one message so the agent carries on once. */
    decide: (choices: readonly Choice[]) => send(decisionMessage(choices), choices.map((choice) => `Chose “${choice.label}”`).join(' · ')),
    notes,
    addNote: (ref: BoxRef, note: string) => editNotes(ref, (list) => [...list, note]),
    removeNote: (ref: BoxRef, index: number) => editNotes(ref, (list) => list.filter((_, at) => at !== index)),
    sendNotes
  }
}

/** What "Ask the agent" on a selected passage asks, unless the reader writes their own question. */
export const EXPLAIN_PASSAGE = 'Explain this in simple words: what it is, and how it fits in.'

export type Whiteboard = ReturnType<typeof useWhiteboard>
