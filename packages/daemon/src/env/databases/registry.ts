/**
 * The adapter registry: the one place that knows which engines exist. Everything above it
 * (provisioning, the environment façade, the routes) resolves an adapter by the name in
 * canopy.yaml and never imports an engine module directly, so adding an engine is a change to
 * this file alone — and a project that uses only SQLite never touches the Docker helper.
 */
import type { DbAdapterName } from '@canopy/shared'

import { ApiError } from '../../lib/errors'
import type { DbAdapter, DockerHelper } from '../types'
import { createMysqlAdapter } from './mysql'
import { createPostgresAdapter } from './postgres'
import { createRedisAdapter } from './redis'
import { createSqliteAdapter } from './sqlite'

export interface DbRegistry {
  adapterFor(name: DbAdapterName): DbAdapter
  all(): DbAdapter[]
}

export function createDbRegistry(deps: { docker: DockerHelper; dataRoot: string }): DbRegistry {
  const adapters: Record<DbAdapterName, DbAdapter> = {
    sqlite: createSqliteAdapter(),
    postgres: createPostgresAdapter(deps.docker),
    redis: createRedisAdapter(deps.docker),
    mysql: createMysqlAdapter(deps.docker, deps.dataRoot)
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
