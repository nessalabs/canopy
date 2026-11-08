import { describe, expect, it } from 'vitest'

import { grammarsFor, isImagePath, isMarkdownPath, isSvgPath } from '../src/lib/language'

describe('markdown paths', () => {
  it('matches markdown extensions, case-insensitively, anywhere in the tree', () => {
    for (const path of ['README.md', 'docs/plans/environment.MD', 'a/b/notes.markdown', 'x.mdx', 'x.mkd', 'x.mdown']) {
      expect(isMarkdownPath(path), path).toBe(true)
    }
  })

  it('leaves everything else to the source view', () => {
    for (const path of ['src/index.ts', 'README', 'docs/md', 'a.md.ts', 'weird.mdy', 'no-extension/.gitignore']) {
      expect(isMarkdownPath(path), path).toBe(false)
    }
  })
})

describe('image paths', () => {
  it('matches what a browser can draw, case-insensitively', () => {
    for (const path of ['logo.png', 'docs/assets/after-login-390.PNG', 'a/b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.avif', 'g.bmp', 'favicon.ico', 'icon.svg']) {
      expect(isImagePath(path), path).toBe(true)
    }
  })

  it('leaves everything else alone, and knows only svg has a text source', () => {
    for (const path of ['src/index.ts', 'README.md', 'png', 'a.png.ts', 'photo.tiff', 'clip.mp4']) {
      expect(isImagePath(path), path).toBe(false)
    }
    expect(isSvgPath('icon.svg')).toBe(true)
    expect(isSvgPath('icon.png')).toBe(false)
  })
})

describe('grammar warmup', () => {
  it('maps a change set to the grammars it needs, deduped and stable', () => {
    expect(grammarsFor(['src/a.ts', 'src/b.ts', 'src/c.tsx', 'api/main.py'])).toEqual(['python', 'tsx', 'typescript'])
  })

  it('skips files with no grammar rather than guessing one', () => {
    expect(grammarsFor(['LICENSE', 'logo.png', 'data.bin'])).toEqual([])
  })
})
