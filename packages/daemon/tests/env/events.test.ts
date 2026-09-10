import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../../src/env/events/bus'

const hostSample = () => ({ t: 1, cpuPct: 0, cores: [], memUsedMb: 0, memTotalMb: 0 })

describe('event bus', () => {
  it('numbers events from 1 and replays everything a client missed', () => {
    const bus = createEventBus(10)
    expect(bus.seq).toBe(0)
    const first = bus.emit({ type: 'host', sample: hostSample() })
    bus.emit({ type: 'worktree-removed', worktreeId: 'wt1' })
    expect(first.seq).toBe(1)
    expect(bus.seq).toBe(2)

    expect(bus.replay(0)?.map((event) => event.seq)).toEqual([1, 2])
    expect(bus.replay(1)?.map((event) => event.seq)).toEqual([2])
    expect(bus.replay(2)).toEqual([])
    expect(bus.replay(9)).toEqual([])
  })

  it('returns null when the buffer no longer reaches back to the requested seq', () => {
    const bus = createEventBus(3)
    for (let i = 0; i < 5; i += 1) bus.emit({ type: 'host', sample: hostSample() })
    // Buffer holds 3..5, so a client at 0 or 1 has a gap; one at 2 does not.
    expect(bus.replay(0)).toBeNull()
    expect(bus.replay(1)).toBeNull()
    expect(bus.replay(2)?.map((event) => event.seq)).toEqual([3, 4, 5])
  })

  it('keeps delivering to healthy listeners when one throws', () => {
    const bus = createEventBus()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: number[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    const off = bus.subscribe((event) => seen.push(event.seq))
    bus.emit({ type: 'host', sample: hostSample() })
    off()
    bus.emit({ type: 'host', sample: hostSample() })
    expect(seen).toEqual([1])
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})
