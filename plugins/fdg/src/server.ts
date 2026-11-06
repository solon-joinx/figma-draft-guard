import readline from 'node:readline'
import {
  GuardError,
  assess,
  baselineDir,
  compareState,
  copyToClipboard,
  fetchMeta,
  isBaselineReady,
  localeFor,
  markerName,
  newRecordDir,
  parseFileKey,
  readNodes,
  readRecord,
  suggestedFileName,
  targetFileKey,
  toLocale,
  withCompare,
  writeRecord,
  writeReport,
  writeStatus,
} from './lib.ts'
import { phaseOf } from './messages.ts'
import { acceptChanges, compareDraft, DraftNotInFront, markDraft } from './compare.ts'
import { Figwright, FigwrightError } from './figwright.ts'
import { baselineMarkdown, reportMarkdown, summaryMarkdown } from './report.ts'
import type { CompareScope } from './lib.ts'

type ToolArgs = Record<string, unknown>
type ToolResult = Record<string, unknown>

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: ToolArgs) => ToolResult | Promise<ToolResult>
}

interface RpcMessage {
  id?: number | string
  method: string
  params?: { protocolVersion?: string; name?: string; arguments?: ToolArgs }
}

const projectDir = () => process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

const TOOLS: Tool[] = [
  {
    name: 'start_binding',
    description:
      'Read the main Figma file version and hold it until a new draft is ready. Does not change the active record. Omit mainFileUrl to reuse the bound main file.',
    inputSchema: {
      type: 'object',
      properties: {
        mainFileUrl: { type: 'string', description: 'Figma main file link' },
        language: { type: 'string', description: 'Language of this conversation, such as zh-TW or en' },
      },
    },
    run: startBinding,
  },
  {
    name: 'finish_binding',
    description:
      'Make the held version the active record. Call only after the marker from start_binding exists in the new draft.',
    inputSchema: {
      type: 'object',
      properties: { markerName: { type: 'string', description: 'Marker name written to the draft' } },
      required: ['markerName'],
    },
    run: finishBinding,
  },
  {
    name: 'compare_context',
    description: 'Return the comparison scope, known frames and nodes read so far.',
    inputSchema: { type: 'object', properties: {} },
    run: compareContext,
  },
  {
    name: 'set_compare_scope',
    description: 'Set which frames to compare: all, pages (with page names), or read (only frames read before).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'pages', 'read'] },
        pages: { type: 'array', items: { type: 'string' }, description: 'Page names when scope is pages' },
      },
      required: ['scope'],
    },
    run: setCompareScope,
  },
  {
    name: 'mark_draft',
    description:
      'Write the version marker into the draft with this Figwright sessionId. Returns old-draft when it already has a marker.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'From Figwright list_files' } },
      required: ['sessionId'],
    },
    run: markDraftTool,
  },
  {
    name: 'run_comparison',
    description:
      'List frames, build or compare baselines, and write the report. The draft must be in front in Figma. Returns draft-not-front otherwise. Show the returned summary as it is.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'From Figwright list_files' } },
      required: ['sessionId'],
    },
    run: runComparison,
  },
  {
    name: 'check_status',
    description: 'Compare the active record with the current main Figma file version.',
    inputSchema: { type: 'object', properties: {} },
    run: checkStatus,
  },
]

// A damaged record must not block the one action that can replace it
function recoverableRecord(mainFileUrl: string | undefined) {
  try {
    return readRecord(projectDir())
  } catch (error) {
    if (mainFileUrl && error instanceof GuardError && error.code === 'bad-record') return null
    throw error
  }
}

async function startBinding(args: ToolArgs): Promise<ToolResult> {
  const { mainFileUrl, language } = args as { mainFileUrl?: string; language?: string }
  const record = recoverableRecord(mainFileUrl)
  const fileKey = mainFileUrl ? parseFileKey(mainFileUrl) : record?.state.fileKey
  if (!fileKey) {
    return { error: 'missing-link', message: 'A valid Figma main file link is required.' }
  }

  const meta = await fetchMeta(fileKey)
  const marker = markerName(meta)

  // The current binding stays as it is until finish_binding, so a wrong link costs nothing
  writeRecord(record?.recordDir ?? newRecordDir(projectDir()), {
    fileKey: record?.state.fileKey ?? fileKey,
    fileName: record?.state.fileName ?? meta.name,
    locale: language ? toLocale(language) : record?.state.locale,
    compare: record?.state.compare,
    active: record?.state.active ?? null,
    pending: {
      fileKey,
      fileName: meta.name,
      version: meta.version,
      lastTouchedAt: meta.lastTouchedAt,
      markerName: marker,
    },
  })

  return {
    fileName: meta.name,
    markerName: marker,
    mainPhase: phaseOf(meta.lastTouchedAt, Date.now()),
    mainUpdatedAt: meta.lastTouchedAt,
  }
}

function finishBinding({ markerName: name }: ToolArgs): ToolResult {
  const record = readRecord(projectDir())
  const pending = record?.state.pending
  if (!record || !pending) return { error: 'not-started', message: 'Call start_binding first.' }
  if (pending.markerName !== name) {
    return { error: 'marker-mismatch', message: `Expected marker: ${pending.markerName}` }
  }

  const { fileKey, fileName: boundName, version, lastTouchedAt, markerName: activeMarker, markerPageId } = pending
  writeRecord(record.recordDir, {
    ...record.state,
    fileKey,
    fileName: boundName,
    compare: fileKey === record.state.fileKey ? record.state.compare : pending.compare,
    active: { version, lastTouchedAt, markerName: activeMarker, markerPageId, boundAt: new Date().toISOString() },
    pending: null,
  })
  writeStatus(record.recordDir, null, localeFor(record.state, projectDir()))

  // Offer the name only now: renaming before the marker is written can get reverted
  const fileName = suggestedFileName({ name: boundName })
  return {
    watching: boundName,
    suggestedFileName: fileName,
    copiedToClipboard: copyToClipboard(fileName),
  }
}

async function checkStatus(): Promise<ToolResult> {
  const record = readRecord(projectDir())
  if (!record) return { status: 'unbound' }

  const { fileKey } = record.state
  const result = await assess(record.state, () => fetchMeta(fileKey))
  writeStatus(record.recordDir, result, localeFor(record.state, projectDir()))

  const { key, ...facts } = result
  return result.status === 'failed' ? { ...facts, message: new GuardError(result.code).message } : facts
}

function compareContext(): ToolResult {
  const record = readRecord(projectDir())
  if (!record) return { error: 'not-started', message: 'Call start_binding first.' }

  const compare = compareState(record.state)
  const fileKey = targetFileKey(record.state)
  return {
    scope: compare.scope,
    pages: compare.pages,
    frames: compare.frames,
    readNodes: readNodes(record.recordDir, fileKey),
    baselineDir: baselineDir(record.recordDir, fileKey),
    isFirstComparison: !isBaselineReady(compare),
  }
}

function setCompareScope({ scope, pages }: ToolArgs): ToolResult {
  const record = readRecord(projectDir())
  if (!record) return { error: 'not-started', message: 'Call start_binding first.' }
  if (!['all', 'pages', 'read'].includes(scope as string)) {
    return { error: 'bad-scope', message: 'scope must be all, pages or read.' }
  }

  const compare = {
    ...compareState(record.state),
    scope: scope as CompareScope,
    pages: (pages as string[]) ?? [],
    scopeChanged: true,
  }
  writeRecord(record.recordDir, withCompare(record.state, compare))
  return { scope: compare.scope, pages: compare.pages }
}

async function withFigwright<T>(use: (figwright: Figwright) => Promise<T>): Promise<T> {
  const figwright = new Figwright()
  try {
    await figwright.connect()
    return await use(figwright)
  } finally {
    figwright.close()
  }
}

async function markDraftTool({ sessionId }: ToolArgs): Promise<ToolResult> {
  const record = readRecord(projectDir())
  const pending = record?.state.pending
  if (!record || !pending) return { error: 'not-started', message: 'Call start_binding first.' }

  const result = await withFigwright((figwright) => markDraft(figwright, sessionId as string, pending.markerName))
  if ('error' in result) return { error: result.error, message: 'This draft cannot be marked.' }

  writeRecord(record.recordDir, { ...record.state, pending: { ...pending, ...result } })
  return { marked: true }
}

async function runComparison({ sessionId }: ToolArgs): Promise<ToolResult> {
  const record = readRecord(projectDir())
  if (!record) return { error: 'not-started', message: 'Call start_binding first.' }

  const compare = compareState(record.state)
  const fileKey = targetFileKey(record.state)
  const rootDir = baselineDir(record.recordDir, fileKey)
  const locale = localeFor(record.state, projectDir())
  const isFirst = !isBaselineReady(compare)

  const summary = await withFigwright(async (figwright) => {
    const result = await compareDraft(
      figwright,
      sessionId as string,
      compare,
      readNodes(record.recordDir, fileKey),
      rootDir,
    )
    const pathOf = (id: string) => result.frames.find((frame) => frame.nodeId === id)?.path ?? id
    const saved = { ...compare, frames: result.frames, baselineReady: true, scopeChanged: false }

    if (isFirst) {
      writeRecord(record.recordDir, withCompare(record.state, saved))
      return baselineMarkdown(result.frames.length - result.failedIds.length, result.failedIds.map(pathOf), locale)
    }

    const input = {
      fileName: record.state.pending?.fileName ?? record.state.fileName,
      previous: compare.frames,
      current: result.frames,
      changes: result.changes,
      readNodeIds: result.readFrameIds,
      notComparedIds: result.notComparedIds,
      membershipKnown: compare.scope === 'all' && !compare.scopeChanged,
    }
    const date = new Date().toLocaleDateString('sv-SE')
    const reportPath = writeReport(record.recordDir, reportMarkdown(input, locale, date))

    // The differences only survive in the report, so baselines move on after it is saved
    await acceptChanges(figwright, result.changes, rootDir)
    writeRecord(record.recordDir, withCompare(record.state, saved))
    return summaryMarkdown(input, locale, reportPath)
  })

  return { summary }
}

async function callTool(name: string | undefined, args: ToolArgs | undefined): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return { error: 'unknown-tool', message: name ?? '' }

  try {
    return await tool.run(args ?? {})
  } catch (error) {
    // One bad call must not take down the server in the middle of a binding
    if (error instanceof GuardError) return { error: error.code, message: error.message }
    if (error instanceof DraftNotInFront) return { error: 'draft-not-front', message: 'Bring the draft to the front.' }
    if (error instanceof FigwrightError) return { error: 'figwright', message: error.message }
    return { error: 'internal', message: error instanceof Error ? error.message : String(error) }
  }
}

function send(id: RpcMessage['id'], result: unknown): void {
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

async function handle({ id, method, params }: RpcMessage): Promise<void> {
  if (id === undefined) return

  if (method === 'initialize') {
    send(id, {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fdg', version: '0.1.0' },
    })
  } else if (method === 'tools/list') {
    send(id, { tools: TOOLS.map(({ run, ...tool }) => tool) })
  } else if (method === 'tools/call') {
    const result = await callTool(params?.name, params?.arguments)
    send(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: Boolean(result.error),
    })
  } else {
    send(id, {})
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    handle(JSON.parse(line) as RpcMessage).catch(() => undefined)
  } catch {
    // A line that is not JSON has no id to answer
  }
})
