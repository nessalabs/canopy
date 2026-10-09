/** The instructions Claude follows when drafting a commit message or a pull request for this project. */
import { DEFAULT_DRAFT_PROMPTS, type DraftSettings, type ProjectSettings } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

import { Row, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

const PROMPTS: Array<{ key: keyof DraftSettings; label: string; hint: string }> = [
  { key: 'commitPrompt', label: 'Commit message', hint: 'Sent with the branch name and the staged diff. Claude answers with the summary on the first line, then the description.' },
  {
    key: 'pullRequestPrompt',
    label: 'Pull request',
    hint: 'Sent with the branch name, its commits and its diff against the base. Claude answers with the title on the first line, then the description.'
  }
]

export function DraftsTab({ draft }: { draft: Draft<ProjectSettings> }): React.JSX.Element {
  const drafts = draft.settings?.drafts
  const setPrompt = (key: keyof DraftSettings, value: string): void => draft.update((current) => ({ ...current, drafts: { ...current.drafts, [key]: value } }))

  return (
    <div className="flex flex-col gap-5">
      <TabHeader title="Claude drafts" description="What Claude is told when you press Draft with Claude in the commit box or the pull request form." status={draft.status} />

      {PROMPTS.map(({ key, label, hint }) => (
        <Row key={key} label={label} hint={hint}>
          <Textarea className="min-h-40 font-mono text-xs" aria-label={`${label} prompt`} value={drafts?.[key] ?? ''} disabled={!drafts} onChange={(event) => setPrompt(key, event.target.value)} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={!drafts || drafts[key] === DEFAULT_DRAFT_PROMPTS[key]}
            onClick={() => setPrompt(key, DEFAULT_DRAFT_PROMPTS[key])}
          >
            Reset to default
          </Button>
        </Row>
      ))}

      <ErrorNote error={draft.error} />
    </div>
  )
}
