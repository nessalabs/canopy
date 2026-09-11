import { describe, expect, it } from 'vitest'

import { answerFor, answeredInput, parseAskQuestions } from '../src/lib/ask-questions'

const input = {
  questions: [
    {
      question: 'Which database?',
      header: 'Storage',
      options: [
        { label: 'Postgres', description: 'What the daemon already speaks' },
        { label: 'SQLite' }
      ],
      multiSelect: false
    },
    { question: 'Which to test?', options: [{ label: 'Unit' }, { label: 'E2E' }], multiSelect: true }
  ]
}

describe('parseAskQuestions', () => {
  it('reads the questions, their options and their descriptions', () => {
    const questions = parseAskQuestions(input)
    expect(questions).toHaveLength(2)
    expect(questions?.[0]).toMatchObject({ question: 'Which database?', header: 'Storage', multiSelect: false })
    expect(questions?.[0]?.options).toEqual([{ label: 'Postgres', description: 'What the daemon already speaks' }, { label: 'SQLite' }])
    expect(questions?.[1]?.multiSelect).toBe(true)
  })

  it('defaults a question with no options to a free-text one', () => {
    expect(parseAskQuestions({ questions: [{ question: 'Anything else?' }] })?.[0]).toEqual({ question: 'Anything else?', options: [], multiSelect: false })
  })

  it('refuses anything that is not shaped like an ask, rather than half-reading it', () => {
    expect(parseAskQuestions(undefined)).toBeNull()
    expect(parseAskQuestions({ questions: [] })).toBeNull()
    expect(parseAskQuestions({ questions: [{ prompt: 'no question key' }] })).toBeNull()
    expect(parseAskQuestions({ command: 'ls' })).toBeNull()
  })
})

describe('answerFor', () => {
  it('sends one label as it stands', () => {
    expect(answerFor(['Postgres'], '')).toBe('Postgres')
  })

  it('comma-joins a multi-select', () => {
    expect(answerFor(['Unit', 'E2E'], '')).toBe('Unit, E2E')
  })

  it('takes free text on its own, or after the labels picked', () => {
    expect(answerFor([], ' DuckDB ')).toBe('DuckDB')
    expect(answerFor(['Unit'], 'and a smoke test')).toBe('Unit, and a smoke test')
  })

  it('is empty until something is answered, which is what gates the button', () => {
    expect(answerFor([], '   ')).toBe('')
  })
})

describe('answeredInput', () => {
  it('keeps what the agent proposed and hangs the answers off it', () => {
    const answers = { 'Which database?': 'Postgres', 'Which to test?': 'Unit, E2E' }
    expect(answeredInput(input, answers)).toEqual({ ...input, answers })
  })
})
