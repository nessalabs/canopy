import { query } from '@anthropic-ai/claude-agent-sdk'
const cwd = process.argv[2]
const commands = process.argv.slice(3)
const outbox = []; let wake
async function* input() { while (true) { if (outbox.length) { yield outbox.shift(); continue } await new Promise((r) => (wake = r)) } }
const send = (text) => { outbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }); wake?.() }
const q = query({ prompt: input(), options: { cwd, permissionMode: 'plan', maxTurns: 1, model: 'haiku' } })
await q.initializationResult()
const results = {}
let i = 0
send(commands[0])
let types = [], texts = []
const t0 = Date.now()
for await (const m of q) {
  types.push(m.type + (m.subtype ? '/' + m.subtype : ''))
  if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'text') texts.push(b.text)
  if (m.type === 'system' && m.subtype === 'local_command_output') texts.push('[local] ' + m.content)
  if (m.type === 'conversation_reset') texts.push('[conversation_reset]')
  if (m.type === 'result') {
    results[commands[i]] = { types: types.filter(t => !t.startsWith('stream_event')).join(','), turns: m.num_turns, cost: m.total_cost_usd, text: texts.join(' | ').replace(/\s+/g, ' ').slice(0, 160) }
    console.log(JSON.stringify({ cmd: commands[i], ...results[commands[i]] }))
    i++; types = []; texts = []
    if (i >= commands.length) break
    send(commands[i])
  }
  if (Date.now() - t0 > 240000) { console.log('TIMEOUT at', commands[i]); break }
}
await q.return()
