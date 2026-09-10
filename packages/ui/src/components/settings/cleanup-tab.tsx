/** Cleanup policy: what happens when a worktree is destroyed and when one goes stale. */
import type { CleanupSettings, ProjectSettings } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { QuestionnaireChoice, QuestionnaireChoices } from '@/components/ui/questionnaire'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import { Row, TabHeader } from './settings-chrome'
import type { Draft } from './use-draft-settings'

const STALE_DAYS = [7, 14, 30]

/** Cleanup tab. */
export function CleanupTab({ draft }: { draft: Draft<ProjectSettings> }): React.JSX.Element {
  const cleanup = draft.settings?.cleanup
  const staleDays = cleanup?.staleDays ?? 14
  // A threshold set elsewhere (config file, older build) must still show in the select.
  const dayOptions = STALE_DAYS.includes(staleDays) ? STALE_DAYS : [...STALE_DAYS, staleDays].sort((a, b) => a - b)
  const setCleanup = (patch: Partial<CleanupSettings>): void => draft.update((current) => ({ ...current, cleanup: { ...current.cleanup, ...patch } }))

  return (
    <div className="flex flex-col gap-6">
      <TabHeader title="Cleanup" description="Canopy never deletes your code without asking; these settle how hard it asks." status={draft.status} />

      <Row label="Destroying a worktree with uncommitted changes">
        <QuestionnaireChoices
          value={[cleanup?.dirtyDestroy ?? 'prompt']}
          onValueChange={(value) => setCleanup({ dirtyDestroy: (value[0] ?? 'prompt') as CleanupSettings['dirtyDestroy'] })}
        >
          <QuestionnaireChoice value="prompt">
            Prompt with a diff summary. <em>Default.</em>
          </QuestionnaireChoice>
          <QuestionnaireChoice value="block">Block — require an explicit force.</QuestionnaireChoice>
        </QuestionnaireChoices>
      </Row>

      <Row label="Delete the branch when its worktree is destroyed">
        <QuestionnaireChoices
          value={[cleanup?.deleteBranch ?? 'ask']}
          onValueChange={(value) => setCleanup({ deleteBranch: (value[0] ?? 'ask') as CleanupSettings['deleteBranch'] })}
        >
          <QuestionnaireChoice value="ask">
            If fully merged, ask. <em>Default.</em>
          </QuestionnaireChoice>
          <QuestionnaireChoice value="if-merged">If fully merged, delete silently.</QuestionnaireChoice>
          <QuestionnaireChoice value="never">Never.</QuestionnaireChoice>
        </QuestionnaireChoices>
      </Row>

      <Row label="Stale worktrees" hint="Notify about worktrees idle past the threshold — nothing is ever deleted for you.">
        <div className="flex items-center gap-3">
          <Switch checked={cleanup?.staleGc ?? false} disabled={!cleanup} onCheckedChange={(checked) => setCleanup({ staleGc: checked })} aria-label="Notify about stale worktrees" />
          <span className="text-sm">Notify after</span>
          <Select value={String(staleDays)} onValueChange={(value) => setCleanup({ staleDays: Number(value) })}>
            <SelectTrigger className="w-28" aria-label="Stale threshold" disabled={!cleanup?.staleGc}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dayOptions.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {days} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Row>

      <ErrorNote error={draft.error} />
    </div>
  )
}
