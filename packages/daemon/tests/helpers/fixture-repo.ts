import { execa } from 'execa'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface FixtureRepo {
  path: string
  git(...args: string[]): Promise<string>
  write(files: Record<string, string>): void
  commit(files: Record<string, string>, message: string): Promise<string>
  branch(name: string, from?: string): Promise<void>
  cleanup(): void
}

/** A throwaway git repo with deterministic identity; every test gets its own. */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-fixture-')))
  const git = async (...args: string[]): Promise<string> => (await execa('git', args, { cwd: path })).stdout
  const write = (files: Record<string, string>): void => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(path, rel)), { recursive: true })
      writeFileSync(join(path, rel), content)
    }
  }
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.com')
  await git('config', 'commit.gpgsign', 'false')

  return {
    path,
    git,
    write,
    async commit(files, message) {
      write(files)
      await git('add', '-A')
      await git('commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    },
    async branch(name, from = 'HEAD') {
      await git('branch', name, from)
    },
    cleanup: () => rmSync(path, { recursive: true, force: true })
  }
}
