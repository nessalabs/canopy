import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { routes } from '@canopy/shared'

import { listDirectories } from '../lib/fs-browse'

const DirsQuery = z.object({ path: z.string().optional(), hidden: z.enum(['1', 'true', '0', 'false']).optional() })

/** Folder browsing for the Add-project picker: directories under a path on the daemon's machine. */
export function registerFsRoutes(app: FastifyInstance): void {
  app.get(routes.fsDirs(), async (request) => {
    const { path, hidden } = DirsQuery.parse(request.query)
    return listDirectories(path, { hidden: hidden === '1' || hidden === 'true' })
  })
}
