import os from 'node:os'
import path from 'node:path'
import {
  GuardError,
  assess,
  cachedMeta,
  emphasized,
  fetchMeta,
  localeFor,
  markNoted,
  parseNodeId,
  readRecord,
  readStatus,
  recordRead,
  writeStatus,
} from './lib.ts'
import { notice } from './messages.ts'
import type { BindingRecord, BindingState, Env } from './lib.ts'
import type { Assessment } from './messages.ts'

type EventName = 'SessionStart' | 'PreToolUse'

interface HookInput {
  session_id?: string
  cwd?: string
  tool_name?: string
  tool_input?: { nodeId?: string; detail?: string }
  tool_response?: unknown
}

const READ_TOOL = 'mcp__figwright__get_design_context'

interface HookOutput {
  systemMessage?: string
  hookSpecificOutput: { hookEventName: EventName; additionalContext: string }
}

function claudeContext(result: Assessment, state: BindingState | undefined): string {
  const marker = state?.active?.markerName
  const pageId = state?.active?.markerPageId
  const where = pageId ? `with root ${pageId}` : 'on each page'
  const draftCheck = marker
    ? ` Before reading design data with Figwright, confirm the connected draft: search_nodes ${where} must find a layer named exactly "${marker}". If not, tell the user it may be the wrong draft. Ignore that marker layer when implementing.`
    : ''
  const facts = JSON.stringify(result)
  const speak = 'Tell the user in the language of this conversation'
  // The bind flow reads the draft too, so this notice need not be relayed then
  const binding = state?.pending ? ' If you are running the bind flow right now, ignore this notice.' : ''

  if (result.status === 'fresh') {
    return `fdg: the bound draft matches the main file.${draftCheck}`
  }
  if (result.status === 'stale') {
    return `fdg: the draft is behind the main Figma file. ${speak} before implementing from it, in a neutral, professional tone, and say whether the main file is still being edited (phase) or stable. Offer to update the draft with the bind skill, then continue unless they say otherwise.${binding}${draftCheck} Facts: ${facts}`
  }
  return `fdg: draft freshness is unknown, so do not claim it is up to date. ${speak}.${binding}${draftCheck} Facts: ${facts}`
}

// Structure scans use a lighter detail level and are not reads of the design itself
function isDesignRead({ tool_name, tool_input }: HookInput): boolean {
  const detail = tool_input?.detail
  return tool_name === READ_TOOL && (detail === undefined || detail === 'full')
}

function responseTexts(response: unknown): string[] {
  if (typeof response === 'string') return [response]
  if (Array.isArray(response)) return response.flatMap(responseTexts)
  if (typeof response !== 'object' || response === null) return []
  const { text, content } = response as { text?: unknown; content?: unknown }
  return responseTexts(text ?? content)
}

// Without a nodeId the tool reads the selection, so the ids only exist in its result
function selectionRoots(response: unknown): string[] {
  for (const text of responseTexts(response)) {
    try {
      const { nodes } = JSON.parse(text) as { nodes?: { id: string }[] }
      if (nodes) return nodes.map((node) => node.id)
    } catch {
      // Not the design result; try the next block
    }
  }
  return []
}

function trackRead(record: BindingRecord, input: HookInput): void {
  if (!isDesignRead(input)) return
  const nodeId = input.tool_input?.nodeId
  const ids = nodeId ? [parseNodeId(nodeId)] : selectionRoots(input.tool_response)
  for (const id of ids) {
    if (id) recordRead(record.recordDir, record.state.fileKey, id)
  }
}

function afterRead(input: HookInput, env: Env = process.env): void {
  const record = readRecord(env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd())
  if (record) trackRead(record, input)
}

async function evaluateHook(
  eventName: EventName,
  input: HookInput,
  env: Env = process.env,
): Promise<HookOutput | null> {
  const projectDir = env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd()
  const dataDir = env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), 'figma-draft-guard')

  let record: BindingRecord | null = null
  let result: Assessment
  try {
    record = readRecord(projectDir)
    if (!record) return null
    const { fileKey, active } = record.state
    result = await assess(record.state, () => cachedMeta(fileKey, active?.boundAt ?? '', dataDir, env))

    // Cached data can lag behind a live poll, so it never clears a newer out-of-date status
    const shown = readStatus(record.recordDir)
    if (result.status === 'fresh' && shown?.status === 'stale') result = shown
  } catch (error) {
    if (!(error instanceof GuardError)) throw error
    result = { status: 'failed', key: `failed:${error.code}`, code: error.code }
  }

  const locale = localeFor(record?.state, projectDir, env)
  if (record) writeStatus(record.recordDir, result, locale)

  const isSessionStart = eventName === 'SessionStart'
  if (result.status === 'fresh' && !isSessionStart) return null

  const key = [input.session_id, record?.state.fileKey, record?.state.active?.boundAt, result.key].join('|')
  const isNew = markNoted(dataDir, key)
  // Claude loses earlier notices after compact or clear, so session start always resends
  if (!isNew && !isSessionStart) return null

  const hookSpecificOutput = {
    hookEventName: eventName,
    additionalContext: claudeContext(result, record?.state),
  }
  // No conversation exists at session start, so show a line; Claude relays later notices
  return isSessionStart
    ? { systemMessage: emphasized(notice(result, locale, Date.now())), hookSpecificOutput }
    : { hookSpecificOutput }
}

const TEMPORARY_FAILURES = ['network', 'rate-limited']

// Background check from the band: a brief outage should not replace the current status
async function poll(env: Env = process.env): Promise<void> {
  const projectDir = env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const record = readRecord(projectDir)
  if (!record) return

  const { fileKey } = record.state
  const result = await assess(record.state, () => fetchMeta(fileKey, env))
  if (result.status === 'failed' && TEMPORARY_FAILURES.includes(result.code)) return
  writeStatus(record.recordDir, result, localeFor(record.state, projectDir, env))
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const EVENTS: Record<string, EventName> = {
  'session-start': 'SessionStart',
  'pre-tool-use': 'PreToolUse',
}

// A failed check must never block development
try {
  if (process.argv[2] === 'poll') {
    await poll()
  } else if (process.argv[2] === 'post-tool-use') {
    afterRead(JSON.parse(await readStdin()) as HookInput)
  } else {
    const eventName = EVENTS[process.argv[2] ?? '']
    if (!eventName) throw new Error(`unknown hook: ${process.argv[2]}`)

    const text = await readStdin()
    const output = await evaluateHook(eventName, text ? (JSON.parse(text) as HookInput) : {})
    if (output) console.log(JSON.stringify(output))
  }
} catch (error) {
  console.error(`fdg: ${error instanceof Error ? error.message : error}`)
}
