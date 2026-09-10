/**
 * The contract between the menu-bar's three halves: TrayState in the main process produces the
 * snapshot, the preload bridge carries it, and the panel renders it. Everything in the snapshot
 * is a daemon wire type — the tray adds no model of its own beyond connection status.
 */
import type { Project, ServiceAction, OpenTarget, Worktree } from '@canopy/shared'

export type TrayStatus = 'connecting' | 'connected' | 'offline'

export interface TraySnapshot {
  status: TrayStatus
  /** Why the daemon is unreachable; null while connected. */
  error: string | null
  projects: Project[]
  worktrees: Worktree[]
  /** What the meters measure Canopy against; null until the daemon has been asked. */
  machine: { cores: number; memMb: number } | null
}

/** Everything the panel can ask the daemon to do. Each maps to one client call. */
export type TrayAction =
  | { kind: 'start'; worktreeId: string }
  | { kind: 'stop'; worktreeId: string }
  | { kind: 'restart'; worktreeId: string }
  /** First run for a worktree Canopy has never provisioned; starts services when it lands. */
  | { kind: 'provision'; worktreeId: string }
  | { kind: 'service'; worktreeId: string; service: string; action: ServiceAction }
  | { kind: 'open'; worktreeId: string; target: OpenTarget }
  | { kind: 'stop-all'; projectId: string }

/** Actions report the daemon's message rather than rejecting, so the panel can show it inline. */
export type TrayActionResult = { ok: true } | { ok: false; error: string }

export const TRAY_CHANNELS = {
  /** invoke → TraySnapshot */
  snapshot: 'tray:snapshot',
  /** main → panel, on every change */
  changed: 'tray:changed',
  /** invoke(TrayAction) → TrayActionResult */
  action: 'tray:action',
  /** invoke(hash) — focus the app window on a route */
  openApp: 'tray:open-app',
  /** invoke(url) — hand a service URL to the browser */
  openExternal: 'tray:open-external',
  hide: 'tray:hide',
  /** send(height) — hug the rendered content */
  resize: 'tray:resize',
  /** send() — stop waiting out the reconnect backoff */
  retry: 'tray:retry',
  quit: 'tray:quit'
} as const
