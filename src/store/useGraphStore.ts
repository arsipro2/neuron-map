import { create } from 'zustand'
import type { Edge, GraphData, NoteNode, Trash, Vec3 } from '../types'
import { emptyTrash, graphAttachments } from '../types'
import { graphEngine } from '../engine/graphEngine'
import { captureLinkTargets } from '../services/noteLinks'

type Snapshot = GraphData & { selectedId: string | null; selectedEdgeId: string | null }
type NodePatch = Partial<Pick<NoteNode, 'title' | 'summary' | 'content' | 'attachments' | 'tags' | 'linkTargets'>>
type GraphState = Snapshot & {
  selectionVersion: number; structureVersion: number; graphEpoch: number; layoutRequest: number
  undoDepth: number; redoDepth: number; neighborhoodId: string | null
  setNeighborhood: (id: string | null) => void
  setSelected: (id: string | null) => void
  setSelectedEdge: (id: string | null) => void
  addNode: (position?: Vec3, title?: string) => string
  addLinkedNode: (sourceId: string, position?: Vec3) => string | null
  connectNodes: (sourceId: string, targetId: string) => void
  updateNode: (id: string, patch: NodePatch) => void
  deleteNode: (id: string) => void
  restoreNode: (id: string) => void
  purgeNode: (id: string) => void
  emptyTrash: () => void
  deleteEdge: (id: string) => void
  checkpoint: () => void
  undo: () => void; redo: () => void
  autoArrange: () => void
  resetGraph: () => void
  hydrateGraph: (nodes: NoteNode[], edges: Edge[], trash?: Trash) => void
  applyRuntimePositions: (positions: Record<string, Vec3>) => void
}

const initialNodes: NoteNode[] = [
  {
    id: 'root',
    title: 'My Knowledge',
    summary: 'The root of this knowledge cluster.',
    content: 'This is the long-form content area. Open a node to write as much detail as you need.',
    position: [0, 0.4, 0],
  },
  {
    id: 'networking',
    title: 'Networking',
    summary: 'Protocols, routing, addressing and network behavior.',
    content: 'Use this content field for detailed notes, examples, commands, formulas and references.',
    position: [3.4, 0.9, -0.5],
  },
  {
    id: 'security',
    title: 'Security',
    summary: 'Security concepts, controls, threats and defensive techniques.',
    content: 'This content field can hold a very large note without cluttering the 3D graph.',
    position: [-3.2, 0.8, -0.8],
  },
]

const initialEdges: Edge[] = [
  { id: 'e-root-networking', source: 'root', target: 'networking' },
  { id: 'e-root-security', source: 'root', target: 'security' },
]


const past: Snapshot[] = [], future: Snapshot[] = []
let coalesceKey = '', lastEditAt = 0
const HISTORY_LIMIT = 50
function snapshot(state: Snapshot): Snapshot {
  const runtime = graphEngine.runtime
  const matches = state.nodes.length === runtime.ids.length && state.nodes.every((node, i) => node.id === runtime.ids[i])
  return { nodes: matches ? state.nodes.map(node => ({ ...node, position: runtime.positionOf(node.id) ?? node.position })) : state.nodes,
    edges: state.edges, trash: state.trash, selectedId: state.selectedId, selectedEdgeId: state.selectedEdgeId }
}
export function historyAttachmentIds() {
  return [...new Set([...past, ...future].flatMap(state => graphAttachments(state).map(file => file.id)))]
}
function remember(state: Snapshot, key = '') {
  if (!key || key !== coalesceKey || Date.now() - lastEditAt > 800) {
    past.push(snapshot(state)); if (past.length > HISTORY_LIMIT) past.shift()
  }
  coalesceKey = key; lastEditAt = Date.now(); future.length = 0
  return { undoDepth: past.length, redoDepth: 0 }
}
function normalize(nodes: NoteNode[], all: NoteNode[]) {
  return nodes.map(node => ({ ...node, summary: node.summary ?? '', attachments: node.attachments ?? [], tags: node.tags ?? [],
    linkTargets: captureLinkTargets(node.content, all, node.linkTargets) }))
}
const validPosition = (position: Vec3): Vec3 => position.map(v => Number.isFinite(v) ? Math.max(-100000, Math.min(100000, v)) : 0) as Vec3

export const useGraphStore = create<GraphState>()((set, get) => {
  const travel = (source: Snapshot[], target: Snapshot[]) => {
    const next = source.pop(); if (!next) return
    target.push(snapshot(get())); coalesceKey = ''
    graphEngine.stop()
    // Synchronize before subscribers can read positions from the old graph.
    graphEngine.syncGraph(next.nodes, next.edges, true)
    set(state => ({ ...next, undoDepth: past.length, redoDepth: future.length, neighborhoodId: null,
      graphEpoch: state.graphEpoch + 1, structureVersion: state.structureVersion + 1, selectionVersion: state.selectionVersion + 1 }))
  }
  return {
    nodes: initialNodes, edges: initialEdges, trash: emptyTrash(), selectedId: 'root', selectedEdgeId: null,
    selectionVersion: 0, structureVersion: 0, graphEpoch: 0, layoutRequest: 0, undoDepth: 0, redoDepth: 0, neighborhoodId: null,
    setNeighborhood: id => set({ neighborhoodId: id }),
    setSelected: id => set(state => ({ selectedId: id && state.nodes.some(n => n.id === id) ? id : null,
      selectedEdgeId: null, selectionVersion: state.selectionVersion + 1 })),
    setSelectedEdge: id => set(state => ({ selectedEdgeId: id, selectedId: id === null ? state.selectedId : null })),
    checkpoint: () => set(remember(get())),
    undo: () => travel(past, future), redo: () => travel(future, past),
    addNode: (position = [0, 0.5, 0], title = 'New note') => {
      const id = crypto.randomUUID(), state = get(), history = remember(state)
      set({ ...history, nodes: [...state.nodes, { id, title, summary: '', content: '', position: validPosition(position) }],
        selectedId: id, selectedEdgeId: null, neighborhoodId: null, structureVersion: state.structureVersion + 1 })
      return id
    },
    addLinkedNode: (sourceId, position) => {
      const state = get(), source = state.nodes.find(node => node.id === sourceId)
      if (!source) return null
      const id = crypto.randomUUID(), history = remember(state), p = graphEngine.runtime.positionOf(sourceId) ?? source.position
      set({ ...history, nodes: [...state.nodes, { id, title: 'New note', summary: '', content: '', position: validPosition(position ?? [p[0] + 2.2, p[1], p[2]]) }],
        edges: [...state.edges, { id: crypto.randomUUID(), source: sourceId, target: id }],
        selectedId: id, selectedEdgeId: null, neighborhoodId: null, structureVersion: state.structureVersion + 1 })
      return id
    },
    connectNodes: (source, target) => {
      const state = get()
      if (source === target || !state.nodes.some(n => n.id === source) || !state.nodes.some(n => n.id === target)
        || state.edges.some(e => (e.source === source && e.target === target) || (e.source === target && e.target === source))) return
      const edge = { id: crypto.randomUUID(), source, target }
      set({ ...remember(state), edges: [...state.edges, edge], selectedEdgeId: edge.id, selectedId: null, structureVersion: state.structureVersion + 1 })
    },
    updateNode: (id, patch) => {
      const state = get(), node = state.nodes.find(n => n.id === id); if (!node) return
      if (Object.entries(patch).every(([key, value]) => node[key as keyof NoteNode] === value)) return
      if (patch.content !== undefined) patch = { ...patch, linkTargets: captureLinkTargets(patch.content,
        [...state.nodes, ...state.trash.nodes.map(entry => entry.node)], patch.linkTargets ?? node.linkTargets) }
      const key = Object.keys(patch).every(k => ['title', 'summary', 'content', 'linkTargets', 'tags'].includes(k)) ? id + Object.keys(patch).join(',') : ''
      set({ ...remember(state, key), nodes: state.nodes.map(n => n.id === id ? { ...n, ...patch } : n) })
    },
    deleteNode: id => {
      const state = get(), node = state.nodes.find(n => n.id === id); if (!node) return
      const removed = state.edges.filter(e => e.source === id || e.target === id)
      set({ ...remember(state), nodes: state.nodes.filter(n => n.id !== id), edges: state.edges.filter(e => !removed.includes(e)),
        trash: { nodes: [...state.trash.nodes, { node: { ...node, position: graphEngine.runtime.positionOf(id) ?? node.position }, deletedAt: Date.now() }], edges: [...state.trash.edges, ...removed] },
        selectedId: state.selectedId === id ? null : state.selectedId, selectedEdgeId: null,
        neighborhoodId: state.neighborhoodId === id ? null : state.neighborhoodId, structureVersion: state.structureVersion + 1 })
    },
    restoreNode: id => {
      const state = get(), entry = state.trash.nodes.find(n => n.node.id === id); if (!entry) return
      const nodes = [...state.nodes, entry.node], ids = new Set(nodes.map(n => n.id))
      const restored = state.trash.edges.filter(e => ids.has(e.source) && ids.has(e.target))
      set({ ...remember(state), nodes, edges: [...state.edges, ...restored], selectedId: id, selectedEdgeId: null,
        trash: { nodes: state.trash.nodes.filter(n => n !== entry), edges: state.trash.edges.filter(e => !restored.includes(e)) },
        structureVersion: state.structureVersion + 1 })
    },
    purgeNode: id => {
      const state = get(); if (!state.trash.nodes.some(n => n.node.id === id)) return
      set({ ...remember(state), trash: { nodes: state.trash.nodes.filter(n => n.node.id !== id), edges: state.trash.edges.filter(e => e.source !== id && e.target !== id) } })
    },
    emptyTrash: () => { const state = get(); if (state.trash.nodes.length) set({ ...remember(state), trash: emptyTrash() }) },
    deleteEdge: id => {
      const state = get(); if (!state.edges.some(e => e.id === id)) return
      set({ ...remember(state), edges: state.edges.filter(e => e.id !== id), selectedEdgeId: null, structureVersion: state.structureVersion + 1 })
    },
    autoArrange: () => set(state => ({ ...remember(state), layoutRequest: state.layoutRequest + 1 })),
    hydrateGraph: (nodes, edges, trash = emptyTrash()) => {
      past.length = 0; future.length = 0; coalesceKey = ''
      const all = [...nodes, ...trash.nodes.map(entry => entry.node)]
      set(state => ({ nodes: normalize(nodes, all), edges, trash: { ...trash, nodes: trash.nodes.map(entry => ({ ...entry, node: normalize([entry.node], all)[0] })) },
        selectedId: nodes[0]?.id ?? null, selectedEdgeId: null, neighborhoodId: null, undoDepth: 0, redoDepth: 0,
        structureVersion: state.structureVersion + 1, graphEpoch: state.graphEpoch + 1, selectionVersion: state.selectionVersion + 1 }))
    },
    applyRuntimePositions: positions => set(state => ({ nodes: state.nodes.map(node => {
      const next = positions[node.id]
      return next && next.every(Number.isFinite) && next.some((v, i) => v !== node.position[i]) ? { ...node, position: validPosition(next) } : node
    }) })),
    resetGraph: () => {
      const state = get(), history = remember(state)
      graphEngine.stop(); graphEngine.syncGraph(initialNodes, initialEdges, true)
      set({ ...history, nodes: initialNodes, edges: initialEdges, trash: emptyTrash(), selectedId: 'root', selectedEdgeId: null, neighborhoodId: null,
        structureVersion: state.structureVersion + 1, graphEpoch: state.graphEpoch + 1, layoutRequest: state.layoutRequest + 1 })
    },
  }
})
