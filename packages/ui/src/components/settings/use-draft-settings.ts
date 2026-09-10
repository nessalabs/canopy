/**
 * Autosaving drafts for the settings screens. Every control edits a local copy and the changed
 * top-level slices are PATCHed 400 ms later, so typing in a text field is one request, not one
 * per keystroke. Arrays (hooks, copy rules, cache rules, env) always travel whole.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { AppSettings, AppSettingsPatch, ProjectSettings, ProjectSettingsPatch } from '@canopy/shared'

import { useAppSettings, useProjectSettings, useUpdateAppSettings, useUpdateProjectSettings } from '@/lib/api-hooks'

const DEBOUNCE_MS = 400

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface Draft<T> {
  /** The draft, or undefined until the first read lands. */
  settings: T | undefined
  /** Applies a change to the draft and schedules the PATCH. */
  update: (patch: (current: T) => T) => void
  status: SaveStatus
  error: unknown
}

/** The mutation surface a draft needs; both settings mutations satisfy it structurally. */
interface MutationLike<P> {
  mutate: (patch: P, options?: { onError?: () => void }) => void
  isPending: boolean
  isError: boolean
  isSuccess: boolean
  error: unknown
}

/** Top-level keys whose JSON changed. Both settings patches accept whole slices, so this is the patch. */
function slicePatch<T extends object>(base: T, next: T): Partial<T> {
  const patch: Partial<T> = {}
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) patch[key] = next[key]
  }
  return patch
}

/**
 * Shared machinery: hold a draft, diff it against what the daemon last confirmed, and write the
 * difference behind a debounce. Remount (a `key`) to switch to another subject — the pending
 * write is flushed on the way out.
 */
function useAutosave<T extends object, P extends object>(server: T | undefined, mutation: MutationLike<P>): Draft<T> {
  const [draft, setDraft] = useState<T | null>(null)
  const [dirty, setDirty] = useState(false)

  // Refs so the debounce timer can flush without being re-created on every keystroke.
  const current = useRef<T | null>(null)
  const baseline = useRef<T | null>(null)
  const pending = useRef<T | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mutate = useRef(mutation.mutate)

  current.current = draft ?? server ?? null
  mutate.current = mutation.mutate
  if (baseline.current === null && server !== undefined) baseline.current = server

  const flush = useCallback(() => {
    const next = pending.current
    const base = baseline.current
    pending.current = null
    if (!next || !base) return
    const patch = slicePatch(base, next) as unknown as P
    if (Object.keys(patch).length === 0) return
    baseline.current = next
    // A rejected PATCH never reached the daemon, so the baseline must go back or the next
    // edit would compute its diff against a slice the daemon does not have.
    mutate.current(patch, { onError: () => (baseline.current = base) })
  }, [])

  // Never lose the last keystroke when the screen closes inside the debounce window.
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      flush()
    },
    [flush]
  )

  const update = useCallback(
    (patch: (value: T) => T) => {
      const base = current.current
      if (!base) return
      const next = patch(base)
      current.current = next
      pending.current = next
      setDraft(next)
      setDirty(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        setDirty(false)
        flush()
      }, DEBOUNCE_MS)
    },
    [flush]
  )

  const status: SaveStatus = mutation.isError ? 'error' : dirty || mutation.isPending ? 'saving' : mutation.isSuccess ? 'saved' : 'idle'
  return { settings: draft ?? server, update, status, error: mutation.error }
}

/**
 * Autosaving draft of one project's Canopy settings. The screen mounts it under a `key` of the
 * project id, so switching projects starts a clean draft.
 */
export function useDraftSettings(projectId: string): Draft<ProjectSettings> {
  const query = useProjectSettings(projectId)
  const save = useUpdateProjectSettings(projectId)
  return useAutosave<ProjectSettings, ProjectSettingsPatch>(query.data, save)
}

/** Autosaving draft of the machine-level app settings. */
export function useDraftAppSettings(): Draft<AppSettings> {
  const query = useAppSettings()
  const save = useUpdateAppSettings()
  return useAutosave<AppSettings, AppSettingsPatch>(query.data, save)
}
