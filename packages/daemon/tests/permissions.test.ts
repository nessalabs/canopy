import { describe, expect, it } from 'vitest'

import { createPermissionDesk } from '../src/agents/permissions'

describe('permission desk', () => {
  it('allows what is waiting on full autonomy, but not a plan, a question, or an ask a rule forced', async () => {
    const desk = createPermissionDesk()
    const bash = desk.ask('s', 'r1', undefined, 'Bash')
    const forced = desk.ask('s', 'r2', undefined, 'Bash', true)
    const plan = desk.ask('s', 'r3', undefined, 'ExitPlanMode')
    desk.allowPending('s', ['ExitPlanMode', 'AskUserQuestion'])
    expect(await bash).toEqual({ requestId: 'r1', behavior: 'allow' })
    expect(desk.pending('s').sort()).toEqual(['r2', 'r3'])
    desk.answer('s', { requestId: 'r2', behavior: 'deny' })
    desk.answer('s', { requestId: 'r3', behavior: 'deny' })
    expect((await forced).behavior).toBe('deny')
    expect((await plan).behavior).toBe('deny')
  })
})
