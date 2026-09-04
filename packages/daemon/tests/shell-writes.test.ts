import { describe, expect, it } from 'vitest'

import { shellWriteTargets, tokenize } from '../src/agents/edit-diffs/shell-writes'

const CWD = '/wt'

describe('shellWriteTargets', () => {
  it.each<[string, string[]]>([
    ['cat > src/a.ts <<\'EOF\'\nhello > not-a-file\nEOF\necho ok', ['/wt/src/a.ts']],
    ['echo x >> notes.md && echo y > /tmp/out', ['/wt/notes.md', '/tmp/out']],
    ['npm test 2>&1 | tee /dev/null; ls > /dev/stderr', []],
    ['sed -i "s/a/b/" src/a.ts src/b.ts', ['/wt/src/a.ts', '/wt/src/b.ts']],
    ['sed -i -e s/a/b/ x.ts', ['/wt/x.ts']],
    ['sed "s/a/b/" x.ts', []],
    ['cp a.ts b.ts; mv -f c.ts dir/d.ts; rm -rf old', ['/wt/b.ts', '/wt/dir/d.ts', '/wt/old']],
    ['cd packages/ui && touch src/new.ts', ['/wt/packages/ui/src/new.ts']],
    ['S=/tmp/s; mkdir -p $S; cat > $S/e2e.cjs <<EOF\nx\nEOF', ['/tmp/s/e2e.cjs']],
    ['python3 - <<\'EOF\'\np=\'packages/shared/src/a.ts\'; s=open(p).read()\nopen(p,\'w\').write(s)\nopen("/abs/b.txt", "a").write("x")\nEOF', ['/wt/packages/shared/src/a.ts', '/abs/b.txt']],
    ['python3 - <<EOF\np=\'a.ts\'; s=open(p).read()\nopen(p,\'w\').write(s)\np=\'b.ts\'; s=open(p).read()\nopen(p,\'w\').write(s)\nEOF', ['/wt/a.ts', '/wt/b.ts']],
    ['node -e "require(\'fs\').writeFileSync(\'out.json\', \'{}\')"', ['/wt/out.json']],
    ['bash -c "echo hi > inner.txt"', ['/wt/inner.txt']],
    ['grep -rn foo src | head', []],
    ['echo "a > b" > quoted.txt', ['/wt/quoted.txt']],
    ['sudo tee /etc/x.conf <<EOF\nk=v\nEOF', ['/etc/x.conf']]
  ])('%s', (command, expected) => {
    expect(shellWriteTargets(command, CWD).sort()).toEqual([...expected].sort())
  })

  it('drops relative paths when the cwd is unknown', () => {
    expect(shellWriteTargets('echo x > a.txt; echo y > /abs.txt')).toEqual(['/abs.txt'])
  })

  it('tokenizes heredocs as one body token', () => {
    const tokens = tokenize('cat > f <<EOF\nline1\nline2\nEOF\nls')
    expect(tokens.filter((t) => t.kind === 'heredoc').map((t) => t.text)).toEqual(['line1\nline2'])
    expect(tokens.filter((t) => t.kind === 'word').map((t) => t.text)).toEqual(['cat', 'f', 'ls'])
  })
})
