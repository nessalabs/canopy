import { useState } from 'react'

import { boxKey } from '@canopy/shared'
import type { Turn } from '@canopy/shared/agent-stream'

import type { Whiteboard } from '@/lib/use-whiteboard'
import { boxInfo, threadOf } from '@/lib/whiteboard'

import { BoardSheet } from './board-card'
import { BoxInspector } from './box-inspector'

/**
 * One board in a panel of its own, opened beside the whiteboard so a detail can be read while the
 * big picture stays on screen. Several can be open at once; each keeps its own picked box.
 */
export function BoardPane({
  whiteboard,
  boardId,
  turns,
  busy,
  onOpenBoard,
  onOpenRef,
  onShowChanges
}: {
  whiteboard: Whiteboard
  boardId: string
  turns: readonly Turn[]
  busy: boolean
  /** Opens another board — a parent, or a box's detail board — in a panel of its own. */
  onOpenBoard: (board: string) => void
  onOpenRef?: (ref: string) => void
  /** Shows what the build changed in a box's files. */
  onShowChanges?: (files: string[]) => void
}): React.JSX.Element {
  const { state, threads } = whiteboard.view
  const board = state.boards[boardId]
  const [box, setBox] = useState<string>()
  if (!board) return <p className="p-4 text-xs text-muted-foreground">This board is not in the conversation on screen.</p>
  const ref = box ? { board: boardId, box } : undefined
  const info = ref && boxInfo(state, ref)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <BoardSheet
          board={board}
          state={state}
          onDecide={whiteboard.decide}
          selectedBox={box}
          onSelectBox={setBox}
          onOpenBox={(id) => {
            setBox(id)
            whiteboard.drill({ board: boardId, box: id }, onOpenBoard)
          }}
          onOpenParent={board.parent ? () => onOpenBoard(board.parent!.board) : undefined}
        />
      </div>
      {info ? (
        <BoxInspector
          info={info}
          thread={threadOf(turns, threads[boxKey(info.ref)])}
          busy={busy}
          waiting={whiteboard.waiting}
          onAsk={(question) => whiteboard.ask(info.ref, info.node.label, question)}
          onDeeper={() => whiteboard.deeper(info.ref, info.node.label)}
          onOpenDetail={() => info.detail && onOpenBoard(info.detail)}
          onOpenRef={onOpenRef}
          onShowChanges={onShowChanges}
          notes={whiteboard.notes[boxKey(info.ref)] ?? []}
          onAddNote={(note) => whiteboard.addNote(info.ref, note)}
          onRemoveNote={(index) => whiteboard.removeNote(info.ref, index)}
          onClose={() => setBox(undefined)}
          className="max-h-[55%] border-t border-l-0"
        />
      ) : null}
    </div>
  )
}
