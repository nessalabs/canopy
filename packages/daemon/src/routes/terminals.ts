import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { CreateTerminalInput, TerminalClientMessage, routes } from '@canopy/shared'

import type { Services } from './context'
import { IdParams } from './params'

const TerminalParams = z.object({ tid: z.string() })

/**
 * The in-app terminal: list and start a worktree's shells, close one, and the socket that carries
 * a shell's output out and its keystrokes in.
 */
export function registerTerminalRoutes(app: FastifyInstance, { terminals, worktrees }: Services): void {
  app.get(routes.terminals(':id'), async (request) => ({ terminals: terminals.list(IdParams.parse(request.params).id) }))

  app.post(routes.terminals(':id'), async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    worktrees.location(id)
    const terminal = terminals.create(id, CreateTerminalInput.parse(request.body ?? {}))
    return reply.code(201).send({ terminal })
  })

  app.delete(routes.terminal(':tid'), async (request, reply) => {
    terminals.close(TerminalParams.parse(request.params).tid)
    return reply.code(204).send()
  })

  app.get(routes.terminalSocket(':tid'), { websocket: true }, (socket, request) => {
    const { tid } = TerminalParams.parse(request.params)
    let detach: () => void
    try {
      detach = terminals.attach(tid, (message) => socket.send(JSON.stringify(message)))
    } catch {
      socket.close(4404, 'no such terminal')
      return
    }
    // A listener's throw would escape Fastify and end the daemon with every shell in it, so a
    // frame that is not a message is dropped, and one for a terminal closed since ends the socket.
    socket.on('message', (raw) => {
      let parsed
      try {
        parsed = TerminalClientMessage.safeParse(JSON.parse(String(raw)))
      } catch {
        return
      }
      if (!parsed.success) return
      const message = parsed.data
      try {
        if (message.type === 'input') terminals.write(tid, message.data)
        else terminals.resize(tid, message.cols, message.rows)
      } catch {
        socket.close(4404, 'no such terminal')
      }
    })
    socket.on('close', () => detach())
  })
}
