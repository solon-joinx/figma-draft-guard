import fs from 'node:fs'
import readline from 'node:readline'

const load = () => JSON.parse(fs.readFileSync(process.env.FAKE_FIGWRIGHT, 'utf8'))
const log = (name, args) => fs.appendFileSync(`${process.env.FAKE_FIGWRIGHT}.log`, `${JSON.stringify({ name, args })}\n`)

function result(name, args, config) {
  const page = config.pages[0]
  switch (name) {
    case 'use_file':
      return { bound: { sessionId: args.sessionId } }
    case 'list_files':
      return { files: [{ sessionId: 's1', routed: config.front !== false }] }
    case 'get_pages':
      return { pages: config.pages }
    case 'search_nodes':
      return { nodes: (config.markers ?? []).filter((node) => node.page === args.root) }
    case 'create_frame':
      if (config.rejectPages?.includes(args.parentId)) throw new Error('Cannot add to page')
      config.markers = [...(config.markers ?? []), { id: 'm1', name: args.name, page: args.parentId }]
      fs.writeFileSync(process.env.FAKE_FIGWRIGHT, JSON.stringify(config))
      return { nodeId: 'm1' }
    case 'scan_nodes_by_types':
      if (args.types[0] === 'SECTION') return { nodes: args.root === page.id ? (config.sections ?? []) : [] }
      return { nodes: args.root === page.id ? (config.frames ?? []).map((id) => ({ id, name: id, type: 'FRAME', parentId: page.id })) : [] }
    case 'get_design_context':
      return { nodes: [{ children: config.sectionChildren?.[args.nodeId] ?? [] }] }
    case 'get_nodes_info':
      return [config.parents?.[args.nodeIds[0]] ? { parentId: config.parents[args.nodeIds[0]] } : null]
    case 'design_diff': {
      if (args.update) return { status: 'diff' }
      if (config.errors?.[args.nodeId]) throw new Error(config.errors[args.nodeId])
      if (config.created?.includes(args.nodeId)) return { status: 'baseline-created' }
      const changes = config.diffs?.[args.nodeId]
      return changes ? { status: 'diff', changes } : { status: 'no-changes' }
    }
    default:
      return {}
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  const reply = (body) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result: body }))

  if (method !== 'tools/call') return reply({})
  log(params.name, params.arguments)
  try {
    reply({ content: [{ text: JSON.stringify(result(params.name, params.arguments, load())) }] })
  } catch (error) {
    reply({ isError: true, content: [{ text: error.message }] })
  }
})
