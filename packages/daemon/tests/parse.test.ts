import { describe, expect, it } from 'vitest'

import {
  childrenOf,
  joinChangedFiles,
  parseAheadBehind,
  parseBranches,
  parseLogZ,
  parseNameStatus,
  parseNumstat,
  parsePorcelainV2,
  parseStatusBranch,
  parseStatusEntries,
  UNSTAGED,
  parseWorktreeList
} from '../src/git/parse'

describe('git parsers', () => {
  it('lists one directory level from ls-files output, directories first', () => {
    const paths = ['src/b.ts', 'src/lib/x.ts', 'src/lib/y.ts', 'src/a.ts', 'README.md', 'other/z.ts']
    expect(childrenOf('src', paths)).toEqual([
      { name: 'lib', path: 'src/lib', kind: 'dir' },
      { name: 'a.ts', path: 'src/a.ts', kind: 'file' },
      { name: 'b.ts', path: 'src/b.ts', kind: 'file' }
    ])
    expect(childrenOf('', paths).map((e) => e.path)).toEqual(['other', 'src', 'README.md'])
    expect(childrenOf('src/', paths)).toEqual(childrenOf('src', paths))
  })

  it('parses log -z by field count, even with tabs in subjects', () => {
    const rec = (sha: string, subject: string, parents: string) =>
      [sha, sha.slice(0, 7), 'Ann', 'ann@x.dev', '1700000000', subject, parents, ''].join('\0')
    const out = rec('a'.repeat(40), 'first\tline', '') + rec('b'.repeat(40), 'merge', 'p1 p2')
    const commits = parseLogZ(out)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({ shortSha: 'aaaaaaa', subject: 'first\tline', parents: [], at: 1700000000000 })
    expect(commits[1]?.parents).toEqual(['p1', 'p2'])
  })

  it('parses numstat with binary markers and joins with name-status', () => {
    const numstat = parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0')
    const statuses = parseNameStatus('M\0src/a.ts\0A\0img.png\0D\0gone.ts\0')
    expect(joinChangedFiles(numstat, statuses)).toEqual([
      { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1, binary: false, ...UNSTAGED },
      { path: 'img.png', status: 'A', additions: 0, deletions: 0, binary: true, ...UNSTAGED },
      { path: 'gone.ts', status: 'D', additions: 0, deletions: 0, binary: false, ...UNSTAGED }
    ])
  })

  it('reads porcelain v2 entries per path, including the differently-shaped unmerged records', () => {
    const out =
      [
        '# branch.oid abc',
        '# branch.head feature',
        '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
        '1 .M N... 100644 100644 100755 ccc ccc chmodded.ts',
        // An unmerged record carries three stage modes and three stage shas, not two of each,
        // so reading it at the `1 ` offsets would take a mode for the path.
        'u UU N... 100644 100644 100644 100644 d1 d2 d3 conflict.ts',
        '? new.ts'
      ].join('\0') + '\0'
    const entries = parseStatusEntries(out)
    expect(parseStatusBranch(out)).toBe('feature')
    expect(entries).toEqual([
      { path: 'staged.ts', x: 'M', y: '.', untracked: false, conflicted: false, headSha: 'aaa', indexSha: 'bbb', mode: '100644', sub: 'N...' },
      // The mode staging must use is the worktree one, or a chmod +x is silently dropped.
      { path: 'chmodded.ts', x: '.', y: 'M', untracked: false, conflicted: false, headSha: 'ccc', indexSha: 'ccc', mode: '100755', sub: 'N...' },
      { path: 'conflict.ts', x: 'U', y: 'U', untracked: false, conflicted: true, headSha: null, indexSha: null, mode: '100644', sub: 'N...' },
      { path: 'new.ts', x: '?', y: '?', untracked: true, conflicted: false, headSha: null, indexSha: null, mode: '', sub: 'N...' }
    ])
  })

  it('counts porcelain v2 entries and skips rename sources', () => {
    const out = ['# branch.oid abc', '# branch.head main', '1 M. N... 100644 100644 100644 h h staged.ts', '1 .M N... 100644 100644 100644 h h unstaged.ts',
      '2 R. N... 100644 100644 100644 h h R100 new.ts', 'old.ts', 'u UU N... 100644 100644 100644 100644 h h h conflict.ts', '? untracked.ts'].join('\0') + '\0'
    expect(parsePorcelainV2(out)).toEqual({ head: 'abc', branch: 'main', staged: 2, unstaged: 1, untracked: 1, conflicted: 1 })
  })

  it('parses worktree list, branches and left-right counts', () => {
    const list = 'worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /wt\0HEAD def\0detached\0\0'
    expect(parseWorktreeList(list)).toEqual([
      { path: '/repo', head: 'abc', branch: 'main', prunable: false },
      { path: '/wt', head: 'def', branch: null, prunable: false }
    ])
    expect(parseBranches(['main', 'abc', '100', '*'].join('\0') + '\n' + ['feat', 'def', '200', ''].join('\0') + '\n')).toEqual([
      { name: 'main', sha: 'abc', at: 100000, current: true },
      { name: 'feat', sha: 'def', at: 200000, current: false }
    ])
    expect(parseAheadBehind('2\t5\n')).toEqual({ behind: 2, ahead: 5 })
  })
})
