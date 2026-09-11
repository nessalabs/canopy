import { useMemo, useState } from 'react'
import { Moon, Pause, Play, Shuffle, Sun } from 'lucide-react'

import { ACTIVITY_MOTIONS, AVATAR_MOTIONS, AgentAvatar, type Activity, type AvatarMotion } from '@/components/agent/agent-avatar'
import { TurnStatus } from '@/components/agent/turn-status'
import { AgentActivity, AgentActivityTrigger } from '@/components/ui/agent-activity'
import { Button } from '@/components/ui/button'
import { RandomAvatar } from '@/components/ui/random-avatar'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

const ACTIVITIES: Activity[] = ['thinking', 'working', 'solving']
const SIZES = [16, 20, 32, 48, 64, 96] as const
const SEEDS = ['nessa', 'canopy', 'worktree-7', 'session-a1', 'claude', 'codex', 'birch', 'juniper']

/** Literal classes, not a template: Tailwind only emits what it can read in the source. */
const SIZE_CLASS: Record<number, string> = { 16: 'size-4', 20: 'size-5', 32: 'size-8', 48: 'size-12', 64: 'size-16', 96: 'size-24' }

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Control({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

const field = 'h-7 rounded-md border bg-background px-2 text-xs text-foreground'

/**
 * A standalone bench for the agent avatar's motion: every motion alone, the activity presets
 * as the transcript renders them, and a composer for trying combinations across sizes, seeds
 * and both themes. Served at `/lab.html` by the web client's dev server; not part of the app.
 */
export function AvatarLab(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()
  const [seed, setSeed] = useState('nessa')
  const [size, setSize] = useState<number>(64)
  const [ground, setGround] = useState<'paper' | 'ink'>('paper')
  const [playing, setPlaying] = useState(true)
  const [picked, setPicked] = useState<AvatarMotion[]>(['breathe', 'glow'])
  const [cycleMs, setCycleMs] = useState(3200)
  const [tideSpeed, setTideSpeed] = useState(1)
  const [startedAt] = useState(() => Date.now())
  const composed = useMemo(() => (playing ? picked : []), [playing, picked])

  const toggle = (motion: AvatarMotion): void =>
    setPicked((current) => (current.includes(motion) ? current.filter((entry) => entry !== motion) : [...current, motion]))

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-8 font-sans text-foreground">
      <header className="flex flex-wrap items-center gap-4">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold tracking-tight">Agent avatar motion</h1>
          <p className="text-xs text-muted-foreground">The same seeded painting the transcript uses, given something to do while the agent works.</p>
        </div>
        <Control label="Seed">
          <input className={cn(field, 'w-32')} value={seed} onChange={(event) => setSeed(event.target.value)} />
          <Button variant="ghost" size="icon" aria-label="Random seed" onClick={() => setSeed(Math.random().toString(36).slice(2, 8))}>
            <Shuffle />
          </Button>
        </Control>
        <Control label="Size">
          <select className={field} value={size} onChange={(event) => setSize(Number(event.target.value))}>
            {SIZES.map((option) => (
              <option key={option} value={option}>
                {option}px
              </option>
            ))}
          </select>
        </Control>
        <Control label="Ground">
          <select className={field} value={ground} onChange={(event) => setGround(event.target.value as 'paper' | 'ink')}>
            <option value="paper">paper</option>
            <option value="ink">ink</option>
          </select>
        </Control>
        <Button variant="ghost" size="icon" aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        <Button variant="secondary" onClick={() => setPlaying((current) => !current)}>
          {playing ? <Pause /> : <Play />}
          {playing ? 'Pause all' : 'Play all'}
        </Button>
      </header>

      <Section title="In the transcript" hint="The live status row for each activity, exactly as the agent tab renders it, plus the tiny cue an activity beat shows.">
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          {ACTIVITIES.map((activity) => (
            <TurnStatus key={activity} activity={playing ? activity : 'thinking'} startedAt={startedAt} tokens={activity === 'solving' ? 12400 : 0} avatarSeed={seed} />
          ))}
          <div className="ml-10 mt-1">
            <AgentActivity status={playing ? 'running' : 'complete'}>
              <AgentActivityTrigger icon={<RandomAvatar seed={seed} name="Agent" busy={playing} className="size-4" />}>Explored 3 files, 2 searches</AgentActivityTrigger>
            </AgentActivity>
          </div>
        </div>
      </Section>

      <Section title="Activity presets" hint="What each activity plays by default, at the sizes the transcript uses.">
        <div className="grid gap-4 sm:grid-cols-3">
          {ACTIVITIES.map((activity) => (
            <div key={activity} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
              <div className="flex items-end gap-6">
                <AgentAvatar seed={seed} ground={ground} activity={playing ? activity : null} className="size-16" />
                <AgentAvatar seed={seed} ground={ground} activity={playing ? activity : null} className="size-8" />
                <AgentAvatar seed={seed} ground={ground} activity={playing ? activity : null} className="size-4" />
              </div>
              <div>
                <div className="text-sm font-medium capitalize">{activity}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{ACTIVITY_MOTIONS[activity].join(' + ')}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Each motion alone" hint="Click a card to add or remove it from the composition below.">
        <div className="grid gap-4 sm:grid-cols-3">
          {AVATAR_MOTIONS.map(({ motion, label, description }) => {
            const on = picked.includes(motion)
            return (
              <button
                key={motion}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(motion)}
                className={cn(
                  'flex flex-col items-start gap-4 rounded-xl border bg-card p-5 text-left transition-colors hover:bg-accent/40',
                  on && 'border-ring ring-2 ring-ring/30'
                )}
              >
                <div className="flex h-24 w-full items-center justify-center">
                  <AgentAvatar seed={seed} ground={ground} motions={playing ? [motion] : []} cycleMs={cycleMs} tideSpeed={tideSpeed} className={SIZE_CLASS[size]} />
                </div>
                <div>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{description}</div>
                </div>
              </button>
            )
          })}
        </div>
      </Section>

      <Section title="Compose" hint="The picked motions together, across sizes and seeds.">
        <div className="flex flex-col gap-6 rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center gap-6">
            <span className="font-mono text-[11px] text-muted-foreground">{picked.length > 0 ? picked.join(' + ') : 'nothing picked'}</span>
            <Control label={`Cycle ${cycleMs}ms`}>
              <input type="range" min={1000} max={6000} step={100} value={cycleMs} onChange={(event) => setCycleMs(Number(event.target.value))} />
            </Control>
            <Control label={`Tide ×${tideSpeed.toFixed(1)}`}>
              <input type="range" min={0.4} max={2.4} step={0.1} value={tideSpeed} onChange={(event) => setTideSpeed(Number(event.target.value))} />
            </Control>
          </div>
          <div className="flex items-end gap-8">
            {[96, 64, 32, 20, 16].map((px) => (
              <AgentAvatar key={px} seed={seed} ground={ground} motions={composed} cycleMs={cycleMs} tideSpeed={tideSpeed} className={SIZE_CLASS[px]} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-6">
            {SEEDS.map((entry) => (
              <AgentAvatar key={entry} seed={entry} ground={ground} motions={composed} cycleMs={cycleMs} tideSpeed={tideSpeed} className="size-10" />
            ))}
          </div>
        </div>
      </Section>
    </main>
  )
}
