/**
 * The adapter registry: the one place that knows which engines exist. Everything above it
 * (provisioning, the environment façade, the routes) resolves an adapter by the name in
 * canopy.yaml and never imports an engine module directly, so adding an engine is a change to
 * this file alone — and a project that uses only SQLite never touches the Docker helper.
 */
import type { DbAdapterName } from '@canopy/shared'

import { ApiError } from '../../lib/errors'
import type { DbAdapter, DockerHelper } from '../types'
import type { Canopyd } from '../worktree/canopyd'
import { createMysqlAdapter } from './mysql'
import { createPostgresAdapter } from './postgres'
import { createRedisAdapter } from './redis'
import { createSqliteAdapter } from './sqlite'
import { createViaCanopyd } from './via-canopyd'

export interface DbRegistry {
  adapterFor(name: DbAdapterName): DbAdapter
  all(): DbAdapter[]
}

export interface DbRegistryDeps {
  docker: DockerHelper
  dataRoot: string
  /** With it, forks are made by `canopyd db` wherever it can see the worktree. */
  canopyd?: Canopyd
  /** The project's "use canopyd" setting; on unless told otherwise. */
  canopydEnabled?: (projectId: string) => boolean
}

export function createDbRegistry(deps: DbRegistryDeps): DbRegistry {
  const { canopyd } = deps
  const enabled = deps.canopydEnabled ?? (() => true)
  // canopyd drives every engine, and makes the fork wherever it can see the worktree; see via-canopyd.
  const via = (native: DbAdapter): DbAdapter => (canopyd ? createViaCanopyd({ canopyd, native, enabled }) : native)
  const adapters: Record<DbAdapterName, DbAdapter> = {
    sqlite: via(createSqliteAdapter()),
    postgres: via(createPostgresAdapter(deps.docker)),
    redis: via(createRedisAdapter(deps.docker)),
    mysql: via(createMysqlAdapter(deps.docker, deps.dataRoot))
  }
  return {
    adapterFor(name) {
      const adapter = adapters[name]
      if (!adapter) throw new ApiError(400, 'db_adapter_unknown', `unknown database adapter: ${name}`)
      return adapter
    },
    all: () => Object.values(adapters)
  }
}
