import { describe, expect, it } from 'vitest'

import { AgentEventType, CodexAppServerMapper, isEvent, type CodexAppServerFrame } from '@canopy/shared/agent-stream'

import { codexItemFiles, filesFromThread, framesFromThread, type CodexThread } from '../src/agents/codex-replay'

const thread: CodexThread = {
  id: 't1',
  cwd: '/wt',
  turns: [
    {
      id: 'turn1',
      items: [
        { type: 'userMessage', id: 'um1', content: [{ type: 'text', text: 'add a line to notes.txt' }] },
        { type: 'reasoning', id: 'rs1', text: 'edit the file' },
        { type: 'commandExecution', id: 'cmd1', command: 'printf hi >> notes.txt', aggregatedOutput: '', exitCode: 0, cwd: '/wt' },
        { type: 'agentMessage', id: 'msg1', text: 'Done — appended a line.' }
      ]
    }
  ]
}

describe('codex replay', () => {
  it('replays a thread through the app-server mapper as one turn with a command call', () => {
    // One mapper over the whole synthesized stream, or seqs never advance.
    const mapper = new CodexAppServerMapper()
    const all = framesFromThread(thread).flatMap((frame) => mapper.map(frame as unknown as CodexAppServerFrame))

    expect(all.some((event) => isEvent(event, AgentEventType.SessionStarted))).toBe(true)
    const prompt = all.find((event) => isEvent(event, AgentEventType.UserMessage))
    expect(prompt && isEvent(prompt, AgentEventType.UserMessage) ? prompt.payload.text : null).toBe('add a line to notes.txt')

    const call = all.find((event) => isEvent(event, AgentEventType.ToolCallStarted))
    expect(call && isEvent(call, AgentEventType.ToolCallStarted) ? call.payload.kind : null).toBe('shell')
    const done = all.find((event) => isEvent(event, AgentEventType.ToolCallCompleted))
    expect(done && isEvent(done, AgentEventType.ToolCallCompleted) ? done.payload.result.isError : null).toBe(false)

    const text = all.find((event) => isEvent(event, AgentEventType.AssistantText))
    expect(text && isEvent(text, AgentEventType.AssistantText) ? text.payload.text : null).toBe('Done — appended a line.')
    // Events are numbered monotonically for a stable client key.
    expect(all.map((event) => event.seq)).toEqual(all.map((_, index) => index))
  })

  it('attributes the command\'s write target to its call id', () => {
    expect(codexItemFiles(thread.turns![0]!.items[2]!)).toEqual(['/wt/notes.txt'])
    expect(filesFromThread(thread)).toEqual({ cmd1: ['/wt/notes.txt'] })
  })
})
