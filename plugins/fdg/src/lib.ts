import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FAILURE_REASONS, formatTime, phaseOf } from './messages.ts'
import type { Assessment, FailureCode, Locale, Notice, Tone } from './messages.ts'
import type { FrameRef } from './report.ts'

const RECORD_DIR = '.figma-draft-guard'
const CACHE_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000
const NOTED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5000

const MARKER_PREFIX = '🔒 Main file version'

export type Env = Record<string, string | undefined>

export interface Meta {
  name: string
  version: string
  lastTouchedAt: string | null
}

export interface ActiveBinding {
  version: string
  lastTouchedAt: string | null
  markerName?: string
  markerPageId?: string
  boundAt: string
}

export interface PendingBinding {
  fileKey: string
  fileName: string
  version: string
  lastTouchedAt: string | null
  markerName: string
  markerPageId?: string
  compare?: CompareState
}

export type CompareScope = 'all' | 'pages' | 'read'

export interface CompareState {
  scope: CompareScope
  pages: string[]
  frames: FrameRef[]
  baselineReady?: boolean
  scopeChanged?: boolean
}

export interface BindingState {
  fileKey: string
  fileName: string
  locale?: Locale
  compare?: CompareState
  active: ActiveBinding | null
  pending: PendingBinding | null
}

export interface BindingRecord {
  recordDir: string
  state: BindingState
}

type CachedMeta = (Meta & { fetchedAt: number }) | { errorCode: FailureCode; fetchedAt: number }

export class GuardError extends Error {
  code: FailureCode

  constructor(code: FailureCode) {
    super(FAILURE_REASONS.en[code])
    this.code = code
  }
}

export function parseFileKey(input: string | undefined): string | null {
  const value = input?.trim()
  if (!value) return null
  if (/^[A-Za-z0-9]+$/.test(value)) return value

  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (!['design', 'file', 'proto', 'board', 'slides'].includes(parts[0])) return null
  // Branch links are /design/<main>/branch/<branch>/...; the branch has its own version
  return parts[2] === 'branch' && parts[3] ? parts[3] : (parts[1] ?? null)
}

// Tool input can be an id or a pasted link, where the id is written 1-2 instead of 1:2
export function parseNodeId(input: string | undefined): string | null {
  const value = input?.trim()
  if (!value) return null
  if (!value.includes('figma.com')) return value

  try {
    return new URL(value).searchParams.get('node-id')?.replaceAll('-', ':') ?? null
  } catch {
    return null
  }
}

// While switching main files, comparison work belongs to the file being bound
function isSwitching({ fileKey, pending }: BindingState): boolean {
  return pending !== null && pending.fileKey !== fileKey
}

export function targetFileKey(state: BindingState): string {
  return isSwitching(state) ? (state.pending?.fileKey ?? state.fileKey) : state.fileKey
}

export function compareState(state: BindingState): CompareState {
  const compare = isSwitching(state) ? state.pending?.compare : state.compare
  return compare ?? { scope: 'all', pages: [], frames: [] }
}

export function withCompare(state: BindingState, compare: CompareState): BindingState {
  return isSwitching(state) && state.pending
    ? { ...state, pending: { ...state.pending, compare } }
    : { ...state, compare }
}

// Older records have no flag, but saved frames mean a baseline was built
export function isBaselineReady(compare: CompareState): boolean {
  return compare.baselineReady ?? compare.frames.length > 0
}

// Reads come from parallel hook processes, so they are appended to their own file.
// Node ids repeat across Figma files, so reads and baselines are kept per main file.
function readsPath(recordDir: string, fileKey: string): string {
  return path.join(recordDir, `reads-${fileKey}.txt`)
}

export function recordRead(recordDir: string, fileKey: string, nodeId: string): void {
  fs.appendFileSync(readsPath(recordDir, fileKey), `${nodeId}\n`)
}

export function readNodes(recordDir: string, fileKey: string): string[] {
  try {
    const lines = fs.readFileSync(readsPath(recordDir, fileKey), 'utf8').split('\n')
    return [...new Set(lines.filter(Boolean))]
  } catch {
    return []
  }
}

// Inside the record folder, so baselines stay out of git wherever Claude Code was started
export function baselineDir(recordDir: string, fileKey: string): string {
  return path.join(recordDir, 'baselines', fileKey)
}

export function writeReport(recordDir: string, markdown: string, now = new Date()): string {
  const dir = path.join(recordDir, 'reports')
  fs.mkdirSync(dir, { recursive: true })

  const pad = (number: number) => String(number).padStart(2, '0')
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const dayPath = path.join(dir, `${day}.md`)
  const file = fs.existsSync(dayPath)
    ? path.join(dir, `${day}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`)
    : dayPath

  fs.writeFileSync(file, markdown)
  return file
}

function projectRoot(dir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return dir
  }
}

function findRecordDir(startDir: string): string | null {
  let dir = path.resolve(startDir)
  while (true) {
    const candidate = path.join(dir, RECORD_DIR)
    if (fs.existsSync(path.join(candidate, 'state.json'))) return candidate
    // Stop at the project boundary so another project's record is never picked up
    if (fs.existsSync(path.join(dir, '.git')) || dir === os.homedir()) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function readRecord(startDir: string): BindingRecord | null {
  const recordDir = findRecordDir(startDir)
  if (!recordDir) return null

  let state: BindingState
  try {
    state = JSON.parse(fs.readFileSync(path.join(recordDir, 'state.json'), 'utf8'))
  } catch {
    throw new GuardError('bad-record')
  }
  if (!state?.fileKey) throw new GuardError('bad-record')
  return { recordDir, state }
}

// A rename is atomic, so a concurrent reader never sees a half-written file
function writeAtomic(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content)
  fs.renameSync(temporary, file)
}

export function newRecordDir(dir: string): string {
  return path.join(projectRoot(dir), RECORD_DIR)
}

export function writeRecord(recordDir: string, state: BindingState): void {
  fs.mkdirSync(recordDir, { recursive: true })
  // The record describes each person's own draft, so the whole folder stays out of git
  fs.writeFileSync(path.join(recordDir, '.gitignore'), '*\n')
  writeAtomic(path.join(recordDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
}

function usableToken(value: string | undefined): string | null {
  return value && !value.includes('${') ? value : null
}

// userConfig reaches hooks and the MCP server through different variables
export function readToken(env: Env = process.env): string | null {
  return usableToken(env.CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN) || usableToken(env.FDG_TOKEN) || null
}

// The override exists for tests, so the token can only ever go to Figma or this machine
function apiBase(env: Env): string {
  const override = env.FIGMA_API_BASE
  return override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override)
    ? override
    : 'https://api.figma.com'
}

export async function fetchMeta(fileKey: string, env: Env = process.env): Promise<Meta> {
  const token = readToken(env)
  if (!token) throw new GuardError('no-token')

  const base = apiBase(env)
  let response
  try {
    response = await fetch(`${base}/v1/files/${encodeURIComponent(fileKey)}/meta`, {
      headers: { 'X-Figma-Token': token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new GuardError('network')
  }

  if (response.status === 403) throw new GuardError('auth')
  if (response.status === 404) throw new GuardError('not-found')
  if (response.status === 429) throw new GuardError('rate-limited')
  if (!response.ok) throw new GuardError('network')

  let file: { name: string; version: string; last_touched_at?: string } | undefined
  try {
    ;({ file } = (await response.json()) as { file?: typeof file })
  } catch {
    throw new GuardError('bad-response')
  }
  if (!file?.version) throw new GuardError('bad-response')

  return { name: file.name, version: file.version, lastTouchedAt: file.last_touched_at ?? null }
}

export function isStale(active: Pick<ActiveBinding, 'version' | 'lastTouchedAt'>, latest: Pick<Meta, 'version' | 'lastTouchedAt'>): boolean {
  if (latest.version !== active.version) return true
  return Date.parse(latest.lastTouchedAt ?? '') > Date.parse(active.lastTouchedAt ?? '')
}

export function markerName(meta: Pick<Meta, 'version' | 'lastTouchedAt'>): string {
  return `${MARKER_PREFIX} ${formatTime(meta.lastTouchedAt)} · ${meta.version} (do not delete)`
}

export function suggestedFileName(meta: Pick<Meta, 'name'>, now = new Date()): string {
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${meta.name}｜draft ${pad(now.getMonth() + 1)}/${pad(now.getDate())}`
}

// The clipboard is a convenience; on failure the caller shows the text instead
export function copyToClipboard(text: string): boolean {
  const commands: Partial<Record<NodeJS.Platform, string>> = { darwin: 'pbcopy', win32: 'clip' }
  const command = commands[process.platform]
  if (!command) return false
  try {
    execFileSync(command, [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

// Returns facts, not display text; a failed check does not throw
export async function assess(state: BindingState, getLatest: () => Promise<Meta>): Promise<Assessment> {
  if (!state.active) {
    return { status: 'not-ready', key: 'not-ready', fileName: state.fileName }
  }

  try {
    const latest = await getLatest()
    const facts = {
      fileName: latest.name,
      phase: phaseOf(latest.lastTouchedAt, Date.now()),
      mainUpdatedAt: latest.lastTouchedAt,
      draftFromUpdatedAt: state.active.lastTouchedAt,
    }
    return isStale(state.active, latest)
      ? { status: 'stale', key: 'stale', ...facts }
      : { status: 'fresh', key: 'fresh', ...facts }
  } catch (error) {
    if (!(error instanceof GuardError)) throw error
    return { status: 'failed', key: `failed:${error.code}`, code: error.code, fileName: state.fileName }
  }
}

function settingsLanguage(projectDir: string): string | null {
  const files = [
    path.join(projectDir, '.claude', 'settings.local.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ]
  for (const file of files) {
    try {
      const { language } = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (language) return language
    } catch {
      // No such settings file, so try the next one
    }
  }
  return null
}

export function toLocale(language: string): Locale {
  return /^zh|chinese|中文|繁體|繁体/i.test(language) ? 'zh-TW' : 'en'
}

function detectLocale(projectDir: string, env: Env): Locale {
  const language =
    settingsLanguage(projectDir) ||
    env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANG ||
    Intl.DateTimeFormat().resolvedOptions().locale
  return toLocale(language)
}

// The language chosen at binding wins: terminals can report a generic locale such as C.UTF-8
export function localeFor(
  state: BindingState | undefined,
  projectDir: string,
  env: Env = process.env,
): Locale {
  return state?.locale ?? detectLocale(projectDir, env)
}

const ANSI: Record<Tone, string> = { blue: '1;34', yellow: '1;33', red: '1;31', green: '1;32' }

export function emphasized({ text, tone }: Notice): string {
  return `\x1b[${ANSI[tone]}m${text}\x1b[0m`
}

// The band derives its text from the time, so store facts; nothing shows when in sync
export function writeStatus(recordDir: string, result: Assessment | null, locale: Locale): void {
  const shown = result?.status === 'fresh' ? null : result
  writeAtomic(path.join(recordDir, 'status.json'), `${JSON.stringify({ result: shown, locale })}\n`)
}

export function readStatus(recordDir: string): Assessment | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(recordDir, 'status.json'), 'utf8')).result ?? null
  } catch {
    return null
  }
}

function cachePath(dataDir: string, fileKey: string): string {
  return path.join(dataDir, `meta-${fileKey}.json`)
}

function readCache(dataDir: string, fileKey: string, boundAt: string, now: number): CachedMeta | null {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(dataDir, fileKey), 'utf8')) as CachedMeta
    // Results fetched before rebinding no longer apply
    if (cache.fetchedAt < Date.parse(boundAt)) return null
    const ttl = 'errorCode' in cache ? FAILURE_TTL_MS : CACHE_TTL_MS
    return now - cache.fetchedAt < ttl ? cache : null
  } catch {
    return null
  }
}

function writeCache(dataDir: string, fileKey: string, value: CachedMeta): void {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(cachePath(dataDir, fileKey), JSON.stringify(value))
}

export async function cachedMeta(
  fileKey: string,
  boundAt: string,
  dataDir: string,
  env: Env,
  now = Date.now(),
): Promise<Meta> {
  const cached = readCache(dataDir, fileKey, boundAt, now)
  if (cached && 'errorCode' in cached) throw new GuardError(cached.errorCode)
  if (cached) return cached

  try {
    const meta = await fetchMeta(fileKey, env)
    writeCache(dataDir, fileKey, { ...meta, fetchedAt: now })
    return meta
  } catch (error) {
    if (error instanceof GuardError) {
      writeCache(dataDir, fileKey, { errorCode: error.code, fetchedAt: now })
    }
    throw error
  }
}

// Notify once per state in a session
export function markNoted(dataDir: string, key: string, now = Date.now()): boolean {
  const dir = path.join(dataDir, 'noted')
  fs.mkdirSync(dir, { recursive: true })

  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    if (now - fs.statSync(file).mtimeMs > NOTED_TTL_MS) fs.rmSync(file, { force: true })
  }

  const file = path.join(dir, createHash('sha1').update(key).digest('hex'))
  const isNew = !fs.existsSync(file)
  fs.writeFileSync(file, '')
  return isNew
}
