/** The sections of this machine's preferences, one per concern; the screen picks which to show. */
import { useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

import { EDITOR_PRESETS, TERMINAL_PRESETS, type AppSettings, type EditorId, type TerminalId } from '@canopy/shared'

import { Input } from '@/components/ui/input'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { CODE_FONTS, UI_FONTS, codeFontFeatures, codeFontStack, uiFontStack, useFonts, type CodeFontId, type UiFontId } from '@/lib/use-fonts'
import { useTheme, type ThemePreference } from '@/lib/use-theme'

import { Row, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

const PORT_MIN = 1024
const PORT_MAX = 65535

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'system', label: 'Follow device', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon }
]

/** Enough to tell fonts apart where it matters in code: 0/O, 1/l/I, and the operators ligatures redraw. */
const CODE_SAMPLE = 'if (row.id != case_id && 0O == 1lI) return => []'

/**
 * A preset picker with a free-text family for `custom`. The typed name is kept when a preset is
 * picked, so switching back to Custom brings it back.
 */
function FontPicker<Id extends string>({
  label,
  presets,
  value,
  custom,
  placeholder,
  onChange
}: {
  label: string
  presets: Record<string, { label: string; bundled: boolean }>
  value: Id
  custom: string
  placeholder: string
  onChange: (next: { id: Id; custom: string }) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Select value={value} onValueChange={(id) => onChange({ id: id as Id, custom })}>
        <SelectTrigger className="w-52" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(presets).map(([id, preset]) => (
            <SelectItem key={id} value={id}>
              {preset.label}
              {preset.bundled ? null : <span className="text-muted-foreground"> · if installed</span>}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom…</SelectItem>
        </SelectContent>
      </Select>
      {value === 'custom' ? (
        <Input
          className="max-w-sm text-xs"
          placeholder={placeholder}
          aria-label={`${label} family`}
          value={custom}
          onChange={(event) => onChange({ id: value, custom: event.target.value })}
        />
      ) : null}
    </div>
  )
}

/** Theme and fonts live in this browser, not the daemon: they are about the screen in front of you. */
export function AppearanceSection(): React.JSX.Element {
  const { preference, setPreference, theme } = useTheme()
  const { fonts, setFonts } = useFonts()
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <TabHeader title="Appearance" description="Kept by this browser or app window, not the daemon." />
      <Row label="Theme" hint={preference === 'system' ? `Following the device — currently ${theme}.` : 'Fixed, whatever the device is set to.'}>
        <SegmentedControl value={preference} onValueChange={(value) => setPreference(value as ThemePreference)} aria-label="Theme">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <SegmentedControlOption key={value} value={value}>
              <span className="flex items-center gap-1.5">
                <Icon className="size-3.5" />
                {label}
              </span>
            </SegmentedControlOption>
          ))}
        </SegmentedControl>
      </Row>

      <Row label="Code font" hint="Diffs, file previews, code blocks and every other monospaced text.">
        <FontPicker<CodeFontId>
          label="Code font"
          presets={CODE_FONTS}
          value={fonts.code.id}
          custom={fonts.code.custom}
          placeholder="Fira Code — any font installed on this machine"
          onChange={(code) => setFonts((current) => ({ ...current, code }))}
        />
        <pre
          className="mt-2 max-w-lg overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 text-xs"
          style={{ fontFamily: codeFontStack(fonts), fontFeatureSettings: codeFontFeatures(fonts) }}
        >
          {CODE_SAMPLE}
        </pre>
      </Row>

      <label className="flex items-center gap-3 text-sm">
        <Switch checked={fonts.ligatures} onCheckedChange={(ligatures) => setFonts((current) => ({ ...current, ligatures }))} aria-label="Code font ligatures" />
        <span>
          Ligatures
          <span className="block text-xs text-muted-foreground">Draws != as ≠ and {'=>'} as ⇒ in fonts that have them. Off shows the characters in the file.</span>
        </span>
      </label>

      <Row label="Interface font" hint="Everything that is not code.">
        <FontPicker<UiFontId>
          label="Interface font"
          presets={UI_FONTS}
          value={fonts.ui.id}
          custom={fonts.ui.custom}
          placeholder="Inter — any font installed on this machine"
          onChange={(ui) => setFonts((current) => ({ ...current, ui }))}
        />
        <p className="mt-2 text-sm" style={{ fontFamily: uiFontStack(fonts) }}>
          The quick brown fox jumps over the lazy dog.
        </p>
      </Row>
    </div>
  )
}

export function ToolsSection({ draft }: { draft: Draft<AppSettings> }): React.JSX.Element {
  const app = draft.settings
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <TabHeader title="Editor & terminal" description="What “Open in editor” and “Open terminal” launch." status={draft.status} />

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
    </div>
  )
}

export function DiffsSection({ draft }: { draft: Draft<AppSettings> }): React.JSX.Element {
  const app = draft.settings
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <TabHeader title="Diffs" description="How the Git tab's diffs open; each view still has its own toggles." status={draft.status} />
      <Row label="Default layout">
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
  )
}

export function DaemonSection({ draft }: { draft: Draft<AppSettings> }): React.JSX.Element {
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
      <TabHeader title="Daemon" description="How canopyd hands out what every worktree needs." status={draft.status} />
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
  )
}
