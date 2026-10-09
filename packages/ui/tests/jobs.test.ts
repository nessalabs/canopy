import { describe, expect, it } from 'vitest'

import { createJobStore } from '../src/lib/jobs'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe('job store', () => {
  it('drops the result of a job dismissed and replaced before it landed', async () => {
    const store = createJobStore<string>()
    const first = deferred<string>()
    const second = deferred<string>()
    store.start('k', () => first.promise)
    store.dismiss('k')
    store.start('k', () => second.promise)

    first.resolve('old')
    await first.promise
    expect(store.get('k')).toEqual({ status: 'running' })

    second.resolve('new')
    await second.promise
    expect(store.take('k')).toBe('new')
  })
})
