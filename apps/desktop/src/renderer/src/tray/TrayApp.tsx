import { useCallback, useEffect, useState } from 'react'
import { isLive } from '@canopy/shared'
import { TrayPanel } from '@canopy/ui/tray'

import type { TrayAction, TraySnapshot } from '../../../shared/tray'

const EMPTY: TraySnapshot = { status: 'connecting', error: null, projects: [], worktrees: [], machine: null }

/**
 * The menu-bar panel's host. It owns no state of its own: the main process holds the daemon
 * connection and pushes snapshots, and every action goes back the same way — so the icon keeps
 * telling the truth while this window is hidden.
 */
export default function TrayApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<TraySnapshot>(EMPTY)

  useEffect(() => {
    let pushed = false
    const off = window.canopyTray.onChange((next) => {
      pushed = true
      setSnapshot(next)
    })
    // The seed is only a seed: a change that arrives first is newer than what it will resolve with.
    void window.canopyTray.snapshot().then((initial) => {
      if (!pushed) setSnapshot(initial)
    })
    return off
  }, [])

  /** Actions report the daemon's message instead of throwing, so rows can show it inline. */
  const run = useCallback(async (action: TrayAction): Promise<string | null> => {
    const result = await window.canopyTray.run(action)
    return result.ok ? null : result.error
  }, [])

  const stopAll = useCallback(async (): Promise<string | null> => {
    const running = new Set(snapshot.worktrees.filter((worktree) => isLive(worktree.environment.state)).map((worktree) => worktree.projectId))
    const failures: string[] = []
    // The daemon stops a project at a time; the panel's button is the fleet-wide verb.
    for (const projectId of running) {
      const failure = await run({ kind: 'stop-all', projectId })
      if (failure) failures.push(failure)
    }
    return failures.length > 0 ? failures[0]! : null
  }, [run, snapshot.worktrees])

  return (
    <TrayPanel
      status={snapshot.status}
      error={snapshot.error}
      projects={snapshot.projects}
      worktrees={snapshot.worktrees}
      machine={snapshot.machine}
      daemonHint="Start it with ./dev.sh daemon — the panel reconnects on its own."
      onLifecycle={(worktreeId, action) => run({ kind: action, worktreeId })}
      onService={(worktreeId, service, action) => run({ kind: 'service', worktreeId, service, action })}
      onOpen={(worktreeId, target) => run({ kind: 'open', worktreeId, target })}
      onStopAll={stopAll}
      onOpenApp={window.canopyTray.openApp}
      onOpenExternal={window.canopyTray.openExternal}
      onRetry={window.canopyTray.retry}
      onDismiss={window.canopyTray.hide}
      onQuit={window.canopyTray.quit}
      onHeight={window.canopyTray.resize}
    />
  )
}
