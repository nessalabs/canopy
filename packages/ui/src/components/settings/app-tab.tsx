/** Machine-level preferences: how Canopy opens an editor or terminal, diff defaults, port range. */
import { useState } from 'react'

import { EDITOR_PRESETS, TERMINAL_PRESETS, type AppSettings, type EditorId, type TerminalId } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import { Row, ScopeNote, TabHeader } from './settings-chrome'
import { useDraftAppSettings } from './use-draft-settings'

const PORT_MIN = 1024
const PORT_MAX = 65535

/** App preferences tab — the only section that is not per-project. */
export function AppTab(): React.JSX.Element {
  const draft = useDraftAppSettings()
  const app = draft.settings
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)

  const shown = range ?? (app ? { from: String(app.ports.from), to: String(app.ports.to) } : { from: '', to: '' })
  const from = Number(shown.from)
  const to = Number(shown.to)
  const rangeValid = Number.isInteger(from) && Number.isInteger(to) && from >= PORT_MIN && to <= PORT_MAX && from < to

  /** Only a well-formed range is worth PATCHing; half-typed numbers stay local. */
  const editRange = (next: { from: string; to: string }): void => {
    setRange(next)
    const nextFrom = Number(next.from)
    const nextTo = Number(next.to)
    if (Number.isInteger(nextFrom) && Number.isInteger(nextTo) && nextFrom >= PORT_MIN && nextTo <= PORT_MAX && nextFrom < nextTo) {
      draft.update((current) => ({ ...current, ports: { from: nextFrom, to: nextTo } }))
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <TabHeader title="App preferences" description="This machine, every project." status={draft.status} />

      <ScopeNote>
        Personal and never committed — the daemon keeps these in <code>~/.canopy/config.json</code>. Per-project, team-shared settings live in the tabs above.
      </ScopeNote>

      <Row label="Open in editor" hint="Used by “Open in editor” on a worktree and by file links in diffs.">
        <div className="flex flex-col gap-2">
          <Select
            value={app?.editor.id ?? 'vscode'}
            onValueChange={(value) =>
              draft.update((current) => ({
                ...current,
                editor: { id: value, command: value === 'custom' ? current.editor.command : EDITOR_PRESETS[value as EditorId].command }
              }))
            }
          >
            <SelectTrigger className="w-52" aria-label="Default editor">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(EDITOR_PRESETS) as EditorId[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {EDITOR_PRESETS[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="max-w-lg font-mono text-xs"
            placeholder="my-editor {path}"
            aria-label="Editor launch command"
            value={app?.editor.command ?? ''}
            disabled={!app}
            onChange={(event) => draft.update((current) => ({ ...current, editor: { ...current.editor, command: event.target.value } }))}
          />
          <p className="text-[10px] text-muted-foreground">
            <span className="font-mono">{'{path}'}</span> worktree root · <span className="font-mono">{'{file}:{line}'}</span> jump target where the editor supports it
          </p>
        </div>
      </Row>

      <Row label="Open terminal" hint="Used by “Open terminal here” — starts in the worktree directory.">
        <div className="flex flex-col gap-2">
          <Select
            value={app?.terminal.id ?? 'terminal'}
            onValueChange={(value) =>
              draft.update((current) => ({
                ...current,
                terminal: { id: value, command: value === 'custom' ? current.terminal.command : TERMINAL_PRESETS[value as TerminalId].command }
              }))
            }
          >
            <SelectTrigger className="w-52" aria-label="Default terminal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TERMINAL_PRESETS) as TerminalId[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {TERMINAL_PRESETS[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="max-w-lg font-mono text-xs"
            placeholder="my-terminal --working-directory={path}"
            aria-label="Terminal launch command"
            value={app?.terminal.command ?? ''}
            disabled={!app}
            onChange={(event) => draft.update((current) => ({ ...current, terminal: { ...current.terminal, command: event.target.value } }))}
          />
        </div>
      </Row>

      <div className="flex flex-col gap-4 border-t border-border/60 pt-5">
        <p className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">diffs</p>
        <Row label="Default layout" hint="How Git Diff tabs open; each view still has its own toggle.">
          <SegmentedControl
            value={app?.diff.layout ?? 'split'}
            onValueChange={(value) => draft.update((current) => ({ ...current, diff: { ...current.diff, layout: value as AppSettings['diff']['layout'] } }))}
            aria-label="Default diff layout"
          >
            <SegmentedControlOption value="split">Split</SegmentedControlOption>
            <SegmentedControlOption value="unified">Unified</SegmentedControlOption>
          </SegmentedControl>
        </Row>
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={app?.diff.wrap ?? false}
            disabled={!app}
            onCheckedChange={(checked) => draft.update((current) => ({ ...current, diff: { ...current.diff, wrap: checked } }))}
            aria-label="Wrap long lines in diffs"
          />
          <span>
            Wrap long lines
            <span className="block text-xs text-muted-foreground">Off keeps code shape; the scroll stays inside the diff.</span>
          </span>
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={app?.diff.lineNumbers ?? false}
            disabled={!app}
            onCheckedChange={(checked) => draft.update((current) => ({ ...current, diff: { ...current.diff, lineNumbers: checked } }))}
            aria-label="Show line numbers in diffs"
          />
          <span>
            Line numbers
            <span className="block text-xs text-muted-foreground">Reviews talk in line numbers — leave them on unless space is tight.</span>
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-4 border-t border-border/60 pt-5">
        <p className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">daemon</p>
        <Row label="Port range" hint="Every named port of every worktree is allocated inside this range. Leave room: one port per service per worktree.">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={PORT_MIN}
              max={PORT_MAX}
              className="w-32 font-mono text-xs"
              aria-label="Port range start"
              value={shown.from}
              disabled={!app}
              onChange={(event) => editRange({ ...shown, from: event.target.value })}
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Input
              type="number"
              min={PORT_MIN}
              max={PORT_MAX}
              className="w-32 font-mono text-xs"
              aria-label="Port range end"
              value={shown.to}
              disabled={!app}
              onChange={(event) => editRange({ ...shown, to: event.target.value })}
            />
          </div>
          {!rangeValid && app ? (
            <p role="alert" className="text-xs text-destructive">
              Start must be below end, both between {PORT_MIN} and {PORT_MAX}. Not saved until it is.
            </p>
          ) : null}
        </Row>
      </div>

      <ErrorNote error={draft.error} />
    </div>
  )
}
