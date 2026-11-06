import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isStale, localeFor, markerName, parseFileKey, parseNodeId, readNodes, readToken } from '../src/lib.ts'
import { notice, phaseOf, relativeTime } from '../src/messages.ts'
import { reportMarkdown, summarize, summaryMarkdown } from '../src/report.ts'

const HOOK = fileURLToPath(new URL('../dist/hook.mjs', import.meta.url))
const SERVER = fileURLToPath(new URL('../dist/server.mjs', import.meta.url))
const FAKE_FIGWRIGHT = fileURLToPath(new URL('./fake-figwright.mjs', import.meta.url))
const KEY = 'AbC123'
const LINK = `https://www.figma.com/design/${KEY}/Order?node-id=1-2`

interface FakeFile {
  name: string
  version: string
  last_touched_at: string
}

let server: http.Server
let base: string
let meta: FakeFile
let status: number
let requests: { url?: string; token?: string | string[] }[]
let project: string
let dataDir: string
let home: string
let fakeBin: string

function env(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    FDG_TOKEN: 'mcp-token',
    CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN: 'hook-token',
    FIGMA_API_BASE: base,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PROJECT_DIR: project,
    HOME: home,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    LANG: 'zh_TW.UTF-8',
    LC_ALL: '',
    LC_MESSAGES: '',
    TZ: 'Asia/Taipei',
    NODE_ENV: 'test',
    FDG_FIGWRIGHT_ARGV: JSON.stringify([process.execPath, FAKE_FIGWRIGHT]),
    FAKE_FIGWRIGHT: path.join(home, 'figwright.json'),
    ...extra,
  }
}

function hook(name: string, extra?: Record<string, string>, input: object = {}): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, name], { env: env({ FDG_TOKEN: '', ...extra }) })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stdin.end(JSON.stringify({ session_id: 's1', cwd: project, ...input }))
    child.on('close', (code) => {
      assert.equal(code, 0)
      resolve(stdout ? JSON.parse(stdout) : null)
    })
  })
}

function tool(name: string, args: Record<string, unknown> = {}, extra?: Record<string, string>): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: env({ CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN: '', ...extra }) })
    let stdout = ''
    child.stdout.on('data', (d) => {
      stdout += d
      if (!stdout.includes('\n')) return
      const { result } = JSON.parse(stdout.split('\n')[0])
      child.kill()
      resolve({ ...JSON.parse(result.content[0].text), isError: result.isError })
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`,
    )
  })
}

function fakeClipboard(body: string) {
  fs.writeFileSync(path.join(fakeBin, 'pbcopy'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

async function bind() {
  const { markerName: name } = await tool('start_binding', { mainFileUrl: LINK })
  return tool('finish_binding', { markerName: name })
}

function state(): any {
  return JSON.parse(fs.readFileSync(path.join(project, '.figma-draft-guard/state.json'), 'utf8'))
}

function figma(config: object) {
  fs.writeFileSync(path.join(home, 'figwright.json'), JSON.stringify({ pages: [{ id: '0:1', name: 'Design' }], ...config }))
}

const compareDraft = () => tool('run_comparison', { sessionId: 's1' })

function figwrightCalls(name: string): any[] {
  const log = path.join(home, 'figwright.json.log')
  if (!fs.existsSync(log)) return []
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((call) => call.name === name)
}

function changeMainFile() {
  meta = { ...meta, version: '200', last_touched_at: '2026-11-05T06:20:00Z' }
}

function clearCache() {
  fs.rmSync(path.join(dataDir, `meta-${KEY}.json`), { force: true })
}

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, token: req.headers['x-figma-token'] })
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ file: meta }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => server.close())

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'fdg-project-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdg-data-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fdg-home-'))
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fdg-bin-'))
  // Tests must not touch the real clipboard
  fakeClipboard(`cat > "${path.join(home, 'clipboard')}"`)
  requests = []
  status = 200
  meta = { name: 'Order', version: '100', last_touched_at: '2026-11-03T02:00:00Z' }
})

test('parseFileKey handles Figma link formats', () => {
  assert.equal(parseFileKey(LINK), KEY)
  assert.equal(parseFileKey(`https://figma.com/file/${KEY}/Old`), KEY)
  assert.equal(parseFileKey(`https://www.figma.com/design/${KEY}/branch/Br4nch/Order`), 'Br4nch')
  assert.equal(parseFileKey(KEY), KEY)
  assert.equal(parseFileKey('https://example.com/design/AbC123/x'), null)
  assert.equal(parseFileKey(''), null)
})

test('isStale compares version and time', () => {
  const active = { version: '1', lastTouchedAt: '2026-11-03T00:00:00Z' }
  assert.equal(isStale(active, { version: '1', lastTouchedAt: '2026-11-03T00:00:00Z' }), false)
  assert.equal(isStale(active, { version: '2', lastTouchedAt: '2026-11-03T00:00:00Z' }), true)
  assert.equal(isStale(active, { version: '1', lastTouchedAt: '2026-11-04T00:00:00Z' }), true)
  assert.equal(isStale(active, { version: '1', lastTouchedAt: null }), false)
})

test('readToken reads hook or MCP variables and skips unresolved values', () => {
  assert.equal(readToken({ CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN: 'a', FDG_TOKEN: 'b' }), 'a')
  assert.equal(readToken({ FDG_TOKEN: 'b' }), 'b')
  assert.equal(readToken({ FDG_TOKEN: '${user_config.figma_token}' }), null)
  assert.equal(readToken({ FDG_TOKEN: '' }), null)
})

test('localeFor prefers the bound language, then settings, then the system', () => {
  fs.mkdirSync(path.join(home, '.claude'))
  const state = { fileKey: 'k', fileName: 'f', active: null, pending: null }

  assert.equal(localeFor(state, project, { LANG: 'zh_TW.UTF-8' }), 'zh-TW')
  assert.equal(localeFor(state, project, { LANG: 'en_US.UTF-8' }), 'en')

  fs.mkdirSync(path.join(project, '.claude'))
  fs.writeFileSync(path.join(project, '.claude/settings.json'), '{"language":"繁體中文"}')
  assert.equal(localeFor(state, project, { LANG: 'en_US.UTF-8' }), 'zh-TW')

  assert.equal(localeFor({ ...state, locale: 'en' }, project, { LANG: 'zh_TW.UTF-8' }), 'en')
})

test('binding stores the conversation language for a generic terminal locale', async () => {
  const { markerName: name } = await tool('start_binding', { mainFileUrl: LINK, language: 'zh-TW' })
  await tool('finish_binding', { markerName: name })
  assert.equal(state().locale, 'zh-TW')

  const output = await hook('session-start', { LANG: 'C.UTF-8' })
  assert.match(output.systemMessage, /Draft 已同步/)
})

test('rebinding without a language keeps the stored one', async () => {
  await tool('start_binding', { mainFileUrl: LINK, language: 'en' })
  await tool('start_binding')
  assert.equal(state().locale, 'en')
})

test('markerName includes a readable time and the full version', () => {
  const name = markerName({ version: '123456789', lastTouchedAt: '2026-11-05T10:50:00' })
  assert.equal(name, '🔒 Main file version 11/05 10:50 · 123456789 (do not delete)')
})

test('start_binding holds the version without activating it', async () => {
  const result = await tool('start_binding', { mainFileUrl: LINK })
  assert.equal(result.fileName, 'Order')
  assert.match(result.markerName, /· 100 \(do not delete\)$/)

  assert.equal(state().active, null)
  assert.equal(state().pending.version, '100')
  assert.equal(fs.readFileSync(path.join(project, '.figma-draft-guard/.gitignore'), 'utf8'), '*\n')
  assert.deepEqual(requests[0], { url: `/v1/files/${KEY}/meta`, token: 'mcp-token' })
})

test('the suggested file name reaches the clipboard only after the marker', { skip: process.platform !== 'darwin' }, async () => {
  const started = await tool('start_binding', { mainFileUrl: LINK })
  assert.equal(fs.existsSync(path.join(home, 'clipboard')), false)

  const result = await tool('finish_binding', { markerName: started.markerName })
  assert.equal(result.copiedToClipboard, true)
  assert.match(result.suggestedFileName, /^Order｜draft \d{2}\/\d{2}$/)
  assert.equal(fs.readFileSync(path.join(home, 'clipboard'), 'utf8'), result.suggestedFileName)
})

test('a clipboard failure does not affect binding', { skip: process.platform !== 'darwin' }, async () => {
  fakeClipboard('exit 1')
  const result = await bind()
  assert.equal(result.copiedToClipboard, false)
  assert.equal(result.isError, false)
  assert.equal(state().active.version, '100')
})

test('finish_binding activates the held version', async () => {
  assert.deepEqual((await bind()).watching, 'Order')
  assert.equal(state().active.version, '100')
  assert.equal(state().pending, null)
  assert.equal((await tool('check_status')).status, 'fresh')
})

test('markers differ when the version matches but the time does not', async () => {
  await bind()
  const first = state().active.markerName

  meta = { ...meta, last_touched_at: '2026-11-06T03:59:00Z' }
  assert.equal((await tool('check_status')).status, 'stale')

  const { markerName: name } = await tool('start_binding')
  await tool('finish_binding', { markerName: name })
  assert.equal(state().active.version, '100')
  assert.notEqual(state().active.markerName, first)
})

test('old records without a marker name skip the marker check', async () => {
  await bind()
  const file = path.join(project, '.figma-draft-guard/state.json')
  const current = state()
  delete current.active.markerName
  fs.writeFileSync(file, JSON.stringify(current))

  const output = await hook('session-start')
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /search_nodes/)
})

test('finish_binding requires the held marker', async () => {
  await tool('start_binding', { mainFileUrl: LINK })
  const result = await tool('finish_binding', { markerName: 'wrong' })
  assert.equal(result.error, 'marker-mismatch')
  assert.equal(result.isError, true)
  assert.equal(state().active, null)
})

test('finish_binding requires start_binding first', async () => {
  assert.equal((await tool('finish_binding', { markerName: 'x' })).error, 'not-started')
})

test('an interrupted update still reports out of date', async () => {
  await bind()
  changeMainFile()
  await tool('start_binding')

  assert.equal(state().active.version, '100')
  assert.equal(state().pending.version, '200')
  assert.equal((await tool('check_status')).status, 'stale')
  assert.match((await hook('session-start')).systemMessage, /版本落後/)
})

test('a finished update returns to in sync', async () => {
  await bind()
  changeMainFile()
  const { markerName: name } = await tool('start_binding')
  await tool('finish_binding', { markerName: name })
  assert.equal(state().active.version, '200')
  assert.equal((await tool('check_status')).status, 'fresh')
})

test('an interrupted first binding reports not watching', async () => {
  await tool('start_binding', { mainFileUrl: LINK })
  assert.equal((await tool('check_status')).status, 'not-ready')

  const output = await hook('session-start')
  assert.match(output.systemMessage, /綁定未完成/)
  assert.match(output.hookSpecificOutput.additionalContext, /do not claim/)
})

test('start_binding reports a missing or invalid link', async () => {
  assert.equal((await tool('start_binding')).error, 'missing-link')
  assert.equal((await tool('start_binding', { mainFileUrl: 'https://example.com' })).error, 'missing-link')
})

test('unbound projects: hooks stay silent and check_status reports unbound', async () => {
  assert.equal(await hook('session-start'), null)
  assert.equal(requests.length, 0)
  assert.equal((await tool('check_status')).status, 'unbound')
})

test('in sync: session start reports it and asks to confirm the draft, reads stay silent', async () => {
  await bind()

  const started = await hook('session-start')
  assert.match(started.systemMessage, /✅ Draft 已同步/)
  assert.match(started.hookSpecificOutput.additionalContext, /search_nodes/)
  assert.ok(started.hookSpecificOutput.additionalContext.includes(state().active.markerName))
  assert.equal(requests.at(-1)?.token, 'hook-token')

  assert.equal(await hook('pre-tool-use'), null)
})

test('the session start message follows the locale', async () => {
  await bind()
  const output = await hook('session-start', { LANG: 'en_US.UTF-8' })
  assert.match(output.systemMessage, /✅ Draft in sync/)
})

test('read notices go through Claude in the conversation language, once', async () => {
  await bind()
  changeMainFile()

  const first = await hook('pre-tool-use')
  assert.equal(first.systemMessage, undefined)
  assert.equal(first.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined)
  assert.match(first.hookSpecificOutput.additionalContext, /language of this conversation/)
  assert.match(first.hookSpecificOutput.additionalContext, /"status":"stale"/)

  assert.equal(await hook('pre-tool-use'), null)
})

test('reads during binding tell Claude it can ignore the notice', async () => {
  await bind()
  changeMainFile()
  await tool('start_binding')
  assert.match((await hook('pre-tool-use')).hookSpecificOutput.additionalContext, /bind flow/)
})

test('the hook covers design read tools but not file management or writes', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const matcher = new RegExp(`^${hooks.hooks.PreToolUse[0].matcher}$`)
  const name = (tool: string) => `mcp__figwright__${tool}`

  for (const tool of [
    'get_design_context', 'get_node', 'get_nodes_info', 'get_screenshot', 'get_selection',
    'get_document', 'get_motion_context', 'get_variable_defs', 'get_styles', 'search_nodes',
    'scan_components', 'scan_text_nodes', 'scan_nodes_by_types', 'save_screenshots',
    'save_image_fills', 'export_pdf', 'design_diff', 'component_map', 'token_map', 'icon_map',
  ]) {
    assert.match(name(tool), matcher)
  }
  for (const tool of ['list_files', 'use_file', 'ping', 'create_frame', 'set_fills', 'delete_nodes']) {
    assert.doesNotMatch(name(tool), matcher)
  }
})

test('the session start message is colored by state', async () => {
  await bind()
  assert.match((await hook('session-start')).systemMessage, /^\x1b\[1;32m✅/)

  clearCache()
  changeMainFile()
  const { systemMessage } = await hook('session-start')
  assert.match(systemMessage, /^\x1b\[1;33m⚠️ Draft 版本落後 ｜ 主檔已穩定/)
  assert.match(systemMessage, /\x1b\[0m$/)

  clearCache()
  meta = { ...meta, version: '300', last_touched_at: new Date().toISOString() }
  assert.match((await hook('session-start')).systemMessage, /^\x1b\[1;34m🔵 Draft 版本落後 ｜ 主檔編輯中/)
})

function statusResult() {
  return JSON.parse(fs.readFileSync(path.join(project, '.figma-draft-guard/status.json'), 'utf8')).result
}

test('band status follows out-of-date and update changes', async () => {
  await bind()
  await hook('session-start')
  assert.equal(statusResult(), null)

  clearCache()
  changeMainFile()
  await hook('session-start')
  assert.equal(statusResult().status, 'stale')
  assert.equal(statusResult().mainUpdatedAt, '2026-11-05T06:20:00Z')

  const { markerName: name } = await tool('start_binding')
  assert.notEqual(statusResult(), null)
  await tool('finish_binding', { markerName: name })
  assert.equal(statusResult(), null)
})

test('check_status also updates band status', async () => {
  await bind()
  changeMainFile()
  await tool('check_status')
  assert.equal(statusResult().status, 'stale')
})

test('start_binding reports whether the main file is being edited', async () => {
  assert.equal((await tool('start_binding', { mainFileUrl: LINK })).mainPhase, 'stable')

  meta = { ...meta, last_touched_at: new Date().toISOString() }
  assert.equal((await tool('start_binding')).mainPhase, 'editing')
})

function poll(extra?: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, 'poll'], { env: env({ FDG_TOKEN: 'mcp-token', ...extra }) })
    child.on('close', (code) => {
      assert.equal(code, 0)
      resolve()
    })
  })
}

test('poll marks the band when the main file changes', async () => {
  await bind()
  await hook('session-start')
  assert.equal(statusResult(), null)

  changeMainFile()
  await poll()
  assert.equal(statusResult().status, 'stale')
})

test('poll bypasses the cache so each run sees the latest version', async () => {
  await bind()
  await hook('session-start')
  requests = []
  await poll()
  await poll()
  assert.equal(requests.length, 2)
})

test('poll keeps the current status through a brief outage', async () => {
  await bind()
  changeMainFile()
  await poll()

  status = 500
  await poll()
  assert.equal(statusResult().status, 'stale')
})

test('poll does nothing in an unbound project', async () => {
  await poll()
  assert.equal(requests.length, 0)
})

const frame = (id: string) => ({ nodeId: id, name: id, path: `Flow / ${id} (${id})` })

test('summarize groups changes by what is known to have been read', () => {
  const summary = summarize({
    fileName: 'Order',
    previous: [frame('1:1'), frame('1:2'), frame('1:3'), frame('1:4')],
    current: [frame('1:1'), frame('1:2'), frame('1:3'), frame('1:5')],
    changes: [
      { nodeId: '1:1', changeCount: 2 },
      { nodeId: '1:2', changeCount: 1 },
      { nodeId: '1:3', changeCount: 0 },
    ],
    readNodeIds: ['1:1'],
  })

  assert.deepEqual(summary.read, [{ path: 'Flow / 1:1 (1:1)', changeCount: 2 }])
  assert.deepEqual(summary.other, ['Flow / 1:2 (1:2)'])
  assert.deepEqual(summary.added, ['Flow / 1:5 (1:5)'])
  assert.deepEqual(summary.removed, ['Flow / 1:4 (1:4)'])
  assert.equal(summary.unchanged, 1)
})

const fillChange = {
  node: 'Rectangle 1',
  nodeId: '3:2',
  kind: 'changed' as const,
  field: 'fills',
  before: '#00C0E8',
  after: '#FFCC00',
}

const reportBase = { fileName: 'Order', previous: [frame('1:1')], current: [frame('1:1')], readNodeIds: ['1:1'] }

test('the report renders details from structured changes', () => {
  const report = reportMarkdown(
    {
      ...reportBase,
      changes: [
        {
          nodeId: '1:1',
          changeCount: 3,
          details: [
            fillChange,
            { ...fillChange, field: 'characters', before: undefined, after: 'Hi' },
            { node: 'Badge', nodeId: '3:3', kind: 'added' },
          ],
        },
      ],
    },
    'zh-TW',
    '2026-11-06',
  )

  assert.match(report, /- Flow \/ 1:1 \(1:1\)：3 項變更/)
  assert.match(report, /  - Rectangle 1 \(3:2\)\n    - 填色：#00C0E8 → #FFCC00\n    - 文字：無 → Hi/)
  assert.match(report, /  - Badge \(3:3\)：新增/)
})

test('the report format is exact', () => {
  const input = { ...reportBase, changes: [{ nodeId: '1:1', changeCount: 1, details: [fillChange] }] }
  assert.equal(
    reportMarkdown(input, 'en', '2026-11-06'),
    [
      '# Design comparison',
      '',
      'Order · 2026-11-06',
      '',
      '## Previously read',
      '',
      '- Flow / 1:1 (1:1): 1 change',
      '  - Rectangle 1 (3:2)',
      '    - fills: #00C0E8 → #FFCC00',
      '',
      'Unchanged: 0 frames',
      '',
    ].join('\n'),
  )
})

test('the report notes changes beyond the detail limit', () => {
  const report = reportMarkdown(
    { ...reportBase, changes: [{ nodeId: '1:1', changeCount: 25, details: [fillChange] }] },
    'zh-TW',
    '2026-11-06',
  )
  assert.match(report, /其餘 24 項/)
})

test('long values keep both ends and stay on one line', () => {
  const value = (end: string) => `start\n${'x'.repeat(200)}${end}`
  const report = reportMarkdown(
    {
      ...reportBase,
      changes: [{ nodeId: '1:1', changeCount: 1, details: [{ ...fillChange, before: value('A'), after: value('B') }] }],
    },
    'en',
    '2026-11-06',
  )
  const line = report.split('\n').find((text) => text.includes('fills')) ?? ''
  assert.match(line, /start x.*…x*A → start x.*…x*B$/)
  assert.ok(report.length < 500)
})

test('the report says when nothing changed', () => {
  assert.match(reportMarkdown({ ...reportBase, changes: [] }, 'en', '2026-11-06'), /No changes found/)
})

test('the chat summary leaves details to the report', () => {
  const summary = summaryMarkdown(
    { ...reportBase, changes: [{ nodeId: '1:1', changeCount: 1, details: [fillChange] }] },
    'zh-TW',
    '/tmp/report.md',
  )
  assert.match(summary, /## 曾讀取/)
  assert.match(summary, /1 項變更/)
  assert.doesNotMatch(summary, /#FFCC00/)
  assert.match(summary, /報告：\/tmp\/report\.md$/)
})

test('parseNodeId accepts ids and pasted links', () => {
  assert.equal(parseNodeId('1:2'), '1:2')
  assert.equal(parseNodeId('https://www.figma.com/design/AbC/x?node-id=17892-2900'), '17892:2900')
  assert.equal(parseNodeId('https://www.figma.com/design/AbC/x?node-id=I1-2;3-4'), 'I1:2;3:4')
  assert.equal(parseNodeId('https://www.figma.com/design/AbC/x'), null)
  assert.equal(parseNodeId(undefined), null)
})

const readInput = (toolInput: object) => ({
  tool_name: 'mcp__figwright__get_design_context',
  tool_input: toolInput,
})

const reads = () => readNodes(path.join(project, '.figma-draft-guard'), KEY)

test('full design reads are recorded, structure scans are not', async () => {
  await bind()
  await hook('post-tool-use', {}, readInput({ nodeId: '1:1' }))
  await hook('post-tool-use', {}, readInput({ nodeId: '1:2', detail: 'minimal' }))
  await hook('post-tool-use', {}, readInput({ nodeId: '1:1' }))
  assert.deepEqual(reads(), ['1:1'])
})

test('reads of the selection use the node in the tool result', async () => {
  await bind()
  const text = JSON.stringify({ nodes: [{ id: '17892:2604', name: 'dialog' }] })
  await hook('post-tool-use', {}, { ...readInput({}), tool_response: [{ type: 'text', text }] })
  assert.deepEqual(reads(), ['17892:2604'])

  const both = JSON.stringify({ nodes: [{ id: '2:1' }, { id: '2:2' }] })
  await hook('post-tool-use', {}, { ...readInput({}), tool_response: { content: [{ type: 'text', text: both }] } })
  assert.deepEqual(reads(), ['17892:2604', '2:1', '2:2'])
})

test('other tools do not record reads', async () => {
  await bind()
  await hook('post-tool-use', {}, { tool_name: 'mcp__figwright__get_node', tool_input: { nodeId: '1:1' } })
  assert.deepEqual(reads(), [])
})

test('parallel reads are all kept', async () => {
  await bind()
  await Promise.all(['1:1', '1:2', '1:3', '1:4', '1:5'].map((id) => hook('post-tool-use', {}, readInput({ nodeId: id }))))
  assert.equal(reads().length, 5)
})

test('frames that were not compared are not reported as unchanged', () => {
  const summary = summarize({ ...reportBase, changes: [], notComparedIds: ['1:1'] })
  assert.deepEqual(summary.notCompared, ['Flow / 1:1 (1:1)'])
  assert.equal(summary.unchanged, 0)
  assert.match(
    reportMarkdown({ ...reportBase, changes: [], notComparedIds: ['1:1'] }, 'zh-TW', '2026-11-06'),
    /## 未比對/,
  )
})

test('a damaged record can be replaced by binding again', async () => {
  fs.mkdirSync(path.join(project, '.figma-draft-guard'))
  fs.writeFileSync(path.join(project, '.figma-draft-guard/state.json'), '{oops')

  assert.equal((await tool('start_binding')).error, 'bad-record')
  assert.equal((await tool('start_binding', { mainFileUrl: LINK })).fileName, 'Order')
  assert.equal(state().fileKey, KEY)
})

test('poll reports permanent failures but not brief outages', async () => {
  await bind()
  status = 403
  await poll()
  assert.equal(statusResult().code, 'auth')
})

test('English text handles singular counts', () => {
  assert.equal(relativeTime(new Date(Date.parse('2026-11-05T12:00:00Z')).toISOString(), Date.parse('2026-11-06T12:00:00Z'), 'en'), '1 day ago')
  const report = reportMarkdown(
    { ...reportBase, changes: [{ nodeId: '1:1', changeCount: 2, details: [fillChange] }] },
    'en',
    '2026-11-06',
  )
  assert.match(report, /1 more change$/m)
})

test('a frame new to the file is not also listed as changed', () => {
  const summary = summarize({
    ...reportBase,
    current: [frame('1:1'), frame('1:2')],
    changes: [{ nodeId: '1:2', changeCount: 3 }],
  })
  assert.deepEqual(summary.notCompared, [])
  assert.deepEqual(summary.added, ['Flow / 1:2 (1:2)'])
  assert.deepEqual(summary.other, [])
  assert.equal(summary.unchanged, 1)
})

test('set_compare_scope validates and stores the scope', async () => {
  await bind()
  assert.equal((await tool('set_compare_scope', { scope: 'nope' })).error, 'bad-scope')

  await tool('set_compare_scope', { scope: 'pages', pages: ['C'] })
  const context = await tool('compare_context')
  assert.equal(context.scope, 'pages')
  assert.deepEqual(context.pages, ['C'])
})

const fieldDiff = { added: [], removed: [], changed: [{ id: '3:2', name: 'Box', fields: [{ field: 'fills', before: 'a', after: 'b' }] }] }

test('mark_draft skips divider pages and records where the marker went', async () => {
  figma({ pages: [{ id: '0:1', name: '---' }, { id: '0:2', name: 'Design' }] })
  const { markerName: name } = await tool('start_binding', { mainFileUrl: LINK })

  assert.equal((await tool('mark_draft', { sessionId: 's1' })).marked, true)
  assert.equal(figwrightCalls('create_frame')[0].args.parentId, '0:2')
  assert.equal(figwrightCalls('create_frame')[0].args.name, name)
  assert.equal(figwrightCalls('set_visible').length, 1)
  assert.equal(figwrightCalls('lock_nodes').length, 1)

  await tool('finish_binding', { markerName: name })
  assert.equal(state().active.markerPageId, '0:2')
  assert.match((await hook('session-start')).hookSpecificOutput.additionalContext, /root 0:2/)
})

test('mark_draft moves on when a page rejects the marker', async () => {
  figma({ pages: [{ id: '0:1', name: 'Odd' }, { id: '0:2', name: 'Design' }], rejectPages: ['0:1'] })
  await tool('start_binding', { mainFileUrl: LINK })
  assert.equal((await tool('mark_draft', { sessionId: 's1' })).marked, true)
  assert.equal(figwrightCalls('create_frame').at(-1).args.parentId, '0:2')
})

test('mark_draft refuses a draft that already has a marker on any page', async () => {
  figma({
    pages: [{ id: '0:1', name: 'A' }, { id: '0:2', name: 'B' }],
    markers: [{ id: 'm0', name: '🔒 主檔版本 11/05 · 1（請勿刪除）', page: '0:2' }],
  })
  await tool('start_binding', { mainFileUrl: LINK })
  assert.equal((await tool('mark_draft', { sessionId: 's1' })).error, 'old-draft')
  assert.equal(figwrightCalls('create_frame').length, 0)
})

test('the first comparison builds baselines inside the ignored record folder', async () => {
  await bind()
  figma({ frames: ['1:1', '1:2'], created: ['1:1', '1:2'] })

  assert.match((await compareDraft()).summary, /基準已建立：2 個畫面/)
  const { rootDir } = figwrightCalls('design_diff')[0].args
  assert.equal(rootDir, path.join(project, '.figma-draft-guard/baselines', KEY))
  assert.equal((await tool('compare_context')).isFirstComparison, false)
})

test('hidden sections and markers are left out, and paths include sections', async () => {
  await bind()
  figma({
    sections: [
      { id: 's:1', name: 'Flow', type: 'SECTION', parentId: '0:1' },
      { id: 's:2', name: 'Orders', type: 'SECTION', parentId: 's:1' },
      { id: 's:3', name: 'Hidden', type: 'SECTION', parentId: '0:1', visible: false },
      { id: 's:4', name: 'Inner', type: 'SECTION', parentId: 's:3' },
    ],
    sectionChildren: {
      's:2': [
        { id: '1:1', name: 'List', type: 'FRAME' },
        { id: '1:9', name: 'Arrow', type: 'VECTOR' },
        { id: '1:8', name: '🔒 Main file version x', type: 'FRAME' },
      ],
      's:3': [{ id: '2:1', name: 'Skip', type: 'FRAME' }],
      's:4': [{ id: '2:2', name: 'Skip', type: 'FRAME' }],
    },
  })

  await compareDraft()
  assert.deepEqual((await tool('compare_context')).frames, [
    { nodeId: '1:1', name: 'List', path: 'Flow / Orders / List (1:1)' },
  ])
})

test('an update reports changes, then moves the baseline on', async () => {
  await bind()
  figma({ frames: ['1:1', '1:2'] })
  await compareDraft()
  figma({ frames: ['1:1', '1:2'], diffs: { '1:1': fieldDiff }, parents: { '3:2': '1:1' } })
  await hook('post-tool-use', {}, readInput({ nodeId: '3:2' }))

  const { summary } = await compareDraft()
  assert.match(summary, /## 曾讀取\n\n- 1:1 \(1:1\)：1 項變更/)
  assert.match(summary, /無變更：1 個畫面/)

  const report = /報告：(.+)$/.exec(summary)?.[1] ?? ''
  assert.match(fs.readFileSync(report, 'utf8'), /Box \(3:2\)\n    - 填色：a → b/)
  assert.deepEqual(
    figwrightCalls('design_diff').filter((call) => call.args.update).map((call) => call.args.nodeId),
    ['1:1'],
  )
})

test('frames that fail on the first comparison are not counted as ready', async () => {
  await bind()
  figma({ frames: ['1:1', '1:2'], errors: { '1:1': 'Component set for node has existing errors' } })
  const { summary } = await compareDraft()
  assert.match(summary, /基準已建立：1 個畫面/)
  assert.match(summary, /## 未比對\n\n- 1:1/)
})

test('a frame Figwright cannot read is reported and the rest still run', async () => {
  await bind()
  figma({ frames: ['1:1', '1:2'] })
  await compareDraft()
  figma({ frames: ['1:1', '1:2'], errors: { '1:1': 'Component set for node has existing errors' }, diffs: { '1:2': fieldDiff } })

  const { summary } = await compareDraft()
  assert.match(summary, /## 未比對\n\n- 1:1/)
  assert.match(summary, /1:2/)
})

test('the draft must be in front, and leaving it stops without saving', async () => {
  await bind()
  figma({ frames: ['1:1'], front: false })
  assert.equal((await compareDraft()).error, 'draft-not-front')

  figma({ frames: ['1:1'], errors: { '1:1': 'Unable to establish connection to Figma after 10 seconds.' } })
  assert.equal((await compareDraft()).error, 'draft-not-front')
  assert.equal((await tool('compare_context')).isFirstComparison, true)
})

test('added and removed are only listed for a stable full comparison', async () => {
  await bind()
  figma({ frames: ['1:1', '1:2'] })
  await compareDraft()

  await tool('set_compare_scope', { scope: 'read' })
  figma({ frames: ['1:1', '1:5'] })
  assert.doesNotMatch((await compareDraft()).summary, /主檔新增|主檔移除/)

  await tool('set_compare_scope', { scope: 'all' })
  assert.doesNotMatch((await compareDraft()).summary, /主檔新增|主檔移除/)

  figma({ frames: ['1:1', '1:6'] })
  const { summary } = await compareDraft()
  assert.match(summary, /主檔新增/)
  assert.match(summary, /主檔移除/)
})

test('a second report on the same day gets its own file', async () => {
  await bind()
  figma({ frames: ['1:1'] })
  await compareDraft()
  const first = (await compareDraft()).summary
  const second = (await compareDraft()).summary
  assert.notEqual(first, second)
})

test('switching main files keeps comparison data separate', async () => {
  await bind()
  figma({ frames: ['1:1'] })
  await compareDraft()
  await hook('post-tool-use', {}, readInput({ nodeId: '1:1' }))

  const { markerName: name } = await tool('start_binding', { mainFileUrl: 'https://www.figma.com/design/Other9/Next' })
  assert.equal(state().fileKey, KEY)
  const context = await tool('compare_context')
  assert.equal(context.isFirstComparison, true)
  assert.deepEqual(context.readNodes, [])
  assert.match(context.baselineDir, /baselines\/Other9$/)

  figma({ frames: ['9:9'] })
  await compareDraft()
  assert.equal(state().compare.frames[0].nodeId, '1:1')

  await tool('finish_binding', { markerName: name })
  assert.equal(state().fileKey, 'Other9')
  assert.equal(state().compare.frames[0].nodeId, '9:9')
})

test('abandoning a switch keeps the current comparison', async () => {
  await bind()
  figma({ frames: ['1:1'] })
  await compareDraft()
  await tool('start_binding', { mainFileUrl: 'https://www.figma.com/design/Other9/Next' })
  figma({ frames: ['9:9'] })
  await compareDraft()
  await tool('start_binding')
  assert.equal(state().compare.frames[0].nodeId, '1:1')
})

test('an empty baseline still counts as done', async () => {
  await bind()
  figma({ frames: [] })
  await compareDraft()
  assert.equal((await tool('compare_context')).isFirstComparison, false)
})

test('rebinding the same main file keeps comparison data', async () => {
  await bind()
  figma({ frames: ['1:1'] })
  await compareDraft()
  await tool('start_binding')
  assert.equal(state().compare.frames.length, 1)
})

test('session start always notifies again', async () => {
  await bind()
  changeMainFile()
  await hook('pre-tool-use')

  assert.match((await hook('session-start')).systemMessage, /版本落後/)
})

test('Claude does not repeat a notice when the main file changes again', async () => {
  await bind()
  changeMainFile()
  assert.notEqual(await hook('pre-tool-use'), null)

  clearCache()
  meta = { ...meta, version: '300', last_touched_at: '2026-11-05T07:00:00Z' }
  assert.equal(await hook('pre-tool-use'), null)
})

const NOW = Date.parse('2026-11-06T12:00:00Z')
const stale = (minutesAgo: number) => ({
  status: 'stale' as const,
  key: 'stale',
  fileName: 'Order',
  phase: 'stable' as const,
  mainUpdatedAt: new Date(NOW - minutesAgo * 60000).toISOString(),
  draftFromUpdatedAt: '2026-11-01T00:00:00Z',
})

test('within 30 minutes is editing, later is stable', () => {
  assert.equal(phaseOf(stale(29).mainUpdatedAt, NOW), 'editing')
  assert.equal(phaseOf(stale(30).mainUpdatedAt, NOW), 'stable')
  assert.equal(phaseOf(null, NOW), 'stable')
})

test('editing and stable differ in text and color', () => {
  assert.deepEqual(notice(stale(5), 'zh-TW', NOW), {
    tone: 'blue',
    text: '🔵 Draft 版本落後 ｜ 主檔編輯中 ｜ 最後變更：5 分鐘前',
  })
  assert.deepEqual(notice(stale(32), 'zh-TW', NOW), {
    tone: 'yellow',
    text: '⚠️ Draft 版本落後 ｜ 主檔已穩定 ｜ 最後變更：32 分鐘前 ｜ 可更新',
  })
  assert.equal(
    notice(stale(32), 'en', NOW).text,
    '⚠️ Draft out of date | Main file stable | Last change: 32 min ago | Ready to update',
  )
})

test('relativeTime switches units by length', () => {
  const ago = (minutes: number) => stale(minutes).mainUpdatedAt
  assert.equal(relativeTime(ago(0), NOW, 'zh-TW'), '不到 1 分鐘前')
  assert.equal(relativeTime(ago(59), NOW, 'zh-TW'), '59 分鐘前')
  assert.equal(relativeTime(ago(120), NOW, 'zh-TW'), '2 小時前')
  assert.equal(relativeTime(ago(2880), NOW, 'en'), '2 days ago')
  assert.equal(relativeTime(null, NOW, 'zh-TW'), '未知')
})

test('repeat checks within 5 minutes call the API once', async () => {
  await bind()
  requests = []
  await hook('pre-tool-use')
  await hook('pre-tool-use')
  assert.equal(requests.length, 1)
})

test('rebinding is not misjudged by an old cache', async () => {
  await bind()
  changeMainFile()
  await hook('pre-tool-use')

  await new Promise((resolve) => setTimeout(resolve, 5))
  const { markerName: name } = await tool('start_binding')
  await tool('finish_binding', { markerName: name })
  assert.equal(await hook('pre-tool-use'), null)
})

const FAILURES: [number, RegExp][] = [
  [403, /token 無效/],
  [404, /找不到主檔/],
  [429, /速率限制/],
  [500, /無法連線/],
]

for (const [code, pattern] of FAILURES) {
  test(`API ${code} does not block and reports a failed check`, async () => {
    await bind()
    clearCache()
    status = code

    const output = await hook('session-start')
    assert.match(output.systemMessage, /版本檢查失敗/)
    assert.match(output.systemMessage, pattern)
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined)
    assert.equal((await tool('check_status')).status, 'failed')
  })
}

test('without a token no API call is made and it points to /plugin', async () => {
  await bind()
  clearCache()
  requests = []

  const output = await hook('session-start', { CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN: '' , FDG_TOKEN: '' })
  assert.match(output.systemMessage, /\/plugin/)
  assert.equal(requests.length, 0)
  assert.equal((await tool('start_binding', {}, { FDG_TOKEN: '' })).error, 'no-token')
})

test('API failures are not retried immediately', async () => {
  await bind()
  status = 500
  requests = []
  await hook('pre-tool-use')
  await hook('pre-tool-use')
  assert.equal(requests.length, 1)
})

test('the hook exits normally when the API is unreachable', async () => {
  await bind()
  const output = await hook('session-start', { FIGMA_API_BASE: 'http://127.0.0.1:1' })
  assert.match(output.systemMessage, /無法連線/)
})

test('a damaged record is reported without blocking', async () => {
  fs.mkdirSync(path.join(project, '.figma-draft-guard'))
  fs.writeFileSync(path.join(project, '.figma-draft-guard/state.json'), '{oops')
  assert.match((await hook('session-start')).systemMessage, /紀錄損毀/)
  assert.equal((await tool('check_status')).error, 'bad-record')
})

test('subfolders find the project record', async () => {
  await bind()
  const nested = path.join(project, 'frontend', 'src')
  fs.mkdirSync(nested, { recursive: true })
  const output = await hook('session-start', { CLAUDE_PROJECT_DIR: nested })
  assert.match(output.systemMessage, /✅ Draft 已同步/)
})

test('the MCP server answers initialize and tools/list', async () => {
  const child = spawn(process.execPath, [SERVER], { env: env() })
  const lines: any[] = []
  let buffer = ''
  const done = new Promise<void>((resolve) => {
    child.stdout.on('data', (d) => {
      buffer += d
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      lines.push(...parts.map((line) => JSON.parse(line)))
      if (lines.length === 2) resolve()
    })
  })
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
  )
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  await done
  child.kill()

  const byId = Object.fromEntries(lines.map((line) => [line.id, line.result]))
  assert.equal(byId[1].protocolVersion, '2025-06-18')
  assert.deepEqual(
    byId[2].tools.map((item: { name: string }) => item.name),
    ['start_binding', 'finish_binding', 'compare_context', 'set_compare_scope', 'mark_draft', 'run_comparison', 'check_status'],
  )
  assert.equal(byId[2].tools[0].run, undefined)
})
