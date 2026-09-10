/**
 * Database object names. Everything an adapter creates on a shared engine is named from these
 * helpers so two projects (and two worktrees of the same project) can never collide on one server,
 * and so `destroy` can find what `fork` made without consulting any state we might have lost.
 *
 * The names also have to be safe as *unquoted-ish* SQL identifiers: worktree ids are uuids and
 * project/db names come from the filesystem and canopy.yaml, both of which allow characters that
 * would otherwise need quoting or, worse, allow injection through an interpolated statement.
 */
import { ApiError } from '../../lib/errors'

/** Lowercase, alphanumeric-and-underscore, bounded — the intersection of what every engine accepts. */
export function slug(text: string, max = 40): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (cleaned || 'x').slice(0, max)
}

/** The shared seed database for a project+db: built once, cloned per worktree. */
export const templateName = (projectName: string, db: string): string => `tpl_${slug(projectName)}_${slug(db)}`

/** One worktree's fork. Eight characters of the uuid keep the name readable and still unique. */
export const forkName = (worktreeId: string, db: string): string => `wt_${slug(worktreeId.slice(0, 8), 8)}_${slug(db)}`

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Guards every identifier that reaches a statement. Our helpers already produce safe names; this
 * is the assertion that keeps it true when a caller passes something else.
 */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new ApiError(500, 'db_identifier_invalid', `unsafe database identifier: ${name}`)
  return name
}

/** A double-quoted identifier for Postgres, validated first. */
export const quoteIdentifier = (name: string): string => `"${assertIdentifier(name)}"`

/** A backquoted identifier for MySQL, validated first. */
export const backquoteIdentifier = (name: string): string => `\`${assertIdentifier(name)}\``

/** Single-quoted SQL string literal (only ever used for our own names in `WHERE datname = …`). */
export const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`
