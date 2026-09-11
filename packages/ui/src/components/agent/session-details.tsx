import { Info } from 'lucide-react'

import type { AgentCapabilities } from '@canopy/shared'
import type { SessionInfo } from '@canopy/shared/agent-stream'

import { AgentDetails, AgentDetailsField, AgentDetailsProject, AgentDetailsSection } from '@/components/ui/agent-details'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status-dot'
import { plural } from '@/lib/format'

const PROVIDER_NAMES: Record<AgentCapabilities['provider'], string> = { claude: 'Claude Code', codex: 'Codex' }

const basename = (path: string | null | undefined): string | null => (path ? (path.split('/').filter(Boolean).at(-1) ?? null) : null)

/** connected · failed · needs-auth · pending, as the dot draws them. */
function mcpStatus(status: string): 'success' | 'error' | 'running' | 'idle' {
  const normalized = status.toLowerCase()
  if (normalized === 'connected') return 'success'
  if (normalized === 'failed' || normalized.includes('auth')) return 'error'
  if (normalized === 'connecting' || normalized === 'pending') return 'running'
  return 'idle'
}

/** One entry of a list section: a name, and whatever the provider says about it. */
function DetailRow({ name, meta, note }: { name: string; meta?: string; note?: string }): React.JSX.Element {
  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 border-b border-border py-2 last:border-b-0">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate font-sans nessa-text-3 text-foreground">{name}</span>
        {meta ? <span className="shrink-0 font-sans nessa-text-2 text-muted-foreground">{meta}</span> : null}
      </span>
      {note ? <span className="min-w-0 font-sans nessa-text-2 text-muted-foreground">{note}</span> : null}
    </div>
  )
}

/** A long list nobody scans by default: the count, with the names one click away. */
function NameList({ label, names }: { label: string; names: readonly string[] }): React.JSX.Element {
  return (
    <details className="w-full min-w-0">
      <summary className="cursor-pointer list-none font-sans nessa-text-3 text-muted-foreground marker:hidden">
        {plural(names.length, label)} — show
      </summary>
      <p className="m-0 pt-1.5 font-mono nessa-text-2 leading-5 text-muted-foreground">{names.join(', ')}</p>
    </details>
  )
}

/**
 * The session's identity, for the details sheet: what the transcript's own `init` said, widened
 * with everything the provider advertises for this checkout — the lists a terminal's `/mcp`,
 * `/agents` and `/hooks` would print.
 */
export function SessionSheetBody({ session, capabilities, openInTerminal }: {
  session: SessionInfo | null
  capabilities?: AgentCapabilities
  openInTerminal?: boolean
}): React.JSX.Element {
  const model = session?.model ?? capabilities?.model
  const mode = session?.permissionMode ?? capabilities?.permissionMode
  const version = session?.version ?? capabilities?.version
  const outputStyle = session?.outputStyle ?? capabilities?.outputStyle
  const account = capabilities?.account
  const tools = session?.tools.length ? session.tools : (capabilities?.tools ?? [])
  const skills = capabilities?.skills ?? []
  const agents = capabilities?.agents ?? []
  const mcpServers = capabilities?.mcpServers.length ? capabilities.mcpServers : (session?.mcpServers ?? [])
  const plugins = capabilities?.plugins ?? []
  const hooks = capabilities?.hooks ?? []
  const commands = capabilities?.commands ?? []
  const cwd = session?.cwd ?? capabilities?.cwd

  return (
    <>
      <AgentDetails title={model ?? 'Agent session'}>
        {cwd ? <AgentDetailsProject path={cwd} branch={undefined} /> : null}
        <AgentDetailsSection title="Session">
          {model ? <AgentDetailsField label="Model" value={model} /> : null}
          {mode ? <AgentDetailsField label="Mode" value={mode} /> : null}
          {version ? <AgentDetailsField label="Version" value={version} /> : null}
          {outputStyle ? <AgentDetailsField label="Output style" value={outputStyle} /> : null}
          {account?.email ? <AgentDetailsField label="Account" value={account.email} /> : null}
          {account?.subscriptionType ? <AgentDetailsField label="Subscription" value={account.subscriptionType} /> : null}
        </AgentDetailsSection>
        {tools.length > 0 ? (
          <AgentDetailsSection title="Tools">
            <NameList label="tool" names={tools} />
          </AgentDetailsSection>
        ) : null}
        {skills.length > 0 ? (
          <AgentDetailsSection title="Skills">
            {skills.map((skill) => (
              <DetailRow key={skill.name} name={skill.name} note={skill.description} />
            ))}
          </AgentDetailsSection>
        ) : null}
        {agents.length > 0 ? (
          <AgentDetailsSection title="Subagents">
            {agents.map((agent) => (
              <DetailRow key={agent.name} name={agent.name} meta={agent.model} note={agent.description} />
            ))}
          </AgentDetailsSection>
        ) : null}
        {mcpServers.length > 0 ? (
          <AgentDetailsSection title="MCP servers">
            {mcpServers.map((server) => (
              <div key={server.name} className="flex w-full min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
                <span className="min-w-0 truncate font-sans nessa-text-3 text-foreground">{server.name}</span>
                <span className="flex shrink-0 items-center gap-1.5 font-sans nessa-text-2 text-muted-foreground">
                  <StatusDot status={mcpStatus(server.status)} />
                  {server.status}
                </span>
              </div>
            ))}
          </AgentDetailsSection>
        ) : null}
        {plugins.length > 0 ? (
          <AgentDetailsSection title="Plugins">
            {plugins.map((plugin) => (
              <DetailRow key={plugin.name} name={plugin.version ? `${plugin.name}@${plugin.version}` : plugin.name} />
            ))}
          </AgentDetailsSection>
        ) : null}
        {hooks.length > 0 ? (
          <AgentDetailsSection title="Hooks">
            {hooks.map((hook, index) => (
              <DetailRow
                key={`${hook.event}:${hook.matcher ?? ''}:${hook.kind}:${index}`}
                name={[hook.event, hook.matcher].filter(Boolean).join(' · ')}
                note={[hook.kind, hook.target].filter(Boolean).join(' ')}
              />
            ))}
          </AgentDetailsSection>
        ) : null}
        {commands.length > 0 ? (
          <AgentDetailsSection title="Commands">
            <NameList label="command" names={commands.map((command) => `/${command.name}`)} />
          </AgentDetailsSection>
        ) : null}
      </AgentDetails>
      {openInTerminal ? (
        <p className="m-0 rounded-lg border border-border bg-muted/40 px-3 py-2 nessa-text-2 text-muted-foreground">
          A terminal has this session open. Turns sent from here run against it, but that terminal will not show them until it resumes.
        </p>
      ) : null}
    </>
  )
}

/**
 * One line naming the session, with the way into its details. A session that has not run yet has
 * no `init` to name it, so a fresh one is named by what the provider advertises for the checkout.
 */
export function SessionLine({ session, capabilities, openInTerminal, open, sheetId, onOpen }: {
  session: SessionInfo | null
  capabilities?: AgentCapabilities
  openInTerminal?: boolean
  open: boolean
  sheetId: string
  onOpen: () => void
}): React.JSX.Element | null {
  if (!session && !capabilities && !openInTerminal) return null
  const where = basename(session?.cwd ?? capabilities?.cwd)
  const provider = capabilities ? [PROVIDER_NAMES[capabilities.provider], capabilities.version].filter(Boolean).join(' ') : null
  const label = [session?.model ?? provider, where].filter(Boolean).join(' · ') || 'Agent session'
  return (
    <div className="mb-1 flex items-center gap-1 nessa-text-2 text-muted-foreground">
      <span className="min-w-0 truncate">
        {label}
        {openInTerminal ? ' · open in a terminal' : ''}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-muted-foreground"
        aria-label="Session details"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        onClick={onOpen}
      >
        <Info className="size-3.5" />
      </Button>
    </div>
  )
}
