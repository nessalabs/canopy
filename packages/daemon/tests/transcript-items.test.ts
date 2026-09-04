import { describe, expect, it } from 'vitest'

import { itemsFromBlocks } from '../src/agents/claude'

describe('itemsFromBlocks', () => {
  it('keeps thinking and the reply as separate rows', () => {
    const items = itemsFromBlocks('assistant', [{ type: 'thinking', thinking: 'weigh options' }, { type: 'text', text: 'Do X.' }], 'm1')
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ['reasoning', 'weigh options'],
      ['assistant', 'Do X.']
    ])
  })

  it('surfaces a tool call\'s description as its title', () => {
    const [call] = itemsFromBlocks('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }], 'm2')
    expect(call).toMatchObject({ role: 'tool', tool: 'Bash', title: 'Run the tests', text: 'npm test' })
    const [plain] = itemsFromBlocks('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }], 'm3')
    expect(plain?.title).toBeUndefined()
  })
})

describe('itemsFromBlocks files', () => {
  it('tags file-writing tool calls with the path they wrote', () => {
    const [edit] = itemsFromBlocks('assistant', [{ type: 'tool_use', name: 'Edit', input: { file_path: '/wt/a.ts', old_string: 'x', new_string: 'y' } }], 'm4')
    expect(edit?.files).toEqual(['/wt/a.ts'])
    const [notebook] = itemsFromBlocks('assistant', [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/wt/n.ipynb' } }], 'm5')
    expect(notebook?.files).toEqual(['/wt/n.ipynb'])
    const [read] = itemsFromBlocks('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/wt/a.ts' } }], 'm6')
    expect(read?.files).toBeUndefined()
  })

  it('parses the files a Bash command writes, relative to the session cwd', () => {
    const [bash] = itemsFromBlocks('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'cat > src/x.ts <<EOF\nhi\nEOF' } }], 'm7', '/wt')
    expect(bash?.files).toEqual(['/wt/src/x.ts'])
    const [grep] = itemsFromBlocks('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -r foo src' } }], 'm8', '/wt')
    expect(grep?.files).toBeUndefined()
  })
})
