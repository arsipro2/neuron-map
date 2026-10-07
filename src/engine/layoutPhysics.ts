// Shared spacing keeps dragging from contracting an arranged graph.
export const GRAPH_SPACING = 4.1

export function deterministicDirection(a: number, b: number) {
  const seed = (((a + 1) * 73856093) ^ ((b + 1) * 19349663)) >>> 0
  const u = (seed % 10000) / 10000
  const v = (((seed * 1664525 + 1013904223) >>> 0) % 10000) / 10000
  const theta = u * Math.PI * 2
  const z = v * 2 - 1
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return [Math.cos(theta) * r, z, Math.sin(theta) * r] as const
}

export type LayoutBranches = {
  parents: Int32Array
  continuations: Int32Array
  directions: Float32Array
  anchors: Float32Array
}

// Infer a spanning forest once per layout request. Prefer source-only hubs as
// roots, then the highest-degree node if the component contains a cycle.
export function buildLayoutBranches(positions: Float32Array, edges: Int32Array, neighbors: ReadonlySet<number>[]): LayoutBranches {
  const n = neighbors.length
  const incoming = new Uint32Array(n), visited = new Uint8Array(n)
  const outgoing = Array.from({ length: n }, () => new Set<number>())
  const parents = new Int32Array(n).fill(-2), directions = new Float32Array(n * 3)
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1]
    if (a >= 0 && b >= 0 && a < n && b < n && a !== b) { incoming[b]++; outgoing[a].add(b) }
  }
  const radiusSquared = (i: number) => positions[i * 3] ** 2 + positions[i * 3 + 1] ** 2 + positions[i * 3 + 2] ** 2
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue
    const component = [start]
    visited[start] = 1
    for (let head = 0; head < component.length; head++) {
      for (const next of neighbors[component[head]]) {
        if (visited[next]) continue
        visited[next] = 1; component.push(next)
      }
    }
    let root = start
    for (const node of component) {
      const source = incoming[node] === 0, rootSource = incoming[root] === 0
      if ((source && !rootSource) || (source === rootSource && (
        neighbors[node].size > neighbors[root].size ||
        (neighbors[node].size === neighbors[root].size && radiusSquared(node) < radiusSquared(root))
      ))) root = node
    }
    const queue = [root]
    const reverseCandidates: Array<[number, number]> = []
    parents[root] = -1
    const visit = (parent: number, child: number) => {
      parents[child] = parent; queue.push(child)
      const po = parent * 3, co = child * 3
      if (parent !== root) {
        directions.set(directions.subarray(po, po + 3), co)
        return
      }
      const dx = positions[co] - positions[po], dy = positions[co + 1] - positions[po + 1], dz = positions[co + 2] - positions[po + 2]
      const length = Math.hypot(dx, dy, dz)
      directions.set(length > 0.001 ? [dx / length, dy / length, dz / length] : deterministicDirection(parent, child), co)
    }
    let head = 0, reverseHead = 0
    while (head < queue.length || reverseHead < reverseCandidates.length) {
      // Exhaust outward source→target links before using reverse links. This
      // prevents a cross-link from reparenting a descendant into another branch.
      if (head === queue.length) {
        const [parent, child] = reverseCandidates[reverseHead++]
        if (parents[child] === -2) visit(parent, child)
        continue
      }
      const parent = queue[head++]
      for (const child of outgoing[parent]) if (parents[child] === -2) visit(parent, child)
      for (const child of neighbors[parent]) if (parents[child] === -2) reverseCandidates.push([parent, child])
    }
  }
  const continuations = new Int32Array(n).fill(-1)
  for (let child = 0; child < n; child++) {
    const parent = parents[child]
    if (parent >= 0) continuations[parent] = continuations[parent] === -1 ? child : -2
  }
  return { parents, continuations, directions, anchors: positions.slice() }
}

export function applyLayoutIteration(positions: Float32Array, edges: Int32Array, neighbors: ReadonlySet<number>[], branches: LayoutBranches) {
  const n = positions.length / 3
  if (!n) return
  const forces = new Float32Array(n * 3)
  const ideal = GRAPH_SPACING
  const radius = ideal * 1.6
  const cell = radius
  const buckets = new Map<string, number[]>()
  for (let i = 0; i < n; i += 1) {
    const o = i * 3
    const key = `${Math.floor(positions[o] / cell)},${Math.floor(positions[o + 1] / cell)},${Math.floor(positions[o + 2] / cell)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }
  // local spatial repulsion only: O(n) average instead of O(n²)
  for (let a = 0; a < n; a += 1) {
    const ao = a * 3
    const cx = Math.floor(positions[ao] / cell)
    const cy = Math.floor(positions[ao + 1] / cell)
    const cz = Math.floor(positions[ao + 2] / cell)
    for (let x = -1; x <= 1; x += 1) for (let y = -1; y <= 1; y += 1) for (let z = -1; z <= 1; z += 1) {
      const bucket = buckets.get(`${cx + x},${cy + y},${cz + z}`)
      if (!bucket) continue
      for (const b of bucket) {
        if (b <= a) continue
        const bo = b * 3
        let dx = positions[ao] - positions[bo]
        let dy = positions[ao + 1] - positions[bo + 1]
        let dz = positions[ao + 2] - positions[bo + 2]
        let dist = Math.hypot(dx, dy, dz)
        if (dist > radius) continue
        if (dist < 0.001) {
          const d = deterministicDirection(a, b)
          dx = d[0] * 0.001; dy = d[1] * 0.001; dz = d[2] * 0.001; dist = 0.001
        }
        // A direct link stays compact; unlinked neighbors (including nodes
        // on different branches) receive a larger clearance.
        const clearance = ideal * (neighbors[a].has(b) ? 0.78 : 1.15)
        const strength = Math.max(0, clearance - dist) * 0.18 + 0.008 / (dist * dist + 0.08)
        const inv = strength / dist
        forces[ao] += dx * inv; forces[ao + 1] += dy * inv; forces[ao + 2] += dz * inv
        forces[bo] -= dx * inv; forces[bo + 1] -= dy * inv; forces[bo + 2] -= dz * inv
      }
    }
  }
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1]
    if (a < 0 || b < 0 || a >= n || b >= n) continue
    const ao = a * 3, bo = b * 3
    let dx = positions[bo] - positions[ao]
    let dy = positions[bo + 1] - positions[ao + 1]
    let dz = positions[bo + 2] - positions[ao + 2]
    let dist = Math.hypot(dx, dy, dz) || 0.001
    const natural = ideal * (0.94 + (((a * 19 + b * 23) & 127) / 127) * 0.12)
    // Cross-links must not pull a branch back into another branch's hub.
    const treeLink = branches.parents[a] === b || branches.parents[b] === a
    const strength = (dist - natural) * (treeLink ? 0.11 : 0.012)
    const inv = strength / dist
    forces[ao] += dx * inv; forces[ao + 1] += dy * inv; forces[ao + 2] += dz * inv
    forces[bo] -= dx * inv; forces[bo + 1] -= dy * inv; forces[bo + 2] -= dz * inv
  }
  // Keep each branch progressing away from its root. A soft lateral force still
  // lets its children fan out; it prevents large sideways detours and foldbacks.
  for (let i = 0; i < n; i += 1) {
    const o = i * 3
    const parent = branches.parents[i]
    if (parent < 0) {
      for (let axis = 0; axis < 3; axis++) forces[o + axis] += (branches.anchors[o + axis] - positions[o + axis]) * 0.035
      continue
    }
    const po = parent * 3
    const dx = positions[o] - positions[po], dy = positions[o + 1] - positions[po + 1], dz = positions[o + 2] - positions[po + 2]
    const nx = branches.directions[o], ny = branches.directions[o + 1], nz = branches.directions[o + 2]
    const progress = dx * nx + dy * ny + dz * nz
    const outward = Math.max(0, ideal * 0.65 - progress) * 0.16
    const fx = nx * outward - (dx - nx * progress) * 0.008
    const fy = ny * outward - (dy - ny * progress) * 0.008
    const fz = nz * outward - (dz - nz * progress) * 0.008
    forces[o] += fx; forces[o + 1] += fy; forces[o + 2] += fz
    forces[po] -= fx; forces[po + 1] -= fy; forces[po + 2] -= fz
  }
  // Straighten a sequence of notes, not a branching hub. Use the inferred tree
  // so an unrelated cross-link does not disable smoothing of a branch.
  for (let i = 0; i < n; i++) {
    const parent = branches.parents[i], child = branches.continuations[i]
    if (parent < 0 || child < 0) continue
    for (let axis = 0; axis < 3; axis++) {
      const o = i * 3 + axis, po = parent * 3 + axis, co = child * 3 + axis
      const correction = ((positions[po] + positions[co]) / 2 - positions[o]) * 0.15
      forces[o] += correction
      forces[po] -= correction / 2; forces[co] -= correction / 2
    }
  }
  const alpha = 0.72
  for (let i = 0; i < n; i += 1) {
    // Hold each connected component's root in place during automatic layout;
    // isolated notes still participate in repulsion so they can separate.
    if (branches.parents[i] < 0 && neighbors[i].size > 0) continue
    const o = i * 3
    const fx = Math.max(-0.12, Math.min(0.12, forces[o]))
    const fy = Math.max(-0.12, Math.min(0.12, forces[o + 1]))
    const fz = Math.max(-0.12, Math.min(0.12, forces[o + 2]))
    positions[o] += fx * alpha
    positions[o + 1] += fy * alpha
    positions[o + 2] += fz * alpha
  }
}
