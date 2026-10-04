import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PerspectiveCamera } from 'three'
import { EdgeProjection } from '../src/engine/edgeProjection'

function projection() {
  const camera = new PerspectiveCamera(90, 1, 0.1, 500)
  camera.updateMatrixWorld()
  return new EdgeProjection().setCamera(camera)
}

test('links intersecting the view remain visible with an offscreen midpoint or no visible endpoints', () => {
  const view = projection()
  assert.equal(view.project([0, -3, -5], [0, -14, -5], [0, -25, -5]), true)
  assert.equal(view.segments[0].visible, true)
  assert.equal(view.segments[1].visible, false)
  assert.ok(Math.abs(view.segments[0].end.y + 1) < 1e-10)
  assert.equal(view.project([-20, 0, -5], [10, 0, -5], [40, 0, -5]), true)
  assert.ok(Math.abs(view.segments[0].start.x + 1) < 1e-10)
  assert.ok(Math.abs(view.segments[0].end.x - 1) < 1e-10)
})

test('clipping handles links crossing the near plane, camera plane and far plane', () => {
  const view = projection()
  for (const lastZ of [-0.01, 0, 10, -2000]) {
    assert.equal(view.project([0, 0, -5], [0, 0, lastZ], [0, 0, lastZ]), true)
    for (const part of view.segments.filter(part => part.visible)) {
      for (const point of [part.start, part.end]) {
        assert.ok(point.toArray().every(value => Number.isFinite(value) && Math.abs(value) <= 1 + 1e-9))
      }
    }
  }
})

test('links entirely outside the view, behind the camera or beyond the far plane stay culled', () => {
  const view = projection()
  assert.equal(view.project([8, 0, -5], [9, 0, -5], [10, 0, -5]), false)
  assert.equal(view.project([0, 8, -5], [0, 9, -5], [0, 10, -5]), false)
  assert.equal(view.project([-1, 0, 5], [0, 0, 5], [1, 0, 5]), false)
  assert.equal(view.project([-1, 0, -501], [0, 0, -510], [1, 0, -520]), false)
  // A diagonal can miss the corner even when its bounding box overlaps the view.
  assert.equal(view.project([4, 8, -5], [6, 6, -5], [8, 4, -5]), false)
})

test('visibility follows camera movement and rotation without changing graph coordinates', () => {
  const camera = new PerspectiveCamera(90, 1, 0.1, 500), view = new EdgeProjection()
  camera.position.set(40, 0, 0); camera.lookAt(40, 0, -5); camera.updateMatrixWorld()
  view.setCamera(camera)
  assert.equal(view.project([-1, 0, -5], [0, 0, -5], [1, 0, -5]), false)
  camera.lookAt(0, 0, -5); camera.updateMatrixWorld(); view.setCamera(camera)
  assert.equal(view.project([-1, 0, -5], [0, 0, -5], [1, 0, -5]), true)
})
