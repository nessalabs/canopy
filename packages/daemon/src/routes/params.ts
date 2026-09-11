import { z } from 'zod'

import { Against } from '@canopy/shared'

export const IdParams = z.object({ id: z.string() })
/** A project and one of its trash entries, addressed by the salvage commit. */
export const TrashParams = z.object({ id: z.string(), entry: z.string() })
export const CommitParams = z.object({ id: z.string(), sha: z.string() })
export const TreesParams = z.object({ id: z.string(), before: z.string().regex(/^[0-9a-f]{40}$/), after: z.string().regex(/^[0-9a-f]{40}$/) })
export const CommentParams = z.object({ id: z.string(), cid: z.string() })
export const SessionParams = z.object({ provider: z.string(), sid: z.string() })

export const AgainstQuery = z.object({ against: Against.default('head') })
export const PathQuery = z.object({ path: z.string().min(1) })
export const DirQuery = z.object({ path: z.string().default('') })
export const RevQuery = z.object({ rev: z.string().min(1).optional() })
export const ForceQuery = z.object({ force: z.enum(['true', 'false']).optional() })
export const DestroyQuery = ForceQuery.extend({ deleteBranch: z.enum(['true', 'false']).optional() })
export const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), skip: z.coerce.number().int().min(0).default(0) })
export const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(25) })
export const CwdQuery = z.object({ cwd: z.string().optional() })
