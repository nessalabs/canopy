/** This machine's preferences: a left nav over one section per concern, nothing per-project. */
import { useEffect, useState } from 'react'
import { FileDiff, Monitor, Palette, Server, TerminalSquare } from 'lucide-react'

import { ErrorNote } from '@/components/error-note'
import { AppearanceSection, DaemonSection, DiffsSection, ToolsSection } from '@/components/settings/app-sections'
import { NavButton, ScopeNote } from '@/components/settings/settings-chrome'
import { useDraftAppSettings } from '@/components/settings/use-draft-settings'
import { settingsHref } from '@/lib/settings-ui'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'tools', label: 'Editor & terminal', icon: TerminalSquare },
  { id: 'diffs', label: 'Diffs', icon: FileDiff },
  { id: 'daemon', label: 'Daemon', icon: Server }
] as const
type SectionId = (typeof SECTIONS)[number]['id']

const isSection = (value: string | null): value is SectionId => value !== null && SECTIONS.some((section) => section.id === value)

/** `#/settings?tab=diffs` or `?tab=diffs#/settings`, as the hash router leaves them. */
function parseSection(hash: string, search: string): SectionId {
  const inHash = new URLSearchParams(hash.split('?')[1] ?? '').get('tab')
  if (isSection(inHash)) return inHash
  const inSearch = new URLSearchParams(search.replace(/^\?/, '')).get('tab')
  return isSection(inSearch) ? inSearch : 'appearance'
}

export function AppSettingsScreen(): React.JSX.Element {
  const draft = useDraftAppSettings()
  const [section, setSection] = useState<SectionId>(() => parseSection(window.location.hash, window.location.search))

  useEffect(() => {
    const sync = (): void => setSection(parseSection(window.location.hash, window.location.search))
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  const select = (next: SectionId): void => {
    setSection(next)
    window.history.replaceState(null, '', settingsHref(window.location.href, next))
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Monitor className="size-5 text-primary" />
          Preferences
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">This machine, every project.</p>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row">
        <nav className="flex shrink-0 flex-row gap-1 overflow-x-auto sm:w-52 sm:flex-col" aria-label="Preference sections">
          {SECTIONS.map((entry) => (
            <NavButton key={entry.id} active={section === entry.id} icon={entry.icon} label={entry.label} onClick={() => select(entry.id)} />
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {section !== 'appearance' ? (
            <ScopeNote>
              Personal and never committed — the daemon keeps these in <code>~/.canopy/config.json</code>. Team-shared settings live with each project.
            </ScopeNote>
          ) : null}
          {section === 'appearance' ? <AppearanceSection /> : null}
          {section === 'tools' ? <ToolsSection draft={draft} /> : null}
          {section === 'diffs' ? <DiffsSection draft={draft} /> : null}
          {section === 'daemon' ? <DaemonSection draft={draft} /> : null}
          <ErrorNote error={draft.error} />
        </div>
      </div>
    </div>
  )
}
