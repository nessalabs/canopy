/** The canopy.yaml editor: live lint with the daemon's own validator, plus a key reference. */
import { useState } from 'react'
import { Check, FileCode, Sparkles, X } from 'lucide-react'

import { STARTER_CANOPY_YAML, parseCanopyYaml, reportFor, type Project } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/ui/code-block'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { useProjectConfig, useScaffoldProjectConfig, useWriteProjectConfig } from '@/lib/api-hooks'

import { TabHeader } from './settings-chrome'
import { plural } from '@/lib/format'

interface ReferenceEntry {
  key: string
  summary: string
  example: string
}

/** One short entry per top-level key of the schema in `packages/shared/src/schemas/environment.ts`. */
const YAML_REFERENCE: ReferenceEntry[] = [
  { key: 'version', summary: 'Schema version. Always 1 today; the daemon refuses a file without it.', example: 'version: 1' },
  { key: 'name', summary: 'Display name for the app this repo runs. Optional — the project name is used otherwise.', example: 'name: my-app' },
  {
    key: 'defaults',
    summary: 'Fallbacks for every service: runtime (host | docker | compose) and an env map layered under all of them.',
    example: 'defaults:\n  runtime: host\n  env:\n    NODE_ENV: development'
  },
  {
    key: 'env',
    summary: 'Project-wide environment, layered over defaults.env and under each service. Templates resolve here too.',
    example: 'env:\n  LOG_LEVEL: debug\n  API_URL: "http://localhost:${ports.api}"'
  },
  {
    key: 'ports',
    summary: 'Named ports. Every worktree gets its own free number — stable per branch — with preferred tried first and range constraining the search. Reference one as ${ports.name}.',
    example: 'ports:\n  web: {}\n  api: { preferred: 4000 }\n  metrics: { range: [42000, 42999] }'
  },
  {
    key: 'databases',
    summary:
      'Databases forked per worktree: postgres, mysql, sqlite or redis. seed takes one of dump, sql or command; sqlite copies source; env names the variable that receives the fork URL (default <NAME>_URL); templates get ${db.name.url} plus the parts ${db.name.host}, .port, .database, .user, .password for other driver schemes; redis may run on the host instead of docker.',
    example: 'databases:\n  main:\n    adapter: postgres\n    version: "16"\n    seed: { dump: ./db/seed.dump }\n    env: DATABASE_URL\n  cache:\n    adapter: redis\n    runtime: host'
  },
  {
    key: 'setup',
    summary: 'Ordered commands run once while provisioning, with the resolved env. Each step takes run, name, cwd, env and if_changed — globs whose content matching the source checkout skips the step. A bare string is shorthand for { run }.',
    example: 'setup:\n  - run: npm ci\n    if_changed: [package-lock.json]\n  - run: npm run db:migrate\n    name: migrate\n    cwd: apps/api'
  },
  {
    key: 'services',
    summary:
      'What runs. run (+ cwd, env, ports), runtime host | docker | compose, health as http, tcp or cmd with interval/timeout/retries/start_period, depends_on for ordering, restart never | on-failure | always, autostart false to register without starting, docker { image, dockerfile, context, volumes, args, user, workdir }, compose { file, services, profiles }, stop_signal and stop_timeout.',
    example:
      'services:\n  api:\n    run: npm run dev:api\n    cwd: apps/api\n    env: { PORT: "${ports.api}" }\n    health:\n      http: "http://localhost:${ports.api}/healthz"\n      interval: 3s\n      retries: 10\n    depends_on: [worker]\n    restart: on-failure\n  worker:\n    runtime: docker\n    run: node worker.js\n    docker: { image: node:22, workdir: /workspace }'
  },
  {
    key: 'env_file',
    summary: 'Dotenv Canopy writes into each worktree with ports, database URLs and env resolved. Point your tooling at it, or set false to skip it.',
    example: 'env_file: .env.canopy'
  }
]

/** The canopy.yaml tab. */
export function YamlTab({ project }: { project: Project }): React.JSX.Element {
  const config = useProjectConfig(project.id)
  const write = useWriteProjectConfig(project.id)
  const scaffold = useScaffoldProjectConfig(project.id)
  const [view, setView] = useState<'preview' | 'edit'>('preview')
  const [draft, setDraft] = useState<string | null>(null)

  const stored = config.data?.raw ?? null
  const text = draft ?? stored ?? ''
  // The file in effect may sit in the project's Canopy home rather than in the checkout.
  const configPath = config.data?.path ?? `${project.path}/canopy.yaml`
  const inRepo = configPath === `${project.path}/canopy.yaml` || configPath.startsWith(`${project.path}/`)
  const dirty = draft !== null && draft !== (stored ?? '')
  // An empty buffer is "nothing to lint" rather than a broken file, so the badges stay quiet
  // until there is something to check.
  const empty = text.trim() === ''
  const parsed = empty ? { config: null, errors: [], warnings: [] } : parseCanopyYaml(text)
  const live = reportFor(parsed)
  const valid = !empty && parsed.errors.length === 0

  const start = (content: string): void => {
    setDraft(content)
    setView('edit')
  }

  // Only once the read has actually landed: an error must not read as "no file".
  const missing = config.data !== undefined && config.data.raw === null

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="canopy.yaml"
        description="What this project runs: ports, databases, setup and services. Committed with the repo."
        action={
          <>
            <Button type="button" variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(null)}>
              Revert
            </Button>
            <Button type="button" size="sm" disabled={!dirty || !valid || write.isPending} onClick={() => write.mutate(text, { onSuccess: () => setDraft(null) })}>
              {write.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          {missing ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-sunken p-3 text-xs">
              <span className="text-muted-foreground">
                No <span className="font-mono text-foreground">canopy.yaml</span> in this repo yet. Worktrees still get created — they just have nothing to run.
              </span>
              <span className="ml-auto flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={scaffold.isPending} onClick={() => scaffold.mutate(undefined, { onSuccess: (data) => start(data.raw) })}>
                  <Sparkles className="size-3" /> {scaffold.isPending ? 'Scaffolding…' : 'Scaffold canopy.yaml'}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => start(STARTER_CANOPY_YAML)}>
                  Start from template
                </Button>
              </span>
            </div>
          ) : null}
          <ErrorNote error={scaffold.error} />

          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl value={view} onValueChange={(value) => setView(value as 'preview' | 'edit')} aria-label="canopy.yaml view">
              <SegmentedControlOption value="preview">Preview</SegmentedControlOption>
              <SegmentedControlOption value="edit">Edit</SegmentedControlOption>
            </SegmentedControl>
            {empty ? null : valid ? (
              <Badge variant="outline" className="gap-1 text-[10px] text-nessa-diff-addition">
                <Check className="size-3" /> valid
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1 text-[10px]">
                <X className="size-3" /> {parsed.errors.length} error{parsed.errors.length === 1 ? '' : 's'}
              </Badge>
            )}
            {parsed.warnings.length > 0 ? (
              <Badge variant="secondary" className="text-[10px]">
                {parsed.warnings.length} warning{parsed.warnings.length === 1 ? '' : 's'}
              </Badge>
            ) : null}
            <span className="ml-auto flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[10px]">
                {plural(live.services, 'service')}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {plural(live.ports, 'port')}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {plural(live.databases, 'database')}
              </Badge>
            </span>
          </div>

          {parsed.errors.length > 0 || parsed.warnings.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3 font-mono text-xs">
              {parsed.errors.map((message) => (
                <span key={message} className="text-destructive">
                  ✗ {message}
                </span>
              ))}
              {parsed.warnings.map((message) => (
                <span key={message} className="text-muted-foreground">
                  ⚠ {message}
                </span>
              ))}
            </div>
          ) : null}

          <ErrorNote error={config.error} />
          <ErrorNote error={write.error} />

          {view === 'preview' ? (
            <CodeBlock code={text === '' ? '# no canopy.yaml yet' : text} language="yaml" filename={config.data?.path ?? 'canopy.yaml'} />
          ) : (
            <Textarea
              value={text}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              aria-label="Edit canopy.yaml"
              className="min-h-[440px] resize-y font-mono text-xs leading-relaxed"
            />
          )}

          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode className="size-3" />
            Lives at <span className="font-mono">{configPath}</span>
            {inRepo ? (
              <> and is committed. A worktree's own copy wins at runtime, so a branch can evolve its services safely.</>
            ) : (
              <> — this project's Canopy home, for a repo that should not carry the file. A canopy.yaml committed to the checkout would win over it.</>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Daemon lint:{' '}
            {project.config.present ? (
              project.config.valid ? (
                <span className="text-nessa-diff-addition">valid — {plural(project.config.services, 'service')}, {plural(project.config.ports, 'port')}, {plural(project.config.databases, 'database')}</span>
              ) : (
                <span className="text-destructive">{project.config.errors[0] ?? 'has errors'}</span>
              )
            ) : (
              'no file yet'
            )}
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">reference</p>
          <Accordion type="multiple" className="rounded-lg border border-border px-3">
            {YAML_REFERENCE.map((entry) => (
              <AccordionItem key={entry.key} value={entry.key}>
                <AccordionTrigger className="font-mono text-xs">{entry.key}:</AccordionTrigger>
                <AccordionContent>
                  <p className="text-xs text-muted-foreground">{entry.summary}</p>
                  <pre className="mt-2 overflow-x-auto rounded-md bg-surface-sunken p-2 font-mono text-[10px] leading-relaxed">{entry.example}</pre>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </div>
  )
}
