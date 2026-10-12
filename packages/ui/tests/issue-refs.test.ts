import { describe, expect, it } from 'vitest'

import { issueHref, parseIssueHref, splitIssueRefs } from '@/lib/issue-refs'

describe('issue references in an answer', () => {
  it('links each #123 in prose', () => {
    expect(splitIssueRefs('Issue #249 is tracked; see #282.')).toEqual(['Issue ', { raw: '#249', url: issueHref(249) }, ' is tracked; see ', { raw: '#282', url: issueHref(282) }, '.'])
  })

  it('leaves colours, entities, anchors and headings alone', () => {
    for (const text of ['color: #123456ff', '&#169;', 'page.html#12', 'a##3']) expect(splitIssueRefs(text)).toEqual([text])
  })

  it('reads its own links back and nothing else', () => {
    expect(parseIssueHref(issueHref(249))).toBe(249)
    expect(parseIssueHref('#249')).toBeNull()
    expect(parseIssueHref('src/a.ts:12')).toBeNull()
  })
})
