import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

const here = dirname(fileURLToPath(import.meta.url))

/** Serves the built web client at `/` when a build exists (hash routing → index.html only). */
export async function registerStatic(app: FastifyInstance, webDist: string | undefined): Promise<string | null> {
  const root = webDist ?? join(here, '../../../../apps/web/dist')
  if (!existsSync(join(root, 'index.html'))) return null
  await app.register(fastifyStatic, { root, wildcard: true })
  return root
}
