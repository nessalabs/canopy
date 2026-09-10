import { useEffect } from 'react'
import type { SupportedLanguages } from '@pierre/diffs'

import { preloadCodeHighlighter } from '@/components/ui/code-block'
import { grammarsFor } from './language'

/**
 * Warms the highlighter for a change set while the user is still picking a file: the engine and
 * both themes load once per session, each grammar once, and all of it off the render path — so
 * opening a diff no longer waits on a chunk download before it can paint.
 */
export function useHighlighterWarmup(paths: readonly string[]): void {
  // Joined so the effect keys on the grammar set, not on a fresh array every render.
  const langs = grammarsFor(paths).join(',')
  useEffect(() => {
    // Nothing downstream awaits this; if it fails the diff resolves its own grammar as before.
    void preloadCodeHighlighter(langs === '' ? [] : (langs.split(',') as SupportedLanguages[])).catch(() => {})
  }, [langs])
}
