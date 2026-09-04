import { AgentStreamEvent } from '../schemas/agent'

/**
 * Reads `data: <json>` frames off a fetch Response body. Fetch-based rather than
 * EventSource because EventSource cannot send an Authorization header.
 */
export async function* readSse(response: Response): AsyncGenerator<AgentStreamEvent> {
  if (!response.body) throw new Error('no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = frame.split('\n').find((part) => part.startsWith('data: '))
      if (!line) continue
      // A daemon newer than this client may emit event types it doesn't know; skip those
      // rather than abort the turn.
      const parsed = AgentStreamEvent.safeParse(JSON.parse(line.slice(6)))
      if (parsed.success) yield parsed.data
    }
  }
}
