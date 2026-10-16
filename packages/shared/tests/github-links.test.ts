import { describe, expect, it } from 'vitest'

import { classifyGitHubLink, htmlImagesToMarkdown, linkIssueRefs, repoUrlOf } from '../src/github-links'

const REPO = 'https://github.com/acme/app'

describe('classifyGitHubLink', () => {
  it('opens an issue or PR of this repository in Canopy', () => {
    expect(classifyGitHubLink(`${REPO}/pull/282`, REPO)).toEqual({ kind: 'issue', number: 282 })
    expect(classifyGitHubLink(`${REPO}/issues/204#issuecomment-1`, REPO)).toEqual({ kind: 'issue', number: 204 })
  })

  it('reads an attached file inside Canopy', () => {
    const url = 'https://github.com/user-attachments/files/32064250/plan.md'
    expect(classifyGitHubLink(url, REPO)).toEqual({ kind: 'attachment', url })
  })

  it('leaves another repository and the web to the browser', () => {
    expect(classifyGitHubLink('https://github.com/other/app/issues/1', REPO).kind).toBe('external')
    expect(classifyGitHubLink('https://example.com', REPO).kind).toBe('external')
  })
})

describe('linkIssueRefs', () => {
  it('links a plain #123 the way GitHub does', () => {
    expect(linkIssueRefs('PR is opened #282 - redesign', REPO)).toBe(`PR is opened [#282](${REPO}/issues/282) - redesign`)
  })

  it('leaves code, existing links and anchors alone', () => {
    const text = 'see `#1`, [#2](x) and\n```\n#3\n```\nurl.com/#4'
    expect(linkIssueRefs(text, REPO)).toBe(text)
  })
})

describe('repoUrlOf', () => {
  it('reads the repository from an issue URL', () => {
    expect(repoUrlOf(`${REPO}/issues/249`)).toBe(REPO)
  })
})

describe('htmlImagesToMarkdown', () => {
  it('turns a pasted screenshot tag into a markdown image', () => {
    const body = '<img width="980" height="641" alt="Image" src="https://github.com/user-attachments/assets/af52d625" />\nFor some reason'
    expect(htmlImagesToMarkdown(body)).toBe('![Image](<https://github.com/user-attachments/assets/af52d625>)\nFor some reason')
  })

  it('takes single quotes, a missing alt, and leaves code and src-less tags alone', () => {
    expect(htmlImagesToMarkdown("<IMG src='a.png'>")).toBe('![](<a.png>)')
    expect(htmlImagesToMarkdown('`<img src="a.png">`')).toBe('`<img src="a.png">`')
    expect(htmlImagesToMarkdown('<img alt="x">')).toBe('<img alt="x">')
  })
})
