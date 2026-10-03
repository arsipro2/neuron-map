import type { Edge, NoteNode, Vec3 } from '../types'

const safeCoordinate = (n: number) => Number.isFinite(n) ? Math.max(-100000, Math.min(100000, n)) : 0
const safeTarget = (p: Vec3) => p.map(safeCoordinate) as Vec3

type PositionListener = () => void
type SettledListener = (positions: Record<string, Vec3>) => void

type WorkerMessage = ({ revision: number }) & (
  | { type: 'positions'; positions: ArrayBuffer }
  | { type: 'settled'; positions: ArrayBuffer }
  | { type: 'activity'; active: boolean })

class GraphRuntime {
  ids: string[] = []
  indexById = new Map<string, number>()
  positions = new Float32Array(0)
  version = 0
  structureVersion = 0
  private listeners = new Set<PositionListener>()

  sync(nodes: NoteNode[], preserve = true) {
    const previous = preserve ? this.snapshot() : Object.create(null)
    const sameIds = nodes.length === this.ids.length && nodes.every((node, i) => node.id === this.ids[i])
    if (sameIds) return false
    this.ids = nodes.map((node) => node.id)
    this.indexById = new Map(this.ids.map((id, i) => [id, i]))
    this.positions = new Float32Array(nodes.length * 3)
    for (let i = 0; i < nodes.length; i += 1) {
      const p = previous[nodes[i].id] ?? nodes[i].position
      const o = i * 3
      this.positions[o] = safeCoordinate(p[0])
      this.positions[o + 1] = safeCoordinate(p[1])
      this.positions[o + 2] = safeCoordinate(p[2])
    }
    this.structureVersion += 1
    this.version += 1
    this.emit()
    return true
  }

  forcePositions(nodes: NoteNode[]) {
    if (nodes.length !== this.ids.length) return this.sync(nodes)
    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i].id !== this.ids[i]) return this.sync(nodes)
      const p = nodes[i].position
      const o = i * 3
      this.positions[o] = safeCoordinate(p[0])
      this.positions[o + 1] = safeCoordinate(p[1])
      this.positions[o + 2] = safeCoordinate(p[2])
    }
    this.version += 1
    this.emit()
    return true
  }

  apply(buffer: ArrayBuffer) {
    const incoming = new Float32Array(buffer)
    if (incoming.length !== this.positions.length || incoming.some(n => !Number.isFinite(n))) return
    for (let i = 0; i < incoming.length; i++) incoming[i] = safeCoordinate(incoming[i])
    this.positions.set(incoming)
    this.version += 1
    this.emit()
  }

  positionOf(id: string, out?: Vec3): Vec3 | null {
    const index = this.indexById.get(id)
    if (index === undefined) return null
    const o = index * 3
    const target = out ?? [0, 0, 0]
    target[0] = this.positions[o]
    target[1] = this.positions[o + 1]
    target[2] = this.positions[o + 2]
    return target
  }

  snapshot(): Record<string, Vec3> {
    const result: Record<string, Vec3> = Object.create(null)
    for (let i = 0; i < this.ids.length; i += 1) {
      const o = i * 3
      result[this.ids[i]] = [this.positions[o], this.positions[o + 1], this.positions[o + 2]]
    }
    return result
  }

  subscribe(listener: PositionListener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}

class GraphEngine {
  readonly runtime = new GraphRuntime()
  private worker: Worker | null = null
  private revision = 0
  private fallbackDragId: string | null = null
  private dragId: string | null = null
  private edges: Edge[] = []
  private settledListeners = new Set<SettledListener>()
  private activityListeners = new Set<(active: boolean) => void>()
  active = false

  private ensureWorker() {
    if (this.worker || typeof Worker === 'undefined') return
    try {
      this.worker = new Worker(new URL('../workers/graphPhysics.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) { console.error('Physics worker could not start:', error); return }
    this.worker.onerror = (error) => {
      console.error('Physics worker failed:', error.message)
      this.worker?.terminate(); this.worker = null; this.active = false
      this.fallbackDragId = this.dragId
      for (const listener of this.activityListeners) listener(false)
      for (const listener of this.settledListeners) listener(this.runtime.snapshot())
    }
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data
      if (message.revision !== this.revision) return
      if (message.type === 'positions') {
        this.runtime.apply(message.positions)
      } else if (message.type === 'settled') {
        this.runtime.apply(message.positions)
        const snapshot = this.runtime.snapshot()
        for (const listener of this.settledListeners) listener(snapshot)
      } else if (message.type === 'activity') {
        this.active = message.active
        for (const listener of this.activityListeners) listener(message.active)
      }
    }
    this.initializeWorker()
  }

  private initializeWorker() {
    if (!this.worker) return
    const edges = this.edges
    const edgeIndices = new Int32Array(edges.length * 2)
    for (let i = 0; i < edges.length; i += 1) {
      edgeIndices[i * 2] = this.runtime.indexById.get(edges[i].source) ?? -1
      edgeIndices[i * 2 + 1] = this.runtime.indexById.get(edges[i].target) ?? -1
    }
    const positions = this.runtime.positions.slice()
    this.worker.postMessage({ type: 'init', revision: this.revision, ids: this.runtime.ids, positions: positions.buffer, edges: edgeIndices.buffer }, [positions.buffer, edgeIndices.buffer])
  }

  syncGraph(nodes: NoteNode[], edges: Edge[], forcePositions = false) {
    const structureChanged = this.runtime.sync(nodes, !forcePositions)
    if (!structureChanged && forcePositions) this.runtime.forcePositions(nodes)
    const edgesChanged = structureChanged || edges.length !== this.edges.length || edges.some((edge, i) => {
      const old = this.edges[i]
      return !old || old.id !== edge.id || old.source !== edge.source || old.target !== edge.target
    })
    if (!structureChanged && !edgesChanged && !forcePositions) return
    this.revision += 1
    this.active = false
    this.edges = edges.map((edge) => ({ ...edge }))
    if (this.worker) this.initializeWorker()
    else this.ensureWorker()
  }

  startDrag(id: string, target: Vec3) {
    this.ensureWorker()
    this.dragId = id
    target = safeTarget(target)
    const index = this.runtime.indexById.get(id)
    if (index === undefined) return
    if (!this.worker) { this.fallbackDragId = id; this.updateDrag(target); return }
    this.worker.postMessage({ type: 'dragStart', index, target })
  }

  updateDrag(target: Vec3) {
    target = safeTarget(target)
    if (this.fallbackDragId) {
      const index = this.runtime.indexById.get(this.fallbackDragId)
      if (index !== undefined) {
        const positions = this.runtime.positions.slice()
        positions.set(target, index * 3)
        this.runtime.apply(positions.buffer)
      }
    }
    this.worker?.postMessage({ type: 'dragTarget', target })
  }

  endDrag() {
    this.dragId = null
    if (this.fallbackDragId) {
      this.fallbackDragId = null
      for (const listener of this.settledListeners) listener(this.runtime.snapshot())
    }
    this.worker?.postMessage({ type: 'dragEnd' })
  }

  autoLayout() {
    this.ensureWorker()
    this.worker?.postMessage({ type: 'layout' })
  }

  stop() {
    this.worker?.terminate()
    this.worker = null
    this.active = false
    this.fallbackDragId = null
    this.dragId = null
    for (const listener of this.activityListeners) listener(false)
    this.revision += 1
  }

  onSettled(listener: SettledListener) {
    this.settledListeners.add(listener)
    return () => { this.settledListeners.delete(listener) }
  }

  onActivity(listener: (active: boolean) => void) {
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }
}

export const graphEngine = new GraphEngine()
