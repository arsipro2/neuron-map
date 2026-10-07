import { test, expect } from '@playwright/test'
import { fixture, point } from './helpers'

test('auto layout separates branches, supports undo, and saves the arranged positions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const coordinates = [[0, 0, 0], [1, .25, 0], [1, -.25, 0], [2, .3, 0], [2, -.3, 0], [3, .35, 0], [3, -.35, 0]]
  const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']
  const nodes = coordinates.map((position, i) => ({ ...fixture.nodes[0], id: ids[i], title: i ? ids[i] : 'Alpha', content: `Content ${ids[i]}`, position }))
  const pairs = [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6]]
  const edges = pairs.map(([a, b], i) => ({ id: `e${i}`, source: ids[a], target: ids[b] }))
  const state = { ...fixture, nodes, edges, camera: { ...fixture.camera, position: [0, 0, 18] } }
  await page.addInitScript(state => {
    if (!localStorage.getItem('neuron-test-seeded')) {
      localStorage.setItem('neuron-test-seeded', '1')
      localStorage.setItem('neuron-map-workspace-web-default', JSON.stringify(state))
    }
  }, state)
  await page.goto('/')
  await expect(page.locator('.title-input')).toHaveValue('Alpha')
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  const snapshot = () => page.evaluate(async () => {
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    return useGraphStore.getState().nodes.map(node => node.position)
  })
  await expect.poll(snapshot).toEqual(coordinates)
  await page.screenshot({ path: 'test-results/auto-layout-before.png' })
  await page.getByRole('button', { name: '⚙', exact: true }).click()
  await page.getByRole('button', { name: 'Auto layout', exact: true }).click()
  await expect.poll(async () => {
    const positions = await snapshot()
    return Math.hypot(...positions[1].map((n, axis) => n - positions[0][axis]))
  }).toBeGreaterThan(3.6)
  const arranged = await snapshot()
  const distance = (a: number, b: number) => Math.hypot(...arranged[a].map((n, axis) => n - arranged[b][axis]))
  for (const [a, b] of pairs) expect(distance(a, b)).toBeLessThan(4.8)
  for (const a of [1, 3, 5]) for (const b of [2, 4, 6]) expect(distance(a, b)).toBeGreaterThan(4.2)
  await expect(page.locator('.top-stats')).toContainText('7 notes')
  await expect(page.locator('.top-stats')).toContainText('6 links')
  await page.screenshot({ path: 'test-results/auto-layout-after.png' })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  // History records the worker's Float32 positions, including its rounding.
  await expect.poll(snapshot).toEqual(coordinates.map(position => position.map(Math.fround)))
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect.poll(snapshot).toEqual(arranged)
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-indicator')).toHaveClass(/saved/)
  await page.reload()
  await expect.poll(snapshot).toEqual(arranged)
  const p = await point(page, 'beta')
  await page.mouse.click(p.x, p.y)
  await expect(page.locator('.content-input')).toHaveValue('Content beta')
  expect(errors).toEqual([])
})
