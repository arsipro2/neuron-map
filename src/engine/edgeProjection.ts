import { Matrix4, Vector3, Vector4, type Camera } from 'three'
import type { Vec3 } from '../types'

type ProjectedSegment = { start: Vector3; end: Vector3; visible: boolean }
const segment = (): ProjectedSegment => ({ start: new Vector3(), end: new Vector3(), visible: false })

// Clip before perspective division: endpoints can be offscreen or behind the
// camera while part of their connecting segment still crosses the visible view.
function clipSegment(a: Vector4, b: Vector4, output: ProjectedSegment) {
  output.visible = false
  let from = 0, to = 1
  for (let plane = 0; plane < 6; plane++) {
    const axis = plane >> 1, sign = plane % 2 === 0 ? 1 : -1
    const start = a.w + sign * a.getComponent(axis), end = b.w + sign * b.getComponent(axis)
    if (start < 0 && end < 0) return
    if (start < 0 || end < 0) {
      const crossing = start / (start - end)
      if (start < 0) from = Math.max(from, crossing)
      else to = Math.min(to, crossing)
      if (from > to) return
    }
  }
  const fromW = a.w + (b.w - a.w) * from, toW = a.w + (b.w - a.w) * to
  if (fromW <= 0 || toW <= 0) return
  output.start.set((a.x + (b.x - a.x) * from) / fromW, (a.y + (b.y - a.y) * from) / fromW, (a.z + (b.z - a.z) * from) / fromW)
  output.end.set((a.x + (b.x - a.x) * to) / toW, (a.y + (b.y - a.y) * to) / toW, (a.z + (b.z - a.z) * to) / toW)
  output.visible = true
}

// Reuse vectors and the camera matrix for the whole batch. Rendering and picking
// share this calculation so every visible part of a link can also be selected.
export class EdgeProjection {
  private matrix = new Matrix4()
  private a = new Vector4()
  private mid = new Vector4()
  private b = new Vector4()
  readonly segments = [segment(), segment()]

  setCamera(camera: Camera) {
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    return this
  }

  project(a: Vec3, mid: Vec3, b: Vec3) {
    this.a.set(...a, 1).applyMatrix4(this.matrix)
    this.mid.set(...mid, 1).applyMatrix4(this.matrix)
    this.b.set(...b, 1).applyMatrix4(this.matrix)
    clipSegment(this.a, this.mid, this.segments[0])
    clipSegment(this.mid, this.b, this.segments[1])
    return this.segments[0].visible || this.segments[1].visible
  }
}
