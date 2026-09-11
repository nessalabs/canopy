import { useState } from 'react'
import { Moon, Pause, Play, Shuffle, Sun } from 'lucide-react'

import { ACTIVITY_TUNING, AgentAvatar, type Activity } from '@/components/agent/agent-avatar'
import { TurnStatus } from '@/components/agent/turn-status'
import { AgentActivity, AgentActivityTrigger } from '@/components/ui/agent-activity'
import { Button } from '@/components/ui/button'
import { RandomAvatar, type RandomAvatarGround } from '@/components/ui/random-avatar'
import { useTheme } from '@/lib/use-theme'
import { cn } from '@/lib/utils'

const ACTIVITIES: Activity[] = ['thinking', 'working', 'solving']
const SEEDS = ['nessa', 'canopy', 'worktree-7', 'session-a1', 'claude', 'codex', 'birch', 'juniper']
/** The rows nessa's own Tuning story uses, so the bench and the storybook agree. */
const FLOODS = [0.25, 0.6, 1]
const SPEEDS = [0.4, 1, 2.5]
const BLEEDS = [0, 0.5, 1, 2]

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

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-5">
      <span className="w-24 font-mono text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

const field = 'h-7 rounded-md border bg-background px-2 text-xs text-foreground'

/**
 * A standalone bench for the agent avatar: nessa's own working flood as each activity tunes it,
 * the knobs behind it row by row, and the paint-on bloom — across seeds, both grounds and both
 * themes. Served at `/lab.html` by the web client's dev server; not part of the app.
 */
export function AvatarLab(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()
  const [seed, setSeed] = useState('nessa')
  const [ground, setGround] = useState<RandomAvatarGround>('paper')
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [flood, setFlood] = useState(1)
  const [bleed, setBleed] = useState(1)
  const [take, setTake] = useState(0)
  const [startedAt] = useState(() => Date.now())
  const shown = SEEDS.slice(0, 6)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-8 font-sans text-foreground">
      <header className="flex flex-wrap items-center gap-4">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold tracking-tight">Agent avatar</h1>
          <p className="text-xs text-muted-foreground">Nessa's painting in its own working state, tuned per activity.</p>
        </div>
        <Control label="Seed">
          <input className={cn(field, 'w-32')} value={seed} onChange={(event) => setSeed(event.target.value)} />
          <Button variant="ghost" size="icon" aria-label="Random seed" onClick={() => setSeed(Math.random().toString(36).slice(2, 8))}>
            <Shuffle />
          </Button>
        </Control>
        <Control label="Ground">
          <select className={field} value={ground} onChange={(event) => setGround(event.target.value as RandomAvatarGround)}>
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

      <Section title="Per activity" hint="The speed and flood each activity sets, at the sizes the transcript uses and across seeds.">
        <div className="grid gap-4 sm:grid-cols-3">
          {ACTIVITIES.map((activity) => (
            <div key={activity} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
              <div className="flex items-end gap-6">
                <AgentAvatar seed={seed} ground={ground} activity={playing ? activity : null} className="size-16" />
                <AgentAvatar seed={seed} ground={ground} activity={playing ? activity : null} className="size-8" />
                <AgentAvatar seed={seed} ground={ground} activity={playing ? activity : null} className="size-4" />
              </div>
              <div className="flex items-center gap-2">
                {shown.map((entry) => (
                  <AgentAvatar key={entry} seed={entry} ground={ground} activity={playing ? activity : null} className="size-6" />
                ))}
              </div>
              <div>
                <div className="text-sm font-medium capitalize">{activity}</div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  speed {ACTIVITY_TUNING[activity].speed} · flood {ACTIVITY_TUNING[activity].flood}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Tuning" hint="Nessa's own knobs, one per row, over the same six seeds. flood is how far a wash reaches; speed multiplies the cycle; bleed is how far pigment creeps at the edges.">
        <div className="flex flex-col gap-5 rounded-xl border bg-card p-5">
          {FLOODS.map((value) => (
            <Row key={`flood-${value}`} label={`flood ${value}`}>
              {shown.map((entry) => (
                <RandomAvatar key={entry} seed={entry} ground={ground} flood={value} busy={playing} className="size-14" />
              ))}
            </Row>
          ))}
          {SPEEDS.map((value) => (
            <Row key={`speed-${value}`} label={`speed ${value}`}>
              {shown.map((entry) => (
                <RandomAvatar key={entry} seed={entry} ground={ground} speed={value} busy={playing} className="size-14" />
              ))}
            </Row>
          ))}
          {BLEEDS.map((value) => (
            <Row key={`bleed-${value}`} label={`bleed ${value}`}>
              {shown.map((entry) => (
                <RandomAvatar key={entry} seed={entry} ground={ground} bleed={value} busy={playing} className="size-14" />
              ))}
            </Row>
          ))}
        </div>
      </Section>

      <Section title="Dial it in" hint="Any combination, on the chosen seed, at every transcript size.">
        <div className="flex flex-col gap-6 rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center gap-6">
            <Control label={`speed ×${speed.toFixed(1)}`}>
              <input type="range" min={0.3} max={2.5} step={0.1} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
            </Control>
            <Control label={`flood ${flood.toFixed(2)}`}>
              <input type="range" min={0} max={1} step={0.05} value={flood} onChange={(event) => setFlood(Number(event.target.value))} />
            </Control>
            <Control label={`bleed ${bleed.toFixed(1)}`}>
              <input type="range" min={0} max={2.5} step={0.1} value={bleed} onChange={(event) => setBleed(Number(event.target.value))} />
            </Control>
          </div>
          <div className="flex items-end gap-8">
            {['size-24', 'size-16', 'size-8', 'size-5', 'size-4'].map((size) => (
              <RandomAvatar key={size} seed={seed} ground={ground} speed={speed} flood={flood} bleed={bleed} busy={playing} className={size} />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Paint on" hint="animateOnMount: the pools bloom in one after another, for when an agent first appears.">
        <div className="flex items-center gap-6 rounded-xl border bg-card p-5">
          {SEEDS.slice(0, 4).map((entry) => (
            <RandomAvatar key={`${entry}-${take}`} seed={entry} ground={ground} animateOnMount className="size-16" />
          ))}
          <Button variant="secondary" onClick={() => setTake((count) => count + 1)}>
            Paint again
          </Button>
        </div>
      </Section>
    </main>
  )
}
