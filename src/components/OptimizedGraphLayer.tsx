import { Billboard, Text } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState, Suspense, type RefObject } from 'react'
import * as THREE from 'three'
import { graphEngine } from '../engine/graphEngine'
import { useGraphStore } from '../store/useGraphStore'
import { edgeMidpoint, edgePoint, hashNumber } from '../engine/edgeGeometry'
import { visibleNoteIds } from '../services/graphView'
import type { Edge, Vec3 } from '../types'

const tmpColor = new THREE.Color()
const NODE_FONT = '/fonts/NotoSans-Regular.ttf'

export const graphDiagnostics = { edgeGeometryBuilds: 0 }

function GraphEngineBridge() {
  const structureVersion = useGraphStore((s) => s.structureVersion)
  const graphEpoch = useGraphStore((s) => s.graphEpoch)
  const layoutRequest = useGraphStore((s) => s.layoutRequest)
  const applyRuntimePositions = useGraphStore((s) => s.applyRuntimePositions)
  const lastLayoutRequest = useRef(layoutRequest)
  const lastEpoch = useRef(-1)

  useEffect(() => {
    const state = useGraphStore.getState()
    graphEngine.syncGraph(state.nodes, state.edges, lastEpoch.current !== graphEpoch)
    lastEpoch.current = graphEpoch
  }, [structureVersion, graphEpoch])

  useEffect(() => {
    if (layoutRequest === lastLayoutRequest.current) return
    lastLayoutRequest.current = layoutRequest
    graphEngine.autoLayout()
  }, [layoutRequest])

  useEffect(() => graphEngine.onSettled((positions) => applyRuntimePositions(positions)), [applyRuntimePositions])
  return null
}

function RuntimeInvalidator() {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => graphEngine.runtime.subscribe(() => invalidate()), [invalidate])
  return null
}

function DemandFrameScheduler({ flightActive, reducedMotion, pulseCount }: { flightActive: boolean; reducedMotion: boolean; pulseCount: RefObject<number> }) {
  const invalidate = useThree((s) => s.invalidate)
  const edgeCount = useGraphStore((s) => s.edges.length)
  const selectedId = useGraphStore((s) => s.selectedId)
  const selectedEdgeId = useGraphStore((s) => s.selectedEdgeId)

  useFrame(() => {
    if (flightActive || graphEngine.active) invalidate()
  })

  useEffect(() => {
    if (flightActive || reducedMotion || edgeCount === 0) return
    // Link particles are deliberately low-frequency. Large graphs only animate
    // particles around a selected node/edge, otherwise the scene can fully sleep.
    if (edgeCount > 900 && !selectedId && !selectedEdgeId) return
    const hz = edgeCount > 500 ? 7 : 12
    const timer = window.setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]') && pulseCount.current > 0) invalidate() }, 1000 / hz)
    return () => window.clearInterval(timer)
  }, [edgeCount, flightActive, invalidate, selectedEdgeId, selectedId, reducedMotion, pulseCount])
  return null
}

function BatchedNodeLayer({ hoveredId, aimedId, connectionTargetId, linkSourceId, hitMeshRef }: {
  hoveredId: string | null
  aimedId: string | null
  connectionTargetId: string | null
  linkSourceId: string | null
  hitMeshRef: RefObject<THREE.InstancedMesh | null>
}) {
  const nodeCount = useGraphStore((s) => s.nodes.length)
  const neighborhoodId = useGraphStore(s => s.neighborhoodId)
  const structureVersion = useGraphStore(s => s.structureVersion)
  const selectedId = useGraphStore((s) => s.selectedId)
  const coreRef = useRef<THREE.InstancedMesh>(null)
  const glowRef = useRef<THREE.InstancedMesh>(null)
  const matrix = useMemo(() => new THREE.Matrix4(), [])
  const position = useMemo(() => new THREE.Vector3(), [])
  const scale = useMemo(() => new THREE.Vector3(), [])
  const quaternion = useMemo(() => new THREE.Quaternion(), [])
  const lastBatch = useRef('')

  // One warm, unified neuron palette. We deliberately do NOT use per-instance
  // colors here: apart from matching the original visual language, it avoids the
  // WebKitGTK/instanceColor path that produced black nodes on some Linux setups.
  const coreGeometry = useMemo(() => new THREE.IcosahedronGeometry(0.125, 1), [])
  const glowGeometry = useMemo(() => new THREE.IcosahedronGeometry(0.235, 1), [])
  const hitGeometry = useMemo(() => new THREE.IcosahedronGeometry(0.32, 1), [])
  const coreMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: '#fff2b5', toneMapped: false }), [])
  const glowMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#f1c85a',
    transparent: true,
    opacity: 0.11,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }), [])
  const hitMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: '#000000' }), [])

  useFrame(() => {
    const runtime = graphEngine.runtime
    const count = Math.min(runtime.ids.length, nodeCount)
    if (!coreRef.current || !glowRef.current || !hitMeshRef.current) return

    const stamp = `${runtime.version}:${count}:${selectedId}:${hoveredId}:${aimedId}:${connectionTargetId}:${linkSourceId}:${neighborhoodId}:${structureVersion}`
    if (lastBatch.current === stamp && coreRef.current.count === count) return
    lastBatch.current = stamp
    coreRef.current.count = count
    glowRef.current.count = count
    hitMeshRef.current.count = count

    for (let i = 0; i < count; i += 1) {
      const o = i * 3
      position.set(runtime.positions[o], runtime.positions[o + 1], runtime.positions[o + 2])
      const id = runtime.ids[i]
      const emphasized = id === selectedId || id === hoveredId || id === aimedId || id === connectionTargetId || id === linkSourceId

      const visible = !visibleNoteIds() || visibleNoteIds()!.has(id)
      const coreScale = visible ? (emphasized ? 1.24 : 1) : 0
      scale.setScalar(coreScale)
      matrix.compose(position, quaternion, scale)
      coreRef.current.setMatrixAt(i, matrix)

      scale.setScalar(visible ? (emphasized ? 1.42 : 1) : 0)
      matrix.compose(position, quaternion, scale)
      glowRef.current.setMatrixAt(i, matrix)

      // The hit volume is intentionally larger than the visible sphere. It is a
      // single invisible InstancedMesh, so interaction stays forgiving without
      // returning to thousands of per-node hitbox objects.
      scale.setScalar(visible ? 1 : 0)
      matrix.compose(position, quaternion, scale)
      hitMeshRef.current.setMatrixAt(i, matrix)
    }
    coreRef.current.instanceMatrix.needsUpdate = true
    glowRef.current.instanceMatrix.needsUpdate = true
    hitMeshRef.current.instanceMatrix.needsUpdate = true
    // Frustum culling is disabled for visible batches. Keep one deliberately
    // large hit bound so InstancedMesh raycasting never recomputes an O(n)
    // bounding sphere during pointer movement.
    if (!hitMeshRef.current.boundingSphere || hitMeshRef.current.boundingSphere.radius < 999999) {
      hitMeshRef.current.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1_000_000)
    }
  })

  useEffect(() => () => {
    coreGeometry.dispose(); glowGeometry.dispose(); hitGeometry.dispose()
    coreMaterial.dispose(); glowMaterial.dispose(); hitMaterial.dispose()
  }, [coreGeometry, coreMaterial, glowGeometry, glowMaterial, hitGeometry, hitMaterial])

  return (
    <>
      <instancedMesh ref={glowRef} args={[glowGeometry, glowMaterial, Math.max(1, nodeCount)]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={coreRef} args={[coreGeometry, coreMaterial, Math.max(1, nodeCount)]} frustumCulled={false} raycast={() => null} />
      {/* Never rendered, but manually raycast by GraphInteractionController. */}
      <instancedMesh ref={hitMeshRef} args={[hitGeometry, hitMaterial, Math.max(1, nodeCount)]} visible={false} frustumCulled={false} />
    </>
  )
}

function BatchedEdgeLayer({ reducedMotion, pulseCount: activePulses }: { reducedMotion: boolean; pulseCount: RefObject<number> }) {
  const neighborhoodId = useGraphStore(s => s.neighborhoodId)
  const camera = useThree((s) => s.camera)
  const edges = useGraphStore((s) => s.edges)
  const selectedId = useGraphStore((s) => s.selectedId)
  const selectedEdgeId = useGraphStore((s) => s.selectedEdgeId)
  const maxVertices = Math.max(4, edges.length * 4)
  const positions = useMemo(() => new Float32Array(maxVertices * 3), [maxVertices])
  const colors = useMemo(() => new Float32Array(maxVertices * 3), [maxVertices])
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.setDrawRange(0, 0)
    return g
  }, [colors, positions])
  const material = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.52, depthWrite: false }), [])
  const glowMaterial = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.065, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const pulsePositions = useMemo(() => new Float32Array(Math.max(1, Math.min(edges.length, 192)) * 3), [edges.length])
  const pulseColors = useMemo(() => new Float32Array(Math.max(1, Math.min(edges.length, 192)) * 3), [edges.length])
  const pulseGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pulsePositions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(pulseColors, 3))
    g.setDrawRange(0, 0)
    return g
  }, [pulseColors, pulsePositions])
  const pulseMaterial = useMemo(() => new THREE.PointsMaterial({ size: 3.1, sizeAttenuation: false, transparent: true, opacity: 0.72, vertexColors: true, depthWrite: false, blending: THREE.AdditiveBlending }), [])
  const cache = useRef({ stamp: '', edges: null as Edge[] | null, pulses: [] as Array<{ a: Vec3; mid: Vec3; b: Vec3; hash: number }> })
  const projected = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }) => {
    const runtime = graphEngine.runtime, visible = visibleNoteIds()
    const stamp = `${runtime.version}:${camera.matrixWorld.elements.join(',')}:${camera.projectionMatrix.elements.join(',')}:${selectedId}:${selectedEdgeId}:${neighborhoodId}:${reducedMotion}`
    if (cache.current.stamp !== stamp || cache.current.edges !== edges) {
      cache.current = { stamp, edges, pulses: [] }; graphDiagnostics.edgeGeometryBuilds++
      let v = 0
      for (const edge of edges) {
        if (visible && (!visible.has(edge.source) || !visible.has(edge.target))) continue
        const a = runtime.positionOf(edge.source), b = runtime.positionOf(edge.target); if (!a || !b) continue
        const mid = edgeMidpoint(edge.id, a, b)
        projected.set(...mid).project(camera)
        if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.25 || Math.abs(projected.y) > 1.25) continue
        const distance = camera.position.distanceTo(new THREE.Vector3(...mid))
        const active = edge.id === selectedEdgeId || edge.source === selectedId || edge.target === selectedId
        if (distance > 95 && !active) continue
        tmpColor.set(active ? '#fff4ae' : '#d8c79d')
        for (const point of [a, mid, mid, b]) {
          const o = v++ * 3; positions.set(point, o); colors.set([tmpColor.r, tmpColor.g, tmpColor.b], o)
        }
        if (!reducedMotion && (active || (distance < 22 && edges.length < 1200)) && cache.current.pulses.length < pulsePositions.length / 3) {
          pulseColors.set([tmpColor.r, tmpColor.g, tmpColor.b], cache.current.pulses.length * 3)
          cache.current.pulses.push({ a, mid, b, hash: hashNumber(edge.id) })
        }
      }
      geometry.setDrawRange(0, v)
      geometry.getAttribute('position').needsUpdate = true; geometry.getAttribute('color').needsUpdate = true
      pulseGeometry.getAttribute('color').needsUpdate = true
      material.opacity = edges.length > 2500 ? 0.35 : 0.52; glowMaterial.opacity = edges.length > 1800 ? 0.025 : 0.06
    }
    const pulses = cache.current.pulses
    for (let i = 0; i < pulses.length; i++) {
      const { a, mid, b, hash } = pulses[i], t = (clock.elapsedTime * (0.08 + hash % 5 * 0.006) + hash % 100 / 100) % 1
      pulsePositions.set(edgePoint(a, mid, b, t), i * 3)
    }
    activePulses.current = pulses.length
    pulseGeometry.setDrawRange(0, pulses.length)
    if (pulses.length) pulseGeometry.getAttribute('position').needsUpdate = true
  })

  useEffect(() => () => {
    geometry.dispose(); material.dispose(); glowMaterial.dispose(); pulseGeometry.dispose(); pulseMaterial.dispose()
  }, [geometry, glowMaterial, material, pulseGeometry, pulseMaterial])

  return (
    <>
      <lineSegments geometry={geometry} material={glowMaterial} frustumCulled={false} raycast={() => null} />
      <lineSegments geometry={geometry} material={material} frustumCulled={false} raycast={() => null} />
      <points geometry={pulseGeometry} material={pulseMaterial} frustumCulled={false} raycast={() => null} />
    </>
  )
}

function nodeScreenAnchors(id: string, camera: THREE.Camera, canvas: HTMLCanvasElement) {
  if (visibleNoteIds() && !visibleNoteIds()!.has(id)) return null
  const p = graphEngine.runtime.positionOf(id)
  if (!p) return null
  const bounds = canvas.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  const world = new THREE.Vector3(...p)
  const projected = world.clone().project(camera)
  if (projected.z < -1 || projected.z > 1) return null
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize()
  const unit = world.clone().add(right).project(camera)
  const pixelsPerUnit = Math.max(0.001, Math.abs(unit.x - projected.x) * bounds.width / 2)
  const offset = Math.max(44, pixelsPerUnit * 0.155 + 26)
  const nodeX = bounds.left + (projected.x * 0.5 + 0.5) * bounds.width
  const nodeY = bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height
  return { nodeX, nodeY, plusX: nodeX + offset, plusY: nodeY, pixelsPerUnit, offset }
}

function RuntimeNodeLabel({
  id,
  title,
  summary,
  hot,
  showSummary,
  showPlus,
  connectionTarget,
  linkSource,
}: {
  id: string
  title: string
  summary: string
  hot: boolean
  showSummary: boolean
  showPlus: boolean
  connectionTarget: boolean
  linkSource: boolean
}) {
  const group = useRef<THREE.Group>(null)
  const plus = useRef<THREE.Group>(null)
  const { camera, gl } = useThree()
  useFrame(() => {
    const p = graphEngine.runtime.positionOf(id)
    if (!p || !group.current) return
    group.current.position.set(p[0], p[1], p[2])
    const a = plus.current ? nodeScreenAnchors(id, camera, gl.domElement) : null
    if (a && plus.current) {
      plus.current.position.x = a.offset / a.pixelsPerUnit
      plus.current.scale.setScalar(1 / a.pixelsPerUnit)
    }
  })
  return (
    <Billboard ref={group} follow lockX={false} lockY={false} lockZ={false}>
      <group position={[0, -0.31, 0]}>
        <Text font={NODE_FONT} fontSize={0.13} color={hot ? '#fff2b5' : '#e8e1ca'} anchorX="center" anchorY="middle" maxWidth={2.3} textAlign="center" outlineWidth={0.007} outlineColor="#000000">
          {title || 'Untitled'}
        </Text>
        {showSummary ? (
          <Text font={NODE_FONT} position={[0, -0.18, 0]} fontSize={0.082} color="#bdb29e" anchorX="center" anchorY="top" maxWidth={2.35} textAlign="center" lineHeight={1.25} outlineWidth={0.005} outlineColor="#000000">
            {connectionTarget ? 'Release to connect' : linkSource ? 'Choose target node' : ((summary ?? '').trim() || 'No short description yet').slice(0, 190)}
          </Text>
        ) : null}
      </group>
      {showPlus ? (
        <group ref={plus}><Text font={NODE_FONT} fontSize={24} color="#fff0a1" anchorX="center" anchorY="middle" outlineWidth={0.6} outlineColor="#5b4212">+</Text></group>
      ) : null}
    </Billboard>
  )
}

function NodeLabels({ hoveredId, aimedId, connectionTargetId, linkSourceId, cursorMode }: {
  hoveredId: string | null
  aimedId: string | null
  connectionTargetId: string | null
  linkSourceId: string | null
  cursorMode: boolean
}) {
  const camera = useThree((s) => s.camera)
  const nodes = useGraphStore((s) => s.nodes)
  useGraphStore(s => s.neighborhoodId)
  const selectedId = useGraphStore((s) => s.selectedId)
  const [visibleIds, setVisibleIds] = useState<string[]>([])
  const lastLabelUpdate = useRef(-Infinity)
  const labelPoint = useMemo(() => new THREE.Vector3(), [])

  useFrame(({ clock }) => {
    const runtime = graphEngine.runtime
    if (clock.elapsedTime - lastLabelUpdate.current < 0.2) return
    lastLabelUpdate.current = clock.elapsedTime
    const scored: Array<{ id: string; d: number }> = []
    for (const node of nodes) {
      if (visibleNoteIds() && !visibleNoteIds()!.has(node.id)) continue
      const p = runtime.positionOf(node.id)
      if (!p) continue
      labelPoint.set(p[0], p[1], p[2])
      const d = camera.position.distanceTo(labelPoint)
      const important = node.id === selectedId || node.id === hoveredId || node.id === aimedId || node.id === connectionTargetId || node.id === linkSourceId
      if (important || d < 30) scored.push({ id: node.id, d: important ? -1000 : d })
    }
    scored.sort((a, b) => a.d - b.d)
    const next = scored.slice(0, 110).map((x) => x.id)
    setVisibleIds((prev) => prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next)
  })

  const map = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  return (
    <>
      {visibleIds.map((id) => {
        const node = map.get(id)
        if (!node || (visibleNoteIds() && !visibleNoteIds()!.has(node.id))) return null
        const hot = id === selectedId || id === hoveredId || id === aimedId || id === connectionTargetId || id === linkSourceId
        const showSummary = id === hoveredId || id === aimedId || id === connectionTargetId || id === linkSourceId
        return (
          <RuntimeNodeLabel
            key={id}
            id={id}
            title={node.title}
            summary={node.summary ?? ''}
            hot={hot}
            showSummary={showSummary}
            showPlus={cursorMode && id === hoveredId && !linkSourceId}
            connectionTarget={id === connectionTargetId}
            linkSource={id === linkSourceId}
          />
        )
      })}
    </>
  )
}


function nodeAtScreenPointFallback(camera: THREE.Camera, canvas: HTMLCanvasElement, clientX: number, clientY: number, maxPixels = 28) {
  const bounds = canvas.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  const runtime = graphEngine.runtime
  const projected = new THREE.Vector3()
  let bestId: string | null = null
  let bestScore = maxPixels
  for (let i = 0; i < runtime.ids.length; i += 1) {
    if (visibleNoteIds() && !visibleNoteIds()!.has(runtime.ids[i])) continue
    const o = i * 3
    projected.set(runtime.positions[o], runtime.positions[o + 1], runtime.positions[o + 2]).project(camera)
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.08 || Math.abs(projected.y) > 1.08) continue
    const sx = bounds.left + (projected.x * 0.5 + 0.5) * bounds.width
    const sy = bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height
    const pixels = Math.hypot(sx - clientX, sy - clientY)
    if (pixels < bestScore) {
      bestScore = pixels
      bestId = runtime.ids[i]
    }
  }
  return bestId
}

function edgeAtScreenPoint(edges: Edge[], camera: THREE.Camera, canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const bounds = canvas.getBoundingClientRect(), runtime = graphEngine.runtime, visible = visibleNoteIds()
  let bestId: string | null = null, best = 9
  for (const edge of edges) {
    if (visible && (!visible.has(edge.source) || !visible.has(edge.target))) continue
    const a = runtime.positionOf(edge.source), b = runtime.positionOf(edge.target); if (!a || !b) continue
    const mid = edgeMidpoint(edge.id, a, b), worldMid = new THREE.Vector3(...mid), projectedMid = worldMid.clone().project(camera)
    const selected = useGraphStore.getState()
    if (projectedMid.z < -1 || projectedMid.z > 1 || Math.abs(projectedMid.x) > 1.25 || Math.abs(projectedMid.y) > 1.25
      || (camera.position.distanceTo(worldMid) > 95 && edge.id !== selected.selectedEdgeId && edge.source !== selected.selectedId && edge.target !== selected.selectedId)) continue
    const points = [a, mid, b].map(point => new THREE.Vector3(...point).project(camera))
    if (points.some(point => point.z < -1 || point.z > 1)) continue
    for (let segment = 0; segment < 2; segment++) {
      const start = points[segment], end = points[segment + 1]
      const ax = bounds.left + (start.x * 0.5 + 0.5) * bounds.width, ay = bounds.top + (-start.y * 0.5 + 0.5) * bounds.height
      const bx = bounds.left + (end.x * 0.5 + 0.5) * bounds.width, by = bounds.top + (-end.y * 0.5 + 0.5) * bounds.height
      const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy
      if (len2 < 1) continue
      const t = THREE.MathUtils.clamp(((clientX - ax) * vx + (clientY - ay) * vy) / len2, 0, 1)
      if ((segment === 0 && t < 0.26) || (segment === 1 && t > 0.74)) continue
      const distance = Math.hypot(clientX - ax - vx * t, clientY - ay - vy * t)
      if (distance < best) { best = distance; bestId = edge.id }
    }
  }
  return bestId
}

function GraphInteractionController({
  cursorMode,
  pointerLocked,
  linkToolActive,
  onLinkToolDone,
  onInteractionChange,
  onHover,
  onAim,
  onConnectionTarget,
  onLinkSource,
  onCreatedNode,
  hitMeshRef,
}: {
  cursorMode: boolean
  pointerLocked: boolean
  linkToolActive: boolean
  onLinkToolDone: () => void
  onInteractionChange: (active: boolean) => void
  onHover: (id: string | null) => void
  onAim: (id: string | null) => void
  onConnectionTarget: (id: string | null) => void
  onLinkSource: (id: string | null) => void
  onCreatedNode: (id: string) => void
  hitMeshRef: RefObject<THREE.InstancedMesh | null>
}) {
  const { camera, gl, invalidate } = useThree()
  const setSelected = useGraphStore((s) => s.setSelected)
  const setSelectedEdge = useGraphStore((s) => s.setSelectedEdge)
  const connectNodes = useGraphStore((s) => s.connectNodes)
  const addLinkedNode = useGraphStore((s) => s.addLinkedNode)
  const hoveredRef = useRef<string | null>(null)
  const toolSourceRef = useRef<string | null>(null)
  const dragRef = useRef<null | {
    id: string
    pointerId: number
    startX: number
    startY: number
    started: boolean
    plane: THREE.Plane
    offset: THREE.Vector3
  }>(null)
  const draftRef = useRef<null | { sourceId: string; pointerId: number; startX: number; startY: number; point: Vec3; targetId: string | null }>(null)
  const [draftVisual, setDraftVisual] = useState<null | { source: Vec3; point: Vec3; targetId: string | null }>(null)
  const hoverTimer = useRef<number | null>(null)
  const hoverClearTimer = useRef<number | null>(null)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const ndc = useMemo(() => new THREE.Vector2(), [])
  const hit = useMemo(() => new THREE.Vector3(), [])
  const normal = useMemo(() => new THREE.Vector3(), [])

  const worldOnPlane = useCallback((clientX: number, clientY: number, plane: THREE.Plane) => {
    const bounds = gl.domElement.getBoundingClientRect()
    ndc.set(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    return raycaster.ray.intersectPlane(plane, hit) ? hit.clone() : null
  }, [camera, gl, hit, ndc, raycaster])

  const screenAnchors = useCallback((id: string) => nodeScreenAnchors(id, camera, gl.domElement), [camera, gl])

  const plusHit = useCallback((id: string, clientX: number, clientY: number) => {
    const a = screenAnchors(id)
    return Boolean(a && Math.hypot(a.plusX - clientX, a.plusY - clientY) <= 14)
  }, [screenAnchors])

  const hoverBridgeHit = useCallback((id: string, clientX: number, clientY: number) => {
    const a = screenAnchors(id)
    if (!a) return false
    if (Math.hypot(a.nodeX - clientX, a.nodeY - clientY) <= 38) return true
    if (Math.hypot(a.plusX - clientX, a.plusY - clientY) <= 20) return true
    const vx = a.plusX - a.nodeX, vy = a.plusY - a.nodeY
    const len2 = vx * vx + vy * vy
    if (len2 < 1) return false
    const t = THREE.MathUtils.clamp(((clientX - a.nodeX) * vx + (clientY - a.nodeY) * vy) / len2, 0, 1)
    const px = a.nodeX + vx * t, py = a.nodeY + vy * t
    return Math.hypot(clientX - px, clientY - py) <= 23
  }, [screenAnchors])

  const pickNode = useCallback((clientX: number, clientY: number) => {
    const bounds = gl.domElement.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return null
    ndc.set(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    const hitMesh = hitMeshRef.current
    if (hitMesh) {
      hitMesh.updateMatrixWorld(true)
      const intersections = raycaster.intersectObject(hitMesh, false)
      const visible = visibleNoteIds()
      const instanceId = intersections.find(hit => hit.instanceId !== undefined && (!visible || visible.has(graphEngine.runtime.ids[hit.instanceId])))?.instanceId
      if (instanceId !== undefined && instanceId !== null) {
        const id = graphEngine.runtime.ids[instanceId]
        if (id) return id
      }
    }
    // Screen-space fallback keeps distant/small nodes easy to select even when the
    // physical hit sphere projects to only a few pixels.
    return nodeAtScreenPointFallback(camera, gl.domElement, clientX, clientY, 34)
  }, [camera, gl, hitMeshRef, ndc, raycaster])


  useEffect(() => {
    const canvas = gl.domElement
    const isOnCanvas = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom
        && (event.target === canvas || canvas.hasPointerCapture(event.pointerId))
    }
    const updateHover = (event: PointerEvent) => {
      if (!cursorMode || dragRef.current || draftRef.current) return

      if (!isOnCanvas(event)) {
        hoveredRef.current = null; onHover(null); return
      }

      // The complete node -> connector corridor is one interaction region. This
      // makes it impossible for the '+' to disappear while the cursor is moving
      // toward it, even if the actual visible sphere is tiny on screen.
      if (hoveredRef.current && hoverBridgeHit(hoveredRef.current, event.clientX, event.clientY)) {
        if (hoverClearTimer.current !== null) {
          window.clearTimeout(hoverClearTimer.current)
          hoverClearTimer.current = null
        }
        canvas.style.cursor = plusHit(hoveredRef.current, event.clientX, event.clientY) ? 'crosshair' : (linkToolActive ? 'crosshair' : 'grab')
        return
      }

      if (hoverTimer.current !== null) return
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null
        const id = pickNode(event.clientX, event.clientY)
        if (id) {
          if (hoverClearTimer.current !== null) {
            window.clearTimeout(hoverClearTimer.current)
            hoverClearTimer.current = null
          }
          if (id !== hoveredRef.current) {
            hoveredRef.current = id
            onHover(id)
            invalidate()
          }
          canvas.style.cursor = linkToolActive ? 'crosshair' : 'grab'
          return
        }

        if (!hoveredRef.current || hoverClearTimer.current !== null) return
        hoverClearTimer.current = window.setTimeout(() => {
          hoverClearTimer.current = null
          hoveredRef.current = null
          onHover(null)
          canvas.style.cursor = 'default'
          invalidate()
        }, 150)
      }, 16)
    }

    const resolveDraftPoint = (event: PointerEvent, sourceId: string) => {
      const targetId = pickNode(event.clientX, event.clientY)
      if (targetId && targetId !== sourceId) {
        const p = graphEngine.runtime.positionOf(targetId)
        return p ? { targetId, point: [...p] as Vec3 } : null
      }
      const source = graphEngine.runtime.positionOf(sourceId)
      if (!source) return null
      camera.getWorldDirection(normal)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(...source))
      const point = worldOnPlane(event.clientX, event.clientY, plane)
      return point ? { targetId: null, point: [point.x, point.y, point.z] as Vec3 } : null
    }

    const pointerDown = (event: PointerEvent) => {
      if (document.querySelector('dialog[open]') || !cursorMode || event.button !== 0 || dragRef.current || draftRef.current) return

      // The connector is deliberately outside the node sphere, so test it
      // before node picking. This makes the '+' reachable without requiring
      // an invisible mesh or keeping thousands of hitboxes alive.
      const connectorSource = hoveredRef.current
      if (!linkToolActive && connectorSource && plusHit(connectorSource, event.clientX, event.clientY)) {
        event.stopImmediatePropagation()
        const source = graphEngine.runtime.positionOf(connectorSource)
        if (!source) return
        draftRef.current = { sourceId: connectorSource, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, point: [...source], targetId: null }
        canvas.setPointerCapture(event.pointerId)
        setDraftVisual({ source: [...source], point: [...source], targetId: null })
        onInteractionChange(true)
        canvas.style.cursor = 'crosshair'
        event.preventDefault()
        return
      }

      const id = pickNode(event.clientX, event.clientY)
      if (linkToolActive) {
        if (!id) return
        event.stopImmediatePropagation()
        event.preventDefault()
        if (!toolSourceRef.current) {
          toolSourceRef.current = id
          onLinkSource(id)
          setSelected(id)
          return
        }
        if (toolSourceRef.current === id) {
          toolSourceRef.current = null
          onLinkSource(null)
          return
        }
        connectNodes(toolSourceRef.current, id)
        toolSourceRef.current = null
        onLinkSource(null)
        onLinkToolDone()
        return
      }
      if (!id) {
        const edgeId = edgeAtScreenPoint(useGraphStore.getState().edges, camera, canvas, event.clientX, event.clientY)
        if (edgeId) setSelectedEdge(edgeId)
        else { setSelected(null); setSelectedEdge(null) }
        return
      }
      event.stopImmediatePropagation()
      const p = graphEngine.runtime.positionOf(id)
      if (!p) return
      camera.getWorldDirection(normal)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(...p))
      const world = worldOnPlane(event.clientX, event.clientY, plane)
      dragRef.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
        plane,
        offset: world ? new THREE.Vector3(...p).sub(world) : new THREE.Vector3(),
      }
      canvas.setPointerCapture(event.pointerId)
      onInteractionChange(true)
      event.preventDefault()
    }

    const pointerMove = (event: PointerEvent) => {
      updateHover(event)
      if (draftRef.current && event.pointerId !== draftRef.current.pointerId) return
      if (dragRef.current && event.pointerId !== dragRef.current.pointerId) return
      if (draftRef.current) {
        const result = resolveDraftPoint(event, draftRef.current.sourceId)
        if (!result) return
        draftRef.current.point = result.point
        draftRef.current.targetId = result.targetId
        onConnectionTarget(result.targetId)
        const source = graphEngine.runtime.positionOf(draftRef.current.sourceId)
        if (source) setDraftVisual({ source: [...source], point: result.point, targetId: result.targetId })
        invalidate()
        return
      }
      const drag = dragRef.current
      if (!drag) return
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      if (!drag.started && moved >= 6) {
        useGraphStore.getState().checkpoint()
        drag.started = true
        const world = worldOnPlane(event.clientX, event.clientY, drag.plane)
        if (world) {
          world.add(drag.offset)
          graphEngine.startDrag(drag.id, [world.x, world.y, world.z])
        }
        onInteractionChange(true)
        canvas.style.cursor = 'grabbing'
      }
      if (drag.started) {
        const world = worldOnPlane(event.clientX, event.clientY, drag.plane)
        if (world) {
          world.add(drag.offset)
          graphEngine.updateDrag([world.x, world.y, world.z])
        }
      }
    }

    const pointerUp = (event: PointerEvent) => {
      const activePointer = draftRef.current?.pointerId ?? dragRef.current?.pointerId
      if (activePointer === undefined || activePointer !== event.pointerId || event.button !== 0) return
      const bounds = canvas.getBoundingClientRect()
      if (draftRef.current && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) { cancel(); return }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (draftRef.current) {
        try {
          const sourceId = draftRef.current.sourceId
          if (!useGraphStore.getState().nodes.some(node => node.id === sourceId)) return
          const result = resolveDraftPoint(event, sourceId)
          const targetId = result?.targetId
          const moved = Math.hypot(event.clientX - draftRef.current.startX, event.clientY - draftRef.current.startY) >= 6
          if (targetId) connectNodes(sourceId, targetId)
          else {
            const id = addLinkedNode(sourceId, moved ? result?.point : undefined)
            if (id) onCreatedNode(id)
          }
        } finally {
          draftRef.current = null
          setDraftVisual(null)
          onConnectionTarget(null)
          onInteractionChange(false)
          canvas.style.cursor = hoveredRef.current ? 'grab' : 'default'
        }
        return
      }
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      if (drag.started) {
        graphEngine.endDrag()
        onInteractionChange(false)
      } else {
        setSelected(drag.id)
      }
      onInteractionChange(false)
      canvas.style.cursor = hoveredRef.current ? 'grab' : 'default'
    }

    const cancel = () => {
      const pointerId = dragRef.current?.pointerId ?? draftRef.current?.pointerId
      if (dragRef.current?.started) graphEngine.endDrag()
      dragRef.current = null
      draftRef.current = null
      if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
      setDraftVisual(null)
      onConnectionTarget(null)
      onInteractionChange(false)
      canvas.style.cursor = 'default'
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    const unsubscribeGraph = useGraphStore.subscribe((state, previous) => {
      if (state.graphEpoch !== previous.graphEpoch
        || (draftRef.current && !state.nodes.some(n => n.id === draftRef.current?.sourceId))
        || (dragRef.current && !state.nodes.some(n => n.id === dragRef.current?.id))) cancel()
      if (hoveredRef.current && !state.nodes.some(n => n.id === hoveredRef.current)) { hoveredRef.current = null; onHover(null) }
      if (toolSourceRef.current && !state.nodes.some(n => n.id === toolSourceRef.current)) { toolSourceRef.current = null; onLinkSource(null) }
    })
    window.addEventListener('blur', cancel)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape)
    canvas.addEventListener('pointerdown', pointerDown, { capture: true })
    window.addEventListener('pointermove', pointerMove, { passive: true, capture: true })
    window.addEventListener('pointerup', pointerUp, { capture: true })
    return () => {
      unsubscribeGraph()
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape)
      canvas.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('pointermove', pointerMove, true)
      window.removeEventListener('pointerup', pointerUp, true)
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
      if (hoverClearTimer.current !== null) window.clearTimeout(hoverClearTimer.current)
      hoverTimer.current = null
      hoverClearTimer.current = null
    }
  }, [addLinkedNode, camera, connectNodes, cursorMode, gl, invalidate, linkToolActive, onConnectionTarget, onCreatedNode, onHover, onInteractionChange, onLinkSource, onLinkToolDone, hoverBridgeHit, pickNode, plusHit, setSelected, setSelectedEdge, worldOnPlane, normal])

  useEffect(() => () => { if (dragRef.current?.started) graphEngine.endDrag() }, [])

  useEffect(() => {
    if (linkToolActive) return
    toolSourceRef.current = null
    onLinkSource(null)
  }, [linkToolActive, onLinkSource])

  useEffect(() => {
    if (cursorMode || !pointerLocked) {
      onAim(null)
      return
    }
    const bounds = gl.domElement.getBoundingClientRect()
    const timer = window.setInterval(() => {
      const id = pickNode(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      onAim(id)
      invalidate()
    }, 90)
    return () => window.clearInterval(timer)
  }, [cursorMode, gl, invalidate, onAim, pickNode, pointerLocked])

  useEffect(() => {
    if (cursorMode || !pointerLocked) return
    const click = (event: MouseEvent) => {
      if (event.button !== 0) return
      const bounds = gl.domElement.getBoundingClientRect()
      const id = pickNode(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      if (id) setSelected(id)
    }
    window.addEventListener('mousedown', click, { capture: true })
    return () => window.removeEventListener('mousedown', click, { capture: true })
  }, [cursorMode, gl, pickNode, pointerLocked, setSelected, setSelectedEdge])

  if (!draftVisual) return null
  return <DraftLinkVisual source={draftVisual.source} point={draftVisual.point} target={Boolean(draftVisual.targetId)} />
}

function DraftLinkVisual({ source, point, target }: { source: Vec3; point: Vec3; target: boolean }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
    return g
  }, [])
  const material = useMemo(() => new THREE.LineBasicMaterial({ color: target ? '#fff9bf' : '#fff0a2', transparent: true, opacity: 0.92, depthWrite: false }), [target])
  useFrame(() => {
    const a = geometry.getAttribute('position') as THREE.BufferAttribute
    a.setXYZ(0, source[0], source[1], source[2])
    a.setXYZ(1, point[0], point[1], point[2])
    a.needsUpdate = true
  })
  useEffect(() => () => { geometry.dispose(); material.dispose() }, [geometry, material])
  return <lineSegments geometry={geometry} material={material} frustumCulled={false} />
}

export function OptimizedGraphLayer({
  disabled,
  reducedMotion,
  cursorMode,
  pointerLocked,
  linkToolActive,
  onLinkToolDone,
  onInteractionChange,
  onCreatedNode,
}: {
  disabled: boolean
  reducedMotion: boolean
  cursorMode: boolean
  pointerLocked: boolean
  linkToolActive: boolean
  onLinkToolDone: () => void
  onInteractionChange: (active: boolean) => void
  onCreatedNode: (id: string) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [aimedId, setAimedId] = useState<string | null>(null)
  const [connectionTargetId, setConnectionTargetId] = useState<string | null>(null)
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null)
  const hitMeshRef = useRef<THREE.InstancedMesh>(null)
  const pulseCount = useRef(0)

  return (
    <>
      <GraphEngineBridge />
      <RuntimeInvalidator />
      <DemandFrameScheduler flightActive={!cursorMode && !disabled} reducedMotion={reducedMotion} pulseCount={pulseCount} />
      <BatchedEdgeLayer reducedMotion={reducedMotion} pulseCount={pulseCount} />
      <BatchedNodeLayer hoveredId={hoveredId} aimedId={aimedId} connectionTargetId={connectionTargetId} linkSourceId={linkSourceId} hitMeshRef={hitMeshRef} />
      <Suspense fallback={null}><NodeLabels hoveredId={hoveredId} aimedId={aimedId} connectionTargetId={connectionTargetId} linkSourceId={linkSourceId} cursorMode={cursorMode} /></Suspense>
      <GraphInteractionController
        cursorMode={cursorMode}
        pointerLocked={pointerLocked}
        linkToolActive={linkToolActive}
        onLinkToolDone={onLinkToolDone}
        onInteractionChange={onInteractionChange}
        onHover={setHoveredId}
        onAim={setAimedId}
        onConnectionTarget={setConnectionTargetId}
        onLinkSource={setLinkSourceId}
        onCreatedNode={onCreatedNode}
        hitMeshRef={hitMeshRef}
      />
    </>
  )
}
