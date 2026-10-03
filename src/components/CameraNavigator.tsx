import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'

type Props = {
  disabled?: boolean
  cursorMode: boolean
}

const FORWARD = new THREE.Vector3()
const RIGHT = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const MOVE = new THREE.Vector3()

export function CameraNavigator({ disabled = false, cursorMode }: Props) {
  const camera = useThree((state) => state.camera)
  const keys = useRef<Record<string, boolean>>({})

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (document.querySelector('dialog[open]') || cursorMode || disabled || event.metaKey || event.altKey || target?.closest('input, textarea, [contenteditable=true]')) return
      // event.code is physical-key based, so WASD works on Cyrillic and other layouts too.
      if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(event.code)) return
      keys.current[event.code] = true
      if (!cursorMode) event.preventDefault()
    }

    const up = (event: KeyboardEvent) => {
      keys.current[event.code] = false
    }

    const clear = () => { keys.current = {} }
    window.addEventListener('keydown', down, { capture: true })
    window.addEventListener('keyup', up, { capture: true })
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down, { capture: true })
      window.removeEventListener('keyup', up, { capture: true })
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [cursorMode, disabled])

  useFrame((_, dt) => {
    if (disabled || cursorMode || document.querySelector('dialog[open]')) { keys.current = {}; return }

    const forwardInput = Number(Boolean(keys.current.KeyW)) - Number(Boolean(keys.current.KeyS))
    const strafeInput = Number(Boolean(keys.current.KeyD)) - Number(Boolean(keys.current.KeyA))
    const verticalInput = Number(Boolean(keys.current.Space)) - Number(Boolean(keys.current.ControlLeft || keys.current.ControlRight))
    if (!forwardInput && !strafeInput && !verticalInput) return

    camera.getWorldDirection(FORWARD).normalize()
    RIGHT.setFromMatrixColumn(camera.matrixWorld, 0).normalize()

    MOVE.set(0, 0, 0)
      .addScaledVector(FORWARD, forwardInput)
      .addScaledVector(RIGHT, strafeInput)
      .addScaledVector(UP, verticalInput)

    if (MOVE.lengthSq() > 1) MOVE.normalize()
    const fast = keys.current.ShiftLeft || keys.current.ShiftRight
    const speed = (fast ? 13.5 : 5.8) * Math.min(dt, 0.05)
    camera.position.addScaledVector(MOVE, speed)
    camera.updateMatrixWorld()
  })

  return null
}
