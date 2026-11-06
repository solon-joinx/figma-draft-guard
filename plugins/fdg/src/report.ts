import type { Locale } from './messages.ts'

export interface FrameRef {
  nodeId: string
  name: string
  path: string
}

export interface ChangeDetail {
  node: string
  nodeId: string
  kind: 'changed' | 'added' | 'removed'
  field?: string
  before?: unknown
  after?: unknown
}

export interface FrameChange {
  nodeId: string
  changeCount: number
  details?: ChangeDetail[]
}

export interface ReportInput {
  fileName: string
  previous: FrameRef[]
  current: FrameRef[]
  changes: FrameChange[]
  readNodeIds: string[]
  notComparedIds?: string[]
  membershipKnown?: boolean
}

export interface ReportSummary {
  read: { path: string; changeCount: number }[]
  other: string[]
  added: string[]
  removed: string[]
  notCompared: string[]
  unchanged: number
}

const LABELS = {
  en: {
    title: 'Design comparison',
    read: 'Previously read',
    other: 'Other',
    added: 'Added to main file',
    removed: 'Removed from main file',
    unchanged: 'Unchanged',
    changes: (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`,
    frames: (count: number) => `${count} ${count === 1 ? 'frame' : 'frames'}`,
    colon: ': ',
    membershipUnknown: 'Added and removed frames are only listed when all pages are compared.',
    notCompared: 'Not compared',
    baselineReady: (count: number) => `Baseline ready: ${count} ${count === 1 ? 'frame' : 'frames'}`,
    none: 'No changes found.',
    nodeAdded: 'added',
    nodeRemoved: 'removed',
    empty: 'none',
    more: (count: number) => `${count} more ${count === 1 ? 'change' : 'changes'}`,
    report: 'Report',
  },
  'zh-TW': {
    title: '設計差異報告',
    read: '曾讀取',
    other: '其他',
    added: '主檔新增',
    removed: '主檔移除',
    unchanged: '無變更',
    changes: (count: number) => `${count} 項變更`,
    frames: (count: number) => `${count} 個畫面`,
    colon: '：',
    membershipUnknown: '只有比對全部頁面時，才會列出新增與移除的畫面。',
    notCompared: '未比對',
    baselineReady: (count: number) => `基準已建立：${count} 個畫面`,
    none: '未發現變更。',
    nodeAdded: '新增',
    nodeRemoved: '移除',
    empty: '無',
    more: (count: number) => `其餘 ${count} 項`,
    report: '報告',
  },
}

const FIELD_LABELS: Record<string, string> = {
  fills: '填色',
  fill: '填色',
  strokes: '邊框',
  stroke: '邊框',
  characters: '文字',
  name: '名稱',
  width: '寬度',
  height: '高度',
  x: 'X',
  y: 'Y',
  opacity: '不透明度',
  visible: '顯示',
  cornerRadius: '圓角',
  fontSize: '字級',
  fontName: '字型',
  layout: '版面',
  parent: '上層',
  textStyle: '文字樣式',
  effects: '效果',
}

const VALUE_EDGE_LENGTH = 40

function formatValue(value: unknown, emptyText: string): string {
  if (value === undefined || value === null) return emptyText
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const text = raw.replace(/\s+/g, ' ')
  // Keep both ends: two long values often differ only near the end
  return text.length > VALUE_EDGE_LENGTH * 2
    ? `${text.slice(0, VALUE_EDGE_LENGTH)}…${text.slice(-VALUE_EDGE_LENGTH)}`
    : text
}

function detailLines(change: FrameChange | undefined, locale: Locale): string[] {
  const text = LABELS[locale]
  const details = change?.details ?? []
  const nodes = new Map<string, ChangeDetail[]>()
  for (const detail of details) {
    nodes.set(detail.nodeId, [...(nodes.get(detail.nodeId) ?? []), detail])
  }

  const lines = [...nodes.values()].flatMap((items) => {
    const [first] = items
    const title = `  - ${first?.node} (${first?.nodeId})`
    if (first?.kind === 'added') return [`${title}${text.colon}${text.nodeAdded}`]
    if (first?.kind === 'removed') return [`${title}${text.colon}${text.nodeRemoved}`]

    return [
      title,
      ...items.map(({ field = '', before, after }) => {
        const label = locale === 'zh-TW' ? (FIELD_LABELS[field] ?? field) : field
        return `    - ${label}${text.colon}${formatValue(before, text.empty)} → ${formatValue(after, text.empty)}`
      }),
    ]
  })

  const omitted = (change?.changeCount ?? 0) - details.length
  return omitted > 0 ? [...lines, `  - ${text.more(omitted)}`] : lines
}

export function summarize(input: ReportInput): ReportSummary {
  const { previous, current, changes, readNodeIds, notComparedIds = [] } = input
  const membershipKnown = input.membershipKnown !== false
  const known = new Set(previous.map((frame) => frame.nodeId))
  const present = new Set(current.map((frame) => frame.nodeId))
  const read = new Set(readNodeIds)
  const skipped = new Set(notComparedIds)
  const byId = new Map(current.map((frame) => [frame.nodeId, frame]))

  // Only a full listing shows what is in the main file; a narrower scope just shows less
  const added = membershipKnown ? current.filter((frame) => !known.has(frame.nodeId)) : []
  const addedIds = new Set(added.map((frame) => frame.nodeId))
  const notCompared = current.filter(({ nodeId }) => skipped.has(nodeId) && !addedIds.has(nodeId))
  const changed = changes.filter(
    ({ nodeId, changeCount }) =>
      changeCount > 0 && byId.has(nodeId) && !addedIds.has(nodeId) && !skipped.has(nodeId),
  )
  const pathOf = (nodeId: string) => byId.get(nodeId)?.path ?? nodeId

  return {
    read: changed
      .filter(({ nodeId }) => read.has(nodeId))
      .map(({ nodeId, changeCount }) => ({ path: pathOf(nodeId), changeCount })),
    other: changed.filter(({ nodeId }) => !read.has(nodeId)).map(({ nodeId }) => pathOf(nodeId)),
    added: added.map((frame) => frame.path),
    removed: membershipKnown ? previous.filter((frame) => !present.has(frame.nodeId)).map((frame) => frame.path) : [],
    notCompared: notCompared.map((frame) => frame.path),
    unchanged: current.length - changed.length - added.length - notCompared.length,
  }
}

function changeSections(input: ReportInput, locale: Locale, withDetails: boolean): string[] {
  const text = LABELS[locale]
  const summary = summarize(input)
  const lines: string[] = []

  const nodeIds = new Map(input.current.map((frame) => [frame.path, frame.nodeId]))
  const changes = new Map(input.changes.map((change) => [change.nodeId, change]))
  const details = (path: string) =>
    withDetails ? detailLines(changes.get(nodeIds.get(path) ?? ''), locale) : []
  const section = (title: string, items: string[]) => {
    if (items.length > 0) lines.push(`## ${title}`, '', ...items, '')
  }

  section(
    text.read,
    summary.read.flatMap(({ path, changeCount }) => [
      `- ${path}${text.colon}${text.changes(changeCount)}`,
      ...details(path),
    ]),
  )
  section(text.other, summary.other.flatMap((path) => [`- ${path}`, ...details(path)]))
  section(text.added, summary.added.map((path) => `- ${path}`))
  section(text.removed, summary.removed.map((path) => `- ${path}`))
  section(text.notCompared, summary.notCompared.map((path) => `- ${path}`))

  if (lines.length === 0) lines.push(text.none, '')
  if (input.membershipKnown === false) lines.push(text.membershipUnknown, '')
  lines.push(`${text.unchanged}${text.colon}${text.frames(summary.unchanged)}`)
  return lines
}

export function reportMarkdown(input: ReportInput, locale: Locale, date: string): string {
  const title = [`# ${LABELS[locale].title}`, '', `${input.fileName} · ${date}`, '']
  return `${[...title, ...changeSections(input, locale, true)].join('\n')}\n`
}

export function baselineMarkdown(frames: number, notCompared: string[], locale: Locale): string {
  const text = LABELS[locale]
  const skipped = notCompared.length > 0 ? ['', `## ${text.notCompared}`, '', ...notCompared.map((path) => `- ${path}`)] : []
  return [text.baselineReady(frames), ...skipped].join('\n')
}

// The chat shows this as is, so the same changes always read the same way
export function summaryMarkdown(input: ReportInput, locale: Locale, reportPath: string): string {
  return [...changeSections(input, locale, false), '', `${LABELS[locale].report}${LABELS[locale].colon}${reportPath}`].join('\n')
}
