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

test('auto layout unfolds inward branches while keeping their root fixed', async ({ page }) => {
  const coordinates = [[0, 0, 0], [4, 0, 0], [2, 2, 0], [1, 3, 0], [-4, 0, 0], [-2, -2, 0], [-1, -3, 0]]
  const ids = ['alpha', 'right1', 'right2', 'right3', 'left1', 'left2', 'left3']
  const nodes = coordinates.map((position, i) => ({ ...fixture.nodes[0], id: ids[i], title: i ? ids[i] : 'Alpha', position }))
  const edges = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6]].map(([a, b], i) => ({ id: `e${i}`, source: ids[a], target: ids[b] }))
  await page.addInitScript(state => localStorage.setItem('neuron-map-workspace-web-default', JSON.stringify(state)), {
    ...fixture, nodes, edges, camera: { ...fixture.camera, position: [0, 0, 22] },
  })
  await page.goto('/')
  await expect(page.locator('.title-input')).toHaveValue('Alpha')
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.screenshot({ path: 'test-results/folded-branches-before.png' })
  await page.getByRole('button', { name: '⚙', exact: true }).click()
  await page.getByRole('button', { name: 'Auto layout', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => {
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    const positions = useGraphStore.getState().nodes.map(node => node.position)
    return positions[2][0] - positions[1][0]
  })).toBeGreaterThan(2)
  const positions = await page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().nodes.map(node => node.position))
  expect(positions[0]).toEqual([0, 0, 0])
  for (const [sign, branch] of [[1, [0, 1, 2, 3]], [-1, [0, 4, 5, 6]]] as const) {
    for (let i = 1; i < branch.length; i++) expect(sign * (positions[branch[i]][0] - positions[branch[i - 1]][0])).toBeGreaterThan(2)
    for (let i = 1; i < branch.length - 1; i++) {
      const [a, b, c] = [branch[i - 1], branch[i], branch[i + 1]]
      const incoming = positions[b].map((n, axis) => n - positions[a][axis])
      const outgoing = positions[c].map((n, axis) => n - positions[b][axis])
      const dot = incoming.reduce((sum, n, axis) => sum + n * outgoing[axis], 0)
      expect(dot / (Math.hypot(...incoming) * Math.hypot(...outgoing))).toBeGreaterThan(.8)
    }
  }
  await expect(page.locator('.top-stats')).toContainText('7 notes')
  await expect(page.locator('.top-stats')).toContainText('6 links')
  await page.screenshot({ path: 'test-results/folded-branches-after.png' })
})
