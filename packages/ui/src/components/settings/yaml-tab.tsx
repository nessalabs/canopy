/** The canopy.yaml editor: live lint with the daemon's own validator, plus a key reference. */
import { useState } from 'react'
import { BookOpen, Bot, Check, FileCode, Sparkles, X } from 'lucide-react'

import { STARTER_CANOPY_YAML, parseCanopyYaml, reportFor, type ConfigProposal, type Project } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { SplitView, SplitViewOrientation, SplitViewPanel, SplitViewSeparator, type SplitViewLayout } from '@/components/split-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/ui/code-block'
import { SegmentedControl, SegmentedControlOption } from '@/components/ui/segmented-control'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToolCallDiff } from '@/components/ui/tool-call'
import { useProjectConfig, useScaffoldProjectConfig, useWorktrees, useWriteProjectConfig } from '@/lib/api-hooks'

import { ConfigAgentPanel } from './config-agent'
import { TabHeader } from './settings-chrome'
import { plural } from '@/lib/format'
import { readStored, writeStored } from '@/lib/local-store'

/** Every top-level key of the schema in `packages/shared/src/schemas/environment.ts`, as one commented example. */
const YAML_REFERENCE = `# Schema version. Always 1 today; the daemon refuses a file without it.
version: 1

# Display name for the app this repo runs. Optional — the project name is used otherwise.
name: my-app

# Fallbacks for every service: runtime (host | docker | compose) and an env map
# layered under all of them.
defaults:
  runtime: host
  env:
    NODE_ENV: development

# Project-wide environment, layered over defaults.env and under each service.
# Templates resolve here too.
env:
  LOG_LEVEL: debug
  API_URL: "http://localhost:\${ports.api}"

# Named ports. Every worktree gets its own free number — stable per branch.
# preferred is tried first; range constrains the search. Reference one as \${ports.name}.
ports:
  web: {}
  api: { preferred: 4000 }
  metrics: { range: [42000, 42999] }

# Databases forked per worktree: postgres, mysql, sqlite or redis.
#   seed     one of dump, sql or command (sqlite copies source: instead)
#   env      variable that receives the fork URL (default <NAME>_URL)
# Templates get \${db.name.url} plus .host, .port, .database, .user, .password
# for other driver schemes. redis may run on the host instead of docker.
databases:
  main:
    adapter: postgres
    version: "16"
    seed: { dump: ./db/seed.dump }
    env: DATABASE_URL
  cache:
    adapter: redis
    runtime: host

# Ordered commands run once while provisioning, with the resolved env.
# Each step takes run, name, cwd, env and if_changed — globs whose content matching
# the source checkout skips the step. A bare string is shorthand for { run }.
setup:
  - run: npm ci
    if_changed: [package-lock.json]
  - run: npm run db:migrate
    name: migrate
    cwd: apps/api

# What runs. Each service takes:
#   run (+ cwd, env, ports)    runtime host | docker | compose
#   health http, tcp or cmd with interval / timeout / retries / start_period
#   depends_on for ordering    restart never | on-failure | always
#   autostart false to register without starting
#   docker { image, dockerfile, context, volumes, args, user, workdir }
#   compose { file, services, profiles }
#   stop_signal and stop_timeout
services:
  api:
    run: npm run dev:api
    cwd: apps/api
    env: { PORT: "\${ports.api}" }
    health:
      http: "http://localhost:\${ports.api}/healthz"
      interval: 3s
      retries: 10
    depends_on: [worker]
    restart: on-failure
  worker:
    runtime: docker
    run: node worker.js
    docker: { image: node:22, workdir: /workspace }

# Dotenv Canopy writes into each worktree with ports, database URLs and env resolved.
# Point your tooling at it, or set false to skip it.
env_file: .env.canopy
`

/** The canopy.yaml tab. */
/** How wide the editor and the agent were left, kept across visits. */
const SPLIT_KEY = 'canopy-yaml-agent-split'
const DEFAULT_SPLIT: SplitViewLayout = { editor: 62, agent: 38 }

export function YamlTab({ project }: { project: Project }): React.JSX.Element {
  const config = useProjectConfig(project.id)
  const write = useWriteProjectConfig(project.id)
  const scaffold = useScaffoldProjectConfig(project.id)
  const [view, setView] = useState<'preview' | 'edit'>('preview')
  const [draft, setDraft] = useState<string | null>(null)
  // The Canopy Agent's proposal on screen as the draft, and the last one the user saved.
  const [proposal, setProposal] = useState<ConfigProposal | null>(null)
  const [savedProposal, setSavedProposal] = useState<string>()
  const [split] = useState(() => readStored<SplitViewLayout>(SPLIT_KEY) ?? DEFAULT_SPLIT)
  const main = useWorktrees().data?.find((worktree) => worktree.projectId === project.id && worktree.isMain)

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
  const propose = (next: ConfigProposal): void => {
    setProposal(next)
    setDraft(next.yaml)
    setView('preview')
  }
  const revert = (): void => {
    setDraft(null)
    setProposal(null)
  }
  const save = (): void =>
    write.mutate(text, {
      onSuccess: () => {
        // Saved as the agent proposed it: the agent hears so and goes on to check it.
        if (proposal && proposal.yaml === text) setSavedProposal(proposal.callId)
        revert()
      }
    })

  // Only once the read has actually landed: an error must not read as "no file".
  const missing = config.data !== undefined && config.data.raw === null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <TabHeader
        title="canopy.yaml"
        description="What this project runs: ports, databases, setup and services. Committed with the repo."
        action={
          <>
            <Button type="button" variant="ghost" size="sm" disabled={!dirty} onClick={revert}>
              Revert
            </Button>
            <Button type="button" size="sm" disabled={!dirty || !valid || write.isPending} onClick={save}>
              {write.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      />

      {/* The page's full height, split: the file scrolls on its own and the agent runs top to bottom, as wide as it was dragged. */}
      <SplitView orientation={SplitViewOrientation.Horizontal} defaultLayout={split} onLayoutCommit={(layout) => writeStored(SPLIT_KEY, layout)} className="min-h-0 flex-1">
        <SplitViewPanel id="editor" minSize={30} className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto pr-3 *:shrink-0">
          {missing ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
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
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
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

          {proposal && dirty ? (
            <p className="flex items-start gap-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <Bot className="mt-px size-3.5 shrink-0" />
              <span>
                <span className="font-medium">Proposed by the Canopy Agent:</span> {proposal.summary} Review the diff, then Save.
              </span>
            </p>
          ) : null}

          {view === 'preview' && dirty ? (
            <ToolCallDiff from={stored ?? ''} to={text} filename="canopy.yaml" language="yaml" />
          ) : view === 'preview' ? (
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
        </SplitViewPanel>
        <SplitViewSeparator />
        <SplitViewPanel id="agent" minSize={20} className="flex min-h-0 min-w-0 pl-3">
          <Tabs defaultValue="agent" className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <TabsList className="self-start">
              <TabsTrigger value="agent" icon={<Bot className="size-3.5" />}>
                Agent
              </TabsTrigger>
              <TabsTrigger value="reference" icon={<BookOpen className="size-3.5" />}>
                Reference
              </TabsTrigger>
            </TabsList>
            {/* Mounted while hidden, so a turn keeps streaming while the reference is open. */}
            <TabsContent value="agent" forceMount className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card data-[state=inactive]:hidden">
              {main ? <ConfigAgentPanel projectId={project.id} worktree={main} onProposal={propose} saved={savedProposal} /> : null}
            </TabsContent>
            <TabsContent value="reference" className="min-h-0 flex-1 overflow-y-auto">
              <CodeBlock code={YAML_REFERENCE} language="yaml" filename="canopy.yaml reference" />
            </TabsContent>
          </Tabs>
        </SplitViewPanel>
      </SplitView>
    </div>
  )
}
