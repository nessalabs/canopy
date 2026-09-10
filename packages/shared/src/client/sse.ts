import { AgentStreamEvent } from '../schemas/agent'

/**
 * Reads `data: <json>` frames off a fetch Response body, yielding those `parse` accepts.
 * Fetch-based rather than EventSource because EventSource cannot send an Authorization header.
 */
export async function* readSseWith<T>(response: Response, parse: (raw: unknown) => T | undefined): AsyncGenerator<T> {
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
      // rather than abort the stream.
      const parsed = parse(JSON.parse(line.slice(6)))
      if (parsed !== undefined) yield parsed
    }
  }
}

export function readSse(response: Response): AsyncGenerator<AgentStreamEvent> {
  return readSseWith(response, (raw) => {
    const parsed = AgentStreamEvent.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  })
}
