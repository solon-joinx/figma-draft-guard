import type { Figwright } from './figwright.ts'
import { FigwrightError } from './figwright.ts'
import type { CompareState } from './lib.ts'
import type { ChangeDetail, FrameChange, FrameRef } from './report.ts'

const MAX_DETAILS = 20
const MAX_PARENT_DEPTH = 30
const MARKER_NAME = /^🔒 (Main file version|主檔版本)/
const DIVIDER_NAME = /^[\p{P}\p{S}\s]+$/u
const NOT_FRONT = /establish connection/i

export class DraftNotInFront extends Error {}

interface Page {
  id: string
  name: string
}

interface SceneNode {
  id: string
  name: string
  type: string
  visible?: boolean
  parentId?: string
  children?: SceneNode[]
}

interface FieldChange {
  field: string
  before?: unknown
  after?: unknown
}

interface NodeChange {
  id: string
  name: string
  fields?: FieldChange[]
}

interface DiffResult {
  status: 'baseline-created' | 'no-changes' | 'diff'
  changes?: { added: NodeChange[]; removed: NodeChange[]; changed: NodeChange[] }
}

async function pages(figwright: Figwright): Promise<Page[]> {
  return (await figwright.call<{ pages: Page[] }>('get_pages')).pages
}

// Divider pages cannot be searched or hold layers, which is not a failure here
async function nodesOn<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof FigwrightError) return []
    throw error
  }
}

function markersOn(figwright: Figwright, page: Page): Promise<SceneNode[]> {
  return nodesOn(async () => {
    const { nodes } = await figwright.call<{ nodes: SceneNode[] }>('search_nodes', { name: '🔒', root: page.id })
    return nodes.filter((node) => MARKER_NAME.test(node.name))
  })
}

async function claim(figwright: Figwright, sessionId: string): Promise<void> {
  const { bound } = await figwright.call<{ bound: { sessionId: string } | null }>('use_file', { sessionId })
  if (bound?.sessionId !== sessionId) throw new FigwrightError('Could not connect to this draft')
}

export async function markDraft(
  figwright: Figwright,
  sessionId: string,
  markerName: string,
): Promise<{ markerPageId: string } | { error: 'old-draft' | 'no-page' }> {
  await claim(figwright, sessionId)
  const allPages = await pages(figwright)

  for (const page of allPages) {
    if ((await markersOn(figwright, page)).length > 0) return { error: 'old-draft' }
  }

  for (const page of allPages.filter(({ name }) => !DIVIDER_NAME.test(name))) {
    const created = await nodesOn(async () => [
      await figwright.call<{ nodeId: string }>('create_frame', {
        name: markerName,
        parentId: page.id,
        x: -100000,
        y: -100000,
        width: 1,
        height: 1,
      }),
    ])
    const nodeId = created[0]?.nodeId
    if (!nodeId) continue

    await figwright.call('set_visible', { nodeId, visible: false })
    await figwright.call('lock_nodes', { nodeIds: [nodeId] })
    await figwright.call('reorder_nodes', { nodeIds: [nodeId], index: 0 })

    const markers = await markersOn(figwright, page)
    if (markers.some((node) => node.name === markerName)) return { markerPageId: page.id }
  }
  return { error: 'no-page' }
}

async function assertInFront(figwright: Figwright, sessionId: string): Promise<void> {
  const { files } = await figwright.call<{ files: { sessionId: string; routed: boolean }[] }>('list_files')
  if (!files.find((file) => file.sessionId === sessionId)?.routed) throw new DraftNotInFront()
}

function sectionPath(section: SceneNode, byId: Map<string, SceneNode>): SceneNode[] {
  const parent = section.parentId ? byId.get(section.parentId) : undefined
  return parent ? [...sectionPath(parent, byId), section] : [section]
}

async function framesOnPage(figwright: Figwright, page: Page): Promise<FrameRef[]> {
  const sections = await nodesOn(async () => {
    const { nodes } = await figwright.call<{ nodes: SceneNode[] }>('scan_nodes_by_types', {
      types: ['SECTION'],
      root: page.id,
    })
    return nodes
  })

  const toRef = (frame: SceneNode, parents: SceneNode[]): FrameRef => ({
    nodeId: frame.id,
    name: frame.name,
    path: `${[...parents.map((section) => section.name), frame.name].join(' / ')} (${frame.id})`,
  })

  if (sections.length === 0) {
    const frames = await nodesOn(async () => {
      const { nodes } = await figwright.call<{ nodes: SceneNode[] }>('scan_nodes_by_types', {
        types: ['FRAME'],
        root: page.id,
      })
      return nodes
    })
    return frames
      .filter((frame) => frame.parentId === page.id && !MARKER_NAME.test(frame.name))
      .map((frame) => toRef(frame, []))
  }

  const byId = new Map(sections.map((section) => [section.id, section]))
  const visible = sections.filter((section) =>
    sectionPath(section, byId).every((part) => part.visible !== false),
  )

  const frames: FrameRef[] = []
  for (const section of visible) {
    const { nodes } = await figwright.call<{ nodes: SceneNode[] }>('get_design_context', {
      nodeId: section.id,
      detail: 'minimal',
      depth: 1,
    })
    for (const child of nodes[0]?.children ?? []) {
      if (child.type === 'FRAME' && !MARKER_NAME.test(child.name)) {
        frames.push(toRef(child, sectionPath(section, byId)))
      }
    }
  }
  return frames
}

// Reads can point at a layer inside a frame, so walk up to the frame that holds it
async function readFrames(figwright: Figwright, frames: FrameRef[], readNodes: string[]): Promise<string[]> {
  const frameIds = new Set(frames.map((frame) => frame.nodeId))
  const found = new Set<string>()

  for (const start of readNodes) {
    let nodeId: string | undefined = start
    for (let depth = 0; nodeId && depth < MAX_PARENT_DEPTH; depth += 1) {
      if (frameIds.has(nodeId)) {
        found.add(nodeId)
        break
      }
      const current: string = nodeId
      const nodes = await nodesOn(() => figwright.call<(SceneNode | null)[]>('get_nodes_info', { nodeIds: [current] }))
      nodeId = nodes[0]?.parentId
    }
  }
  return [...found]
}

function toChange(nodeId: string, { added, removed, changed }: NonNullable<DiffResult['changes']>): FrameChange {
  const fieldDetails = changed.flatMap(({ id, name, fields = [] }): ChangeDetail[] =>
    fields.map(({ field, before, after }) => ({ node: name, nodeId: id, kind: 'changed', field, before, after })),
  )
  const nodeDetail = (kind: 'added' | 'removed') => ({ id, name }: NodeChange): ChangeDetail => ({
    node: name,
    nodeId: id,
    kind,
  })
  const details = [...fieldDetails, ...added.map(nodeDetail('added')), ...removed.map(nodeDetail('removed'))]
  return { nodeId, changeCount: details.length, details: details.slice(0, MAX_DETAILS) }
}

export interface ComparisonResult {
  frames: FrameRef[]
  changes: FrameChange[]
  notComparedIds: string[]
  failedIds: string[]
  readFrameIds: string[]
}

export async function compareDraft(
  figwright: Figwright,
  sessionId: string,
  compare: CompareState,
  readNodes: string[],
  rootDir: string,
): Promise<ComparisonResult> {
  await claim(figwright, sessionId)
  await assertInFront(figwright, sessionId)

  const allPages = await pages(figwright)
  const everyFrame: { frame: FrameRef; page: Page }[] = []
  for (const page of allPages) {
    for (const frame of await framesOnPage(figwright, page)) everyFrame.push({ frame, page })
  }

  const readFrameIds = await readFrames(figwright, everyFrame.map(({ frame }) => frame), readNodes)
  const read = new Set(readFrameIds)
  const inScope = ({ frame, page }: { frame: FrameRef; page: Page }) => {
    if (compare.scope === 'all') return true
    if (read.has(frame.nodeId)) return true
    return compare.scope === 'pages' && compare.pages.includes(page.name)
  }
  const frames = everyFrame.filter(inScope).map(({ frame }) => frame)

  const changes: FrameChange[] = []
  const notComparedIds: string[] = []
  const failedIds: string[] = []
  for (const { nodeId } of frames) {
    try {
      const result = await figwright.call<DiffResult>('design_diff', { nodeId, rootDir })
      if (result.status === 'baseline-created') notComparedIds.push(nodeId)
      if (result.status === 'diff' && result.changes) changes.push(toChange(nodeId, result.changes))
    } catch (error) {
      if (!(error instanceof FigwrightError)) throw error
      if (NOT_FRONT.test(error.message)) throw new DraftNotInFront()
      // One broken component should not stop the rest of the comparison
      notComparedIds.push(nodeId)
      failedIds.push(nodeId)
    }
  }
  return { frames, changes, notComparedIds, failedIds, readFrameIds }
}

export async function acceptChanges(figwright: Figwright, changes: FrameChange[], rootDir: string): Promise<void> {
  for (const { nodeId } of changes) {
    await figwright.call('design_diff', { nodeId, rootDir, update: true })
  }
}
