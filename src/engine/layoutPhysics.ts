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

export function applyLayoutIteration(positions: Float32Array, edges: Int32Array, neighbors: ReadonlySet<number>[]) {
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
    const strength = (dist - natural) * 0.055
    const inv = strength / dist
    forces[ao] += dx * inv; forces[ao + 1] += dy * inv; forces[ao + 2] += dz * inv
    forces[bo] -= dx * inv; forces[bo + 1] -= dy * inv; forces[bo + 2] -= dz * inv
  }
  // degree-weighted central gravity keeps hubs central without snapping the whole graph
  for (let i = 0; i < n; i += 1) {
    const degree = neighbors[i].size
    const o = i * 3
    const gravity = 0.001 + Math.min(0.004, degree * 0.0004)
    forces[o] += -positions[o] * gravity
    forces[o + 1] += -positions[o + 1] * gravity
    forces[o + 2] += -positions[o + 2] * gravity
  }
  const alpha = 0.72
  for (let i = 0; i < n; i += 1) {
    const o = i * 3
    const fx = Math.max(-0.12, Math.min(0.12, forces[o]))
    const fy = Math.max(-0.12, Math.min(0.12, forces[o + 1]))
    const fz = Math.max(-0.12, Math.min(0.12, forces[o + 2]))
    positions[o] += fx * alpha
    positions[o + 1] += fy * alpha
    positions[o + 2] += fz * alpha
  }
}
