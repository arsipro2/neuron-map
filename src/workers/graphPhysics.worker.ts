/// <reference lib="webworker" />
export {}
declare const self: DedicatedWorkerGlobalScope
type InitMessage = { type: 'init'; revision: number; ids: string[]; positions: ArrayBuffer; edges: ArrayBuffer }
type DragStartMessage = { type: 'dragStart'; index: number; target: [number, number, number] }
type DragTargetMessage = { type: 'dragTarget'; target: [number, number, number] }
type SimpleMessage = { type: 'dragEnd' | 'layout' | 'stop' }
type Incoming = InitMessage | DragStartMessage | DragTargetMessage | SimpleMessage

let revision = 0
let ids: string[] = []
let positions = new Float32Array(0)
let velocities = new Float32Array(0)
let edges = new Int32Array(0)
let adjacency: number[][] = []
let activeMask = new Uint8Array(0)
let draggingIndex = -1
let dragTarget: [number, number, number] = [0, 0, 0]
let running = false
let layoutIterations = 0
let timer: number | null = null
let lastTick = performance.now()

const postActivity = (active: boolean) => self.postMessage({ type: 'activity', active, revision })

function ensureTimer() {
  if (timer !== null) return
  lastTick = performance.now()
  timer = self.setInterval(step, 33)
}

function maybeStopTimer() {
  if (running || draggingIndex >= 0 || layoutIterations > 0) return
  if (timer !== null) self.clearInterval(timer)
  timer = null
}

function buildAdjacency() {
  adjacency = Array.from({ length: ids.length }, () => [])
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1]
    if (a < 0 || b < 0 || a >= ids.length || b >= ids.length) continue
    adjacency[a].push(b)
    adjacency[b].push(a)
  }
}

function activateNeighborhood(start: number) {
  activeMask = new Uint8Array(ids.length)
  const queue: Array<[number, number]> = [[start, 0]]
  activeMask[start] = 1
  let count = 1
  while (queue.length && count < 900) {
    const [node, depth] = queue.shift()!
    if (depth >= 8) continue
    for (const next of adjacency[node]) {
      if (activeMask[next]) continue
      activeMask[next] = 1
      count += 1
      queue.push([next, depth + 1])
      if (count >= 900) break
    }
  }
}

function deterministicDirection(a: number, b: number) {
  const seed = (((a + 1) * 73856093) ^ ((b + 1) * 19349663)) >>> 0
  const u = (seed % 10000) / 10000
  const v = (((seed * 1664525 + 1013904223) >>> 0) % 10000) / 10000
  const theta = u * Math.PI * 2
  const z = v * 2 - 1
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  return [Math.cos(theta) * r, z, Math.sin(theta) * r] as const
}

function runDragPhysics(dt: number) {
  const n = ids.length
  if (!n) return false
  const forces = new Float32Array(n * 3)
  let kinetic = 0
  const ideal = 2.95

  if (draggingIndex >= 0) {
    const o = draggingIndex * 3
    const follow = 1 - Math.exp(-dt * 32)
    positions[o] += (dragTarget[0] - positions[o]) * follow
    positions[o + 1] += (dragTarget[1] - positions[o + 1]) * follow
    positions[o + 2] += (dragTarget[2] - positions[o + 2]) * follow
    velocities[o] = velocities[o + 1] = velocities[o + 2] = 0
  }

  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1]
    if (a < 0 || b < 0 || !activeMask[a] || !activeMask[b]) continue
    const ao = a * 3, bo = b * 3
    let dx = positions[bo] - positions[ao]
    let dy = positions[bo + 1] - positions[ao + 1]
    let dz = positions[bo + 2] - positions[ao + 2]
    let dist = Math.hypot(dx, dy, dz)
    if (dist < 1e-4) {
      const d = deterministicDirection(a, b)
      dx = d[0]; dy = d[1]; dz = d[2]; dist = 1
    }
    const inv = 1 / dist
    const nx = dx * inv, ny = dy * inv, nz = dz * inv
    const variance = 0.95 + (((a * 31 + b * 17) & 255) / 255) * 0.1
    const stretch = dist - ideal * variance
    const rvx = velocities[bo] - velocities[ao]
    const rvy = velocities[bo + 1] - velocities[ao + 1]
    const rvz = velocities[bo + 2] - velocities[ao + 2]
    const along = rvx * nx + rvy * ny + rvz * nz
    const magnitude = stretch * 15 + along * 2.1
    forces[ao] += nx * magnitude; forces[ao + 1] += ny * magnitude; forces[ao + 2] += nz * magnitude
    forces[bo] -= nx * magnitude; forces[bo + 1] -= ny * magnitude; forces[bo + 2] -= nz * magnitude
  }

  const radius = 1.55
  const cell = radius
  const buckets = new Map<string, number[]>()
  for (let i = 0; i < n; i += 1) {
    if (!activeMask[i]) continue
    const o = i * 3
    const key = `${Math.floor(positions[o] / cell)},${Math.floor(positions[o + 1] / cell)},${Math.floor(positions[o + 2] / cell)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }
  for (let a = 0; a < n; a += 1) {
    if (!activeMask[a]) continue
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
        if (dist >= radius) continue
        if (dist < 0.001) {
          const d = deterministicDirection(a, b)
          dx = d[0] * 0.001; dy = d[1] * 0.001; dz = d[2] * 0.001; dist = 0.001
        }
        const strength = (radius - dist) * 9
        const inv = strength / dist
        forces[ao] += dx * inv; forces[ao + 1] += dy * inv; forces[ao + 2] += dz * inv
        forces[bo] -= dx * inv; forces[bo + 1] -= dy * inv; forces[bo + 2] -= dz * inv
      }
    }
  }

  const damping = Math.exp(-dt * 5.4)
  for (let i = 0; i < n; i += 1) {
    if (!activeMask[i] || i === draggingIndex) continue
    const o = i * 3
    velocities[o] = (velocities[o] + forces[o] * dt) * damping
    velocities[o + 1] = (velocities[o + 1] + forces[o + 1] * dt) * damping
    velocities[o + 2] = (velocities[o + 2] + forces[o + 2] * dt) * damping
    const speed = Math.hypot(velocities[o], velocities[o + 1], velocities[o + 2])
    if (speed > 8.2) {
      const k = 8.2 / speed
      velocities[o] *= k; velocities[o + 1] *= k; velocities[o + 2] *= k
    }
    positions[o] += velocities[o] * dt
    positions[o + 1] += velocities[o + 1] * dt
    positions[o + 2] += velocities[o + 2] * dt
    kinetic += velocities[o] ** 2 + velocities[o + 1] ** 2 + velocities[o + 2] ** 2
  }
  return draggingIndex >= 0 || kinetic > 0.003
}

function runLayoutIteration() {
  const n = ids.length
  if (!n) return
  const forces = new Float32Array(n * 3)
  const ideal = 3.05
  const cell = ideal * 1.35
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
        if (dist > ideal * 1.4) continue
        if (dist < 0.001) {
          const d = deterministicDirection(a, b)
          dx = d[0] * 0.001; dy = d[1] * 0.001; dz = d[2] * 0.001; dist = 0.001
        }
        const strength = Math.max(0, ideal * 0.78 - dist) * 0.18 + 0.008 / (dist * dist + 0.08)
        const inv = strength / dist
        forces[ao] += dx * inv; forces[ao + 1] += dy * inv; forces[ao + 2] += dz * inv
        forces[bo] -= dx * inv; forces[bo + 1] -= dy * inv; forces[bo + 2] -= dz * inv
      }
    }
  }
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1]
    if (a < 0 || b < 0) continue
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
    const degree = adjacency[i]?.length ?? 0
    const o = i * 3
    const gravity = 0.0018 + Math.min(0.008, degree * 0.00065)
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

function emitPositions(settled = false) {
  const copy = positions.slice()
  self.postMessage({ type: settled ? 'settled' : 'positions', positions: copy.buffer, revision }, [copy.buffer])
}

function step() {
  const now = performance.now()
  const dt = Math.min(0.04, Math.max(0.008, (now - lastTick) / 1000))
  lastTick = now
  let active = false
  if (layoutIterations > 0) {
    const batch = Math.min(5, layoutIterations)
    for (let i = 0; i < batch; i += 1) runLayoutIteration()
    layoutIterations -= batch
    active = layoutIterations > 0
  } else if (draggingIndex >= 0 || running) {
    running = runDragPhysics(dt)
    active = running
  }
  emitPositions(false)
  if (!active && draggingIndex < 0 && layoutIterations <= 0) {
    running = false
    postActivity(false)
    emitPositions(true)
    maybeStopTimer()
  }
}

self.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data
  if (message.type === 'init') {
    revision = message.revision
    if (timer !== null) self.clearInterval(timer)
    timer = null
    ids = message.ids
    positions = new Float32Array(message.positions)
    velocities = new Float32Array(positions.length)
    edges = new Int32Array(message.edges)
    activeMask = new Uint8Array(ids.length)
    buildAdjacency()
    draggingIndex = -1
    running = false
    layoutIterations = 0
    return
  }
  if (message.type === 'dragStart') {
    if (message.index < 0 || message.index >= ids.length) return
    layoutIterations = 0
    draggingIndex = message.index
    dragTarget = message.target
    activateNeighborhood(draggingIndex)
    running = true
    postActivity(true)
    ensureTimer()
  } else if (message.type === 'dragTarget') {
    dragTarget = message.target
  } else if (message.type === 'dragEnd') {
    draggingIndex = -1
    running = true
    postActivity(true)
    ensureTimer()
  } else if (message.type === 'layout') {
    activeMask = new Uint8Array(ids.length)
    activeMask.fill(1)
    layoutIterations = ids.length > 1600 ? 90 : ids.length > 700 ? 120 : 160
    running = false
    postActivity(true)
    ensureTimer()
  } else if (message.type === 'stop') {
    draggingIndex = -1
    running = false
    layoutIterations = 0
    postActivity(false)
    maybeStopTimer()
  }
}
