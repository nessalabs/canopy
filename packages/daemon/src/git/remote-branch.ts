/**
 * Remote branches: listing what a remote has, and turning one into a local branch a worktree can
 * check out. Kept apart from repo.ts because both steps make decisions (throttling, refusing to
 * drop local commits), not just one git command each.
 */
import type { RemoteBranch } from '@canopy/shared'

import { badRequest, conflict } from '../lib/errors'
import type { GitRunner } from './exec'

/**
 * A fetch must never sit on a prompt the daemon cannot answer: no terminal for a password, no
 * askpass helper (an empty GIT_ASKPASS also disables core.askPass and SSH_ASKPASS, which could
 * open a GUI prompt), and SSH in batch mode so a passphrase-locked key fails instead of hanging.
 * A user's own GIT_SSH_COMMAND wins, since they set it for a reason.
 */
const fetchEnv = (): Record<string, string> => ({
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
})

const FETCH_TIMEOUT_MS = 60_000
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Names reach git as arguments; a leading dash would be read as an option. */
async function assertNames(git: GitRunner, repo: string, remote: string, name: string): Promise<void> {
  if (!REMOTE_NAME.test(remote)) throw badRequest('invalid_remote', `${remote} is not a remote name`)
  const valid = !name.startsWith('-') && (await git(repo, ['check-ref-format', '--branch', name]).then(() => true, () => false))
  if (!valid) throw badRequest('invalid_branch', `${name} is not a branch name`)
}

export async function hasRemote(git: GitRunner, repo: string, remote: string): Promise<boolean> {
  const out = await git(repo, ['remote'])
  return out.split('\n').includes(remote)
}

/** `git fetch --prune` of one remote; prune so branches deleted there (merged PRs) leave the list. */
export async function fetchRemote(git: GitRunner, repo: string, remote: string): Promise<void> {
  if (!REMOTE_NAME.test(remote)) throw badRequest('invalid_remote', `${remote} is not a remote name`)
  await git(repo, ['fetch', '--prune', '--no-tags', '--quiet', remote], { env: fetchEnv(), timeout: FETCH_TIMEOUT_MS })
}

/** The remote's branches as of the last fetch, newest commit first. Its `HEAD` symref is not a branch. */
export async function listRemoteBranches(git: GitRunner, repo: string, remote: string): Promise<RemoteBranch[]> {
  const prefix = `refs/remotes/${remote}/`
  const [remoteOut, localOut] = await Promise.all([
    git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname:short)%00%(committerdate:unix)%00%(symref)', prefix]),
    git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  ])
  const local = new Set(localOut.split('\n').filter(Boolean))
  return remoteOut
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\0'))
    .filter(([ref = '', , , symref = '']) => ref.startsWith(prefix) && symref === '')
    .map(([ref = '', sha = '', at = '0']) => {
      const name = ref.slice(prefix.length)
      return { name, sha, at: Number(at) * 1000, hasLocal: local.has(name) }
    })
}

const resolve = (git: GitRunner, repo: string, ref: string): Promise<string | null> =>
  git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
    (out) => out.trim() || null,
    () => null
  )

const isAncestor = (git: GitRunner, repo: string, older: string, newer: string): Promise<boolean> =>
  git(repo, ['merge-base', '--is-ancestor', older, newer]).then(
    () => true,
    () => false
  )

/** The path of the worktree that has `refs/heads/<name>` checked out, or null. */
async function checkedOutAt(git: GitRunner, repo: string, name: string): Promise<string | null> {
  let path: string | null = null
  for (const line of (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${name}`) return path
  }
  return null
}

/**
 * Makes `refs/heads/<name>` hold what the remote has, so the worktree shows what was pushed:
 * fetches that one branch, then creates a tracking branch, fast-forwards a local branch that is
 * behind, or keeps one that is ahead. A local branch that has diverged is refused, because
 * moving it would discard commits that exist nowhere else. Returns a one-line summary.
 */
export async function prepareRemoteBranch(
  git: GitRunner,
  repo: string,
  spec: { remote: string; name: string },
  log: (line: string) => void
): Promise<string> {
  const { remote, name } = spec
  await assertNames(git, repo, remote, name)
  const remoteRef = `refs/remotes/${remote}/${name}`
  const localRef = `refs/heads/${name}`

  log(`git fetch ${remote} ${name}`)
  try {
    await git(repo, ['fetch', '--no-tags', '--quiet', remote, `+${localRef}:${remoteRef}`], { env: fetchEnv(), timeout: FETCH_TIMEOUT_MS })
  } catch (error) {
    // Offline is not fatal when an earlier fetch already brought the branch in.
    if (!(await resolve(git, repo, remoteRef))) {
      throw conflict('remote_branch_missing', `${remote}/${name} could not be fetched: ${error instanceof Error ? error.message : String(error)}`)
    }
    log(`fetch failed; using ${remote}/${name} from the last fetch`)
  }
  const remoteSha = await resolve(git, repo, remoteRef)
  if (!remoteSha) throw conflict('remote_branch_missing', `${remote} has no branch ${name}`)

  const localSha = await resolve(git, repo, localRef)
  if (!localSha) {
    log(`git branch --track ${name} ${remote}/${name}`)
    await git(repo, ['branch', '--track', name, `${remote}/${name}`])
    return `new branch tracking ${remote}/${name}`
  }
  if (localSha === remoteSha) return `${name} matches ${remote}`

  const at = await checkedOutAt(git, repo, name)
  if (at) throw conflict('branch_checked_out', `${name} is already checked out at ${at}`)

  if (await isAncestor(git, repo, localSha, remoteSha)) {
    log(`fast-forward ${name} to ${remote}/${name}`)
    // Compare-and-swap on the old tip, so a commit landing in between is never thrown away.
    await git(repo, ['update-ref', '-m', `canopy: fast-forward to ${remote}/${name}`, localRef, remoteSha, localSha])
    return `${name} fast-forwarded to ${remote}`
  }
  if (await isAncestor(git, repo, remoteSha, localSha)) {
    log(`${name} is ahead of ${remote}/${name}; keeping the local commits`)
    return `${name} (local, ahead of ${remote})`
  }
  throw conflict(
    'branch_diverged',
    `Your local ${name} and ${remote}/${name} both have commits the other lacks. Pick "Existing branch" to open your local copy, or reconcile the two first.`
  )
}
