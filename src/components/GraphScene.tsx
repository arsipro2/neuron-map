import { OrbitControls, Stars } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { CameraSnapshot } from '../types'
import { graphEngine } from '../engine/graphEngine'
import { setCameraSnapshot } from '../services/persistence'
import { useGraphStore } from '../store/useGraphStore'
import { OptimizedGraphLayer } from './OptimizedGraphLayer'
import { CameraNavigator } from './CameraNavigator'

function FlightMouseLook({ active }: { active: boolean }) {
  const camera = useThree((s) => s.camera)
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'))

  useEffect(() => {
    if (!active) return
    euler.current.setFromQuaternion(camera.quaternion, 'YXZ')
    const onMove = (event: MouseEvent) => {
      if (document.pointerLockElement === null || document.querySelector('dialog[open]')) return
      euler.current.y -= event.movementX * 0.00215
      euler.current.x -= event.movementY * 0.00215
      euler.current.x = Math.max(-Math.PI / 2 + 0.03, Math.min(Math.PI / 2 - 0.03, euler.current.x))
      camera.quaternion.setFromEuler(euler.current)
      camera.updateMatrixWorld()
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [active, camera])

  return null
}

type CameraHandoff = {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  orbitTarget: THREE.Vector3
}

function snapshotFromHandoff(handoff: CameraHandoff): CameraSnapshot {
  return {
    position: [handoff.position.x, handoff.position.y, handoff.position.z],
    quaternion: [handoff.quaternion.x, handoff.quaternion.y, handoff.quaternion.z, handoff.quaternion.w],
    orbitTarget: [handoff.orbitTarget.x, handoff.orbitTarget.y, handoff.orbitTarget.z],
  }
}

function CameraBootstrap({ initial, handoff }: { initial: CameraSnapshot; handoff: MutableRefObject<CameraHandoff> }) {
  const camera = useThree((s) => s.camera)
  const applied = useRef(false)
  useLayoutEffect(() => {
    if (applied.current) return
    applied.current = true
    camera.position.set(...initial.position)
    camera.quaternion.set(...initial.quaternion)
    camera.updateMatrixWorld(true)
    handoff.current.position.copy(camera.position)
    handoff.current.quaternion.copy(camera.quaternion)
    handoff.current.orbitTarget.set(...initial.orbitTarget)
  }, [camera, handoff, initial])
  return null
}

function CameraPersistence({ cursorMode, handoff }: { cursorMode: boolean; handoff: MutableRefObject<CameraHandoff> }) {
  const camera = useThree((s) => s.camera)
  const accumulator = useRef(0)
  const forward = useRef(new THREE.Vector3())

  useFrame((_, dt) => {
    if (!cursorMode) {
      handoff.current.position.copy(camera.position)
      handoff.current.quaternion.copy(camera.quaternion)
      camera.getWorldDirection(forward.current).normalize()
      handoff.current.orbitTarget.copy(camera.position).addScaledVector(forward.current, 8)
    }
    accumulator.current += dt
    if (accumulator.current >= 0.28) {
      accumulator.current = 0
      setCameraSnapshot(snapshotFromHandoff(handoff.current))
    }
  })
  return null
}

function CursorZoomToPointer({ cursorMode, interacting, controlsRef, handoff }: { cursorMode: boolean; interacting: boolean; controlsRef: MutableRefObject<any>; handoff: MutableRefObject<CameraHandoff> }) {
  const { camera, gl } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const ndc = useMemo(() => new THREE.Vector2(), [])
  const projected = useMemo(() => new THREE.Vector3(), [])
  const toNode = useMemo(() => new THREE.Vector3(), [])
  const anchor = useMemo(() => new THREE.Vector3(), [])
  const nextPosition = useMemo(() => new THREE.Vector3(), [])
  const deltaPosition = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    if (!cursorMode || interacting) return
    const canvas = gl.domElement

    const onWheel = (event: WheelEvent) => {
      if (!cursorMode || interacting) return
      const controls = controlsRef.current
      if (!controls) return

      event.preventDefault()
      event.stopPropagation()

      const bounds = canvas.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return

      ndc.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)

      // Prefer the depth of the node nearest to the cursor. This makes wheel zoom
      // feel like CorelDRAW: the visible object under the mouse becomes the zoom
      // anchor instead of OrbitControls' usually distant center target.
      let bestPixels = 110
      let anchorDepth = Infinity
      const nodes = useGraphStore.getState().nodes
      for (const node of nodes) {
        const position = graphEngine.runtime.positionOf(node.id) ?? node.position
        projected.set(...position).project(camera)
        if (projected.z < -1 || projected.z > 1) continue
        const sx = bounds.left + (projected.x * 0.5 + 0.5) * bounds.width
        const sy = bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height
        const pixels = Math.hypot(sx - event.clientX, sy - event.clientY)
        if (pixels >= bestPixels) continue

        toNode.set(
          position[0] - camera.position.x,
          position[1] - camera.position.y,
          position[2] - camera.position.z,
        )
        const depth = toNode.dot(raycaster.ray.direction)
        if (depth <= 0.01) continue
        bestPixels = pixels
        anchorDepth = depth
      }

      if (!Number.isFinite(anchorDepth)) {
        // No node under the mouse: use the current orbit plane as the depth
        // reference, while still moving along the actual cursor ray.
        toNode.copy(controls.target).sub(camera.position)
        anchorDepth = toNode.dot(raycaster.ray.direction)
        if (!Number.isFinite(anchorDepth) || anchorDepth <= 0.01) {
          anchorDepth = Math.max(0.5, camera.position.distanceTo(controls.target))
        }
      }

      anchor.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, anchorDepth)

      let wheel = event.deltaY
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) wheel *= 16
      else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) wheel *= Math.max(320, bounds.height)

      // Exponential scaling behaves well for both mouse wheels and touchpads.
      // There is deliberately no practical zoom-in floor: repeated wheel-up
      // events approach the cursor anchor arbitrarily closely.
      const exponent = THREE.MathUtils.clamp(wheel * 0.0022, -0.42, 0.42)
      const scale = Math.exp(exponent)

      nextPosition.copy(anchor).add(camera.position.clone().sub(anchor).multiplyScalar(scale))

      // Keep a tiny safety distance only to avoid floating-point singularities
      // and near-plane clipping. At 0.004 world units this is visually "touching".
      const remaining = nextPosition.distanceTo(anchor)
      if (scale < 1 && remaining < 0.004) {
        nextPosition.copy(anchor).addScaledVector(raycaster.ray.direction, -0.004)
      }

      deltaPosition.copy(nextPosition).sub(camera.position)
      camera.position.copy(nextPosition)
      // Move the orbit target by the exact same world-space translation. This
      // preserves the current viewing direction, so the point under the cursor
      // stays under the cursor instead of snapping toward screen center.
      controls.target.add(deltaPosition)
      camera.updateMatrixWorld(true)
      controls.update()

      handoff.current.position.copy(camera.position)
      handoff.current.quaternion.copy(camera.quaternion)
      handoff.current.orbitTarget.copy(controls.target)
      setCameraSnapshot(snapshotFromHandoff(handoff.current))
    }

    canvas.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => canvas.removeEventListener('wheel', onWheel, true)
  }, [anchor, camera, controlsRef, cursorMode, deltaPosition, gl, handoff, interacting, ndc, nextPosition, projected, raycaster, toNode])

  return null
}

function CursorOrbitControls({ cursorMode, interacting, handoff, controlsRef }: { cursorMode: boolean; interacting: boolean; handoff: MutableRefObject<CameraHandoff>; controlsRef: MutableRefObject<any> }) {
  const camera = useThree((s) => s.camera)
  const previousCursorMode = useRef(cursorMode)
  const forward = useRef(new THREE.Vector3())
  const bootstrapped = useRef(false)

  // OrbitControls stays mounted for the whole lifetime of the scene.  Re-mounting
  // it when leaving flight mode was the source of the camera snap: a newly
  // created controls instance briefly used its default target (the graph origin)
  // and rotated the existing camera toward it.
  //
  // The camera quaternion is now the source of truth.  Whenever cursor mode
  // becomes active, derive a fresh orbit target straight ahead of the ACTUAL
  // current camera.  We never restore an old target and never re-apply an old
  // camera position/quaternion here.
  useLayoutEffect(() => {
    const controls = controlsRef.current
    if (!controls) return

    const enteringCursor = cursorMode && !previousCursorMode.current
    const firstMount = !bootstrapped.current

    if (firstMount || enteringCursor) {
      bootstrapped.current = true
      camera.getWorldDirection(forward.current).normalize()

      // Preserve a comfortable orbit radius when possible, but never allow a
      // stale target to determine the LOOK DIRECTION.
      const oldDistance = camera.position.distanceTo(handoff.current.orbitTarget)
      const orbitDistance = Number.isFinite(oldDistance) && oldDistance > 1.5 && oldDistance < 40
        ? oldDistance
        : 8

      controls.target.copy(camera.position).addScaledVector(forward.current, orbitDistance)
      controls.update()

      handoff.current.position.copy(camera.position)
      handoff.current.quaternion.copy(camera.quaternion)
      handoff.current.orbitTarget.copy(controls.target)
      setCameraSnapshot(snapshotFromHandoff(handoff.current))
    }

    previousCursorMode.current = cursorMode
  }, [camera, cursorMode, handoff])

  const sync = useCallback(() => {
    const controls = controlsRef.current
    if (!controls || !cursorMode) return
    handoff.current.position.copy(camera.position)
    handoff.current.quaternion.copy(camera.quaternion)
    handoff.current.orbitTarget.copy(controls.target)
    setCameraSnapshot(snapshotFromHandoff(handoff.current))
  }, [camera, cursorMode, handoff])

  return (
    <OrbitControls
      ref={controlsRef}
      enabled={cursorMode && !interacting}
      enableDamping
      dampingFactor={0.075}
      enablePan
      enableZoom={false}
      screenSpacePanning
      rotateSpeed={0.62}
      panSpeed={0.82}
      zoomSpeed={0.9}
      minDistance={0.0001}
      maxDistance={400}
      onChange={sync}
      mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
    />
  )
}

function FocusNodeController({ request, cursorMode, controlsRef }: { request: { id: string; token: number } | null; cursorMode: boolean; controlsRef: MutableRefObject<any> }) {
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  const animation = useRef<null | {
    elapsed: number
    startPosition: THREE.Vector3
    startTarget: THREE.Vector3
    endPosition: THREE.Vector3
    endTarget: THREE.Vector3
  }>(null)
  const handledToken = useRef<number | null>(null)

  useEffect(() => {
    if (!request || !cursorMode || handledToken.current === request.token) return
    const controls = controlsRef.current
    if (!controls) return
    const runtimePosition = graphEngine.runtime.positionOf(request.id)
    const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === request.id)
    const position = runtimePosition ?? node?.position ?? null
    if (!position) return
    handledToken.current = request.token
    const endTarget = new THREE.Vector3(...position)
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward).normalize()
    const currentDistance = Math.max(3.6, Math.min(8.5, camera.position.distanceTo(controls.target)))
    const endPosition = endTarget.clone().addScaledVector(forward, -currentDistance)
    invalidate()
    animation.current = {
      elapsed: 0,
      startPosition: camera.position.clone(),
      startTarget: controls.target.clone(),
      endPosition,
      endTarget,
    }
  }, [camera, controlsRef, cursorMode, invalidate, request])

  useFrame((_, dt) => {
    const anim = animation.current
    const controls = controlsRef.current
    if (!anim || !controls || !cursorMode) return
    anim.elapsed += Math.min(dt, 0.05)
    const raw = Math.min(1, anim.elapsed / 0.48)
    const t = raw * raw * (3 - 2 * raw)
    camera.position.lerpVectors(anim.startPosition, anim.endPosition, t)
    controls.target.lerpVectors(anim.startTarget, anim.endTarget, t)
    controls.update()
    if (raw >= 1) animation.current = null
    else invalidate()
  })
  return null
}

type SceneProps = {
  reducedMotion: boolean
  disabled: boolean
  initialCamera: CameraSnapshot
  cursorMode: boolean
  pointerLocked: boolean
  linkToolActive: boolean
  onLinkToolDone: () => void
  focusRequest: { id: string; token: number } | null
}

function SceneContents({ reducedMotion, disabled, initialCamera, cursorMode, pointerLocked, linkToolActive, onLinkToolDone, focusRequest }: SceneProps) {
  // IDs remain stable while the physics engine changes positions. This prevents
  // the whole scene tree from re-rendering on every animation frame.
  const nodeCount = useGraphStore((s) => s.nodes.length)
  const edgeCount = useGraphStore((s) => s.edges.length)
  const [draggingNode, setDraggingNode] = useState(false)
  const [createdFocusRequest, setCreatedFocusRequest] = useState<{ id: string; token: number } | null>(null)
  const interacting = draggingNode || disabled
  const handoff = useRef<CameraHandoff>({
    position: new THREE.Vector3(...initialCamera.position),
    quaternion: new THREE.Quaternion(...initialCamera.quaternion),
    orbitTarget: new THREE.Vector3(...initialCamera.orbitTarget),
  })
  const orbitControlsRef = useRef<any>(null)

  return (
    <>
      <ambientLight intensity={0.18} />
      <pointLight position={[3, 4, 8]} intensity={5.2} distance={30} color="#ffd86b" />
      <pointLight position={[-8, -3, -6]} intensity={3.8} distance={26} color="#a67cff" />
      {nodeCount + edgeCount < 1400 ? <Stars radius={85} depth={45} count={240} factor={0.68} saturation={0} fade speed={0.05} /> : null}
      <CameraBootstrap initial={initialCamera} handoff={handoff} />
      <CameraPersistence cursorMode={cursorMode} handoff={handoff} />

      <OptimizedGraphLayer
        disabled={disabled}
        reducedMotion={reducedMotion}
        cursorMode={cursorMode && !disabled}
        pointerLocked={pointerLocked}
        linkToolActive={linkToolActive}
        onLinkToolDone={onLinkToolDone}
        onInteractionChange={setDraggingNode}
        onCreatedNode={(id) => setCreatedFocusRequest({ id, token: Date.now() + Math.random() })}
      />
      <FocusNodeController request={createdFocusRequest && (!focusRequest || createdFocusRequest.token > focusRequest.token) ? createdFocusRequest : focusRequest} cursorMode={cursorMode} controlsRef={orbitControlsRef} />
      <CameraNavigator disabled={interacting} cursorMode={cursorMode} />
      <FlightMouseLook active={!disabled && !cursorMode && pointerLocked} />
      <CursorZoomToPointer cursorMode={cursorMode} interacting={interacting} controlsRef={orbitControlsRef} handoff={handoff} />

      <CursorOrbitControls cursorMode={cursorMode} interacting={interacting} handoff={handoff} controlsRef={orbitControlsRef} />

    </>
  )
}

export function GraphScene({ reducedMotion = false, disabled = false, initialCamera, linkToolActive = false, onLinkToolChange, focusRequest = null }: { reducedMotion?: boolean; disabled?: boolean; initialCamera: CameraSnapshot; linkToolActive?: boolean; onLinkToolChange?: (active: boolean) => void; focusRequest?: { id: string; token: number } | null }) {
  const canvasElement = useRef<HTMLCanvasElement | null>(null)
  const nodeCount = useGraphStore((s) => s.nodes.length)
  const edgeCount = useGraphStore((s) => s.edges.length)
  const complexity = nodeCount + edgeCount
  const adaptiveDpr: [number, number] = complexity > 1800 ? [0.82, 1.05] : complexity > 700 ? [0.92, 1.18] : [1, 1.35]
  const [mode, setMode] = useState<'cursor' | 'flight'>('cursor')
  const [pointerLocked, setPointerLocked] = useState(false)
  const modeRef = useRef<'cursor' | 'flight'>('cursor')
  const hadPointerLock = useRef(false)
  const cursorMode = mode === 'cursor'

  const setModeSafe = useCallback((next: 'cursor' | 'flight') => {
    modeRef.current = next
    setMode(next)
  }, [])

  const releasePointer = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock()
  }, [])

  const requestMouseLook = useCallback(() => {
    const canvas = canvasElement.current
    if (!canvas || document.pointerLockElement === canvas) return
    try {
      const result = canvas.requestPointerLock()
      // Newer browsers may return a promise; older ones return void.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        ;(result as Promise<void>).catch(() => {})
      }
    } catch {
      // Flight movement still works without pointer lock; clicking the scene retries.
    }
  }, [])

  const enterFlight = useCallback(() => {
    if (disabled || document.querySelector('dialog[open]')) return
    // The F key / mode button is an explicit user gesture, so mouse-look should
    // start immediately rather than leaving a useless free cursor over the scene.
    setModeSafe('flight')
    requestMouseLook()
  }, [requestMouseLook, setModeSafe, disabled])

  const enterCursor = useCallback(() => {
    setModeSafe('cursor')
    releasePointer()
  }, [releasePointer, setModeSafe])

  useEffect(() => { if (disabled) enterCursor() }, [disabled, enterCursor])

  useEffect(() => {
    const onLockChange = () => {
      const locked = document.pointerLockElement === canvasElement.current
      setPointerLocked(locked)

      // If the browser releases an established flight pointer lock (Esc, focus
      // loss, etc.), return to cursor mode. This avoids the old "dead cursor" state.
      if (!locked && hadPointerLock.current && modeRef.current === 'flight') {
        setModeSafe('cursor')
      }
      hadPointerLock.current = locked
    }
    document.addEventListener('pointerlockchange', onLockChange)
    return () => document.removeEventListener('pointerlockchange', onLockChange)
  }, [setModeSafe])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (disabled || document.querySelector('dialog[open]') || typing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return

      if (event.code === 'KeyF') {
        event.preventDefault()
        if (modeRef.current === 'cursor') enterFlight()
        else enterCursor()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enterCursor, enterFlight, disabled])

  return (
    <div
      className={`canvas-stack ${cursorMode ? 'cursor-mode' : 'flight-mode'} ${pointerLocked ? 'pointer-locked' : ''}`}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('button')) return

        const active = document.activeElement as HTMLElement | null
        if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.isContentEditable) active.blur()

        // If pointer lock was denied or lost while still in flight mode, a direct
        // click on the scene is another explicit gesture and safely retries it.
        if (modeRef.current === 'flight' && document.pointerLockElement !== canvasElement.current) {
          requestMouseLook()
        }
      }}
    >
      <Canvas
        frameloop="demand"
        camera={{ position: initialCamera.position, fov: 55, near: 0.005, far: 500 }}
        dpr={adaptiveDpr}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        onCreated={({ gl, raycaster }) => { canvasElement.current = gl.domElement; raycaster.params.Line.threshold = 0.075 }}
      >
        <color attach="background" args={['#010102']} />
        <fog attach="fog" args={['#010102', 28, 78]} />
        <SceneContents reducedMotion={reducedMotion} disabled={disabled} initialCamera={initialCamera} cursorMode={cursorMode} pointerLocked={pointerLocked} linkToolActive={linkToolActive} onLinkToolDone={() => onLinkToolChange?.(false)} focusRequest={focusRequest} />
      </Canvas>

      <div className="mode-cluster">
        <button
          type="button"
          className={`mode-pill mode-button ${cursorMode ? 'cursor' : 'flight'}`}
          onClick={() => (cursorMode ? enterFlight() : enterCursor())}
        >
          {cursorMode ? 'CURSOR · F → flight' : pointerLocked ? 'FLIGHT · mouse look ON' : 'FLIGHT · click scene for mouse'}
        </button>
      </div>

      {!cursorMode && pointerLocked ? <div className="flight-reticle" aria-hidden="true">·</div> : null}
      {!cursorMode && !pointerLocked ? <div className="flight-hint">WASD still moves · click the scene to capture mouse · F returns to cursor</div> : null}
      <div className="scene-vignette" />
    </div>
  )
}
