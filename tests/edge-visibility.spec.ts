import { test, expect } from '@playwright/test'
import { seed, fixture } from './helpers'

test('a visible part of a link remains rendered and selectable when its middle leaves the screen', async ({ page }) => {
  await seed(page, {
    ...fixture,
    nodes: [
      { ...fixture.nodes[0], position: [1, -3, 0] },
      { ...fixture.nodes[1], position: [1, -25, 0] },
    ],
    edges: [{ id: 'partial-link', source: 'alpha', target: 'beta' }],
  } as typeof fixture)
  const visibleEdges = () => page.evaluate(async () => (await import('/src/components/OptimizedGraphLayer.tsx')).graphDiagnostics.visibleEdges)
  await expect.poll(visibleEdges).toBe(1)
  // Click the visible line below Alpha; its midpoint and Beta are below the canvas.
  const point = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const { edgeMidpoint, edgePoint } = await import('/src/engine/edgeGeometry.ts')
    const { graphEngine } = await import('/src/engine/graphEngine.ts')
    const bounds = document.querySelector('canvas')!.getBoundingClientRect()
    const camera = new THREE.PerspectiveCamera(55, bounds.width / bounds.height, 0.005, 500)
    camera.position.set(0, 0, 10); camera.updateMatrixWorld()
    const a = graphEngine.runtime.positionOf('alpha')!, b = graphEngine.runtime.positionOf('beta')!
    const position = new THREE.Vector3(...edgePoint(a, edgeMidpoint('partial-link', a, b), b, 0.05)).project(camera)
    return { x: bounds.left + (position.x + 1) * bounds.width / 2, y: bounds.top + (1 - position.y) * bounds.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByRole('button', { name: 'Delete link', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/partial-link-visible.png' })
  // Zooming in and out must not drop a link which still intersects the view.
  await page.mouse.move(450, 350)
  await page.mouse.wheel(0, -100)
  await expect.poll(visibleEdges).toBe(1)
  await page.mouse.wheel(0, 100)
  await expect.poll(visibleEdges).toBe(1)
})

test('long links keep their near portion even when the midpoint is over 95 units away', async ({ page }) => {
  await seed(page, {
    ...fixture,
    nodes: [
      { ...fixture.nodes[0], position: [0, -3, 0] },
      { ...fixture.nodes[1], position: [0, -3, -220] },
    ],
    edges: [{ id: 'long-link', source: 'alpha', target: 'beta' }],
  } as typeof fixture)
  await page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().setSelected(null))
  await expect.poll(() => page.evaluate(async () => (await import('/src/components/OptimizedGraphLayer.tsx')).graphDiagnostics.visibleEdges)).toBe(1)
})
