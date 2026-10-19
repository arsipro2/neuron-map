import { test, expect, type Page } from '@playwright/test'
import { seed, point, fixture } from './helpers'

async function prepare(page: Page) {
  await seed(page)
  await page.evaluate(async fixture => {
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    useGraphStore.getState().hydrateGraph([
      ...fixture.nodes,
      { ...fixture.nodes[0], id: 'hidden', title: 'Hidden note', position: [-3, 0, 0] },
      { ...fixture.nodes[0], id: 'deep', title: 'Existing descendant', position: [3, 2, 0] },
    ], [{ id: 'ab', source: 'alpha', target: 'beta' }, { id: 'bd', source: 'beta', target: 'deep' }])
  }, fixture)
  await page.waitForFunction(async () => (await import('/src/engine/graphEngine.ts')).graphEngine.runtime.ids.length === 4)
  await page.getByRole('button', { name: 'Show neighbors', exact: true }).click()
}
async function visible(page: Page) {
  return page.evaluate(async () => [...(await import('/src/services/graphView.ts')).visibleNoteIds()!].sort())
}
async function branch(page: Page, source: string) {
  const p = await point(page, source)
  await page.mouse.move(p.x, p.y)
  await page.waitForTimeout(250)
  for (let x = 5; x <= 44; x += 5) await page.mouse.move(p.x + x, p.y)
  await page.mouse.move(p.x + 44, p.y); await page.mouse.down()
  await page.mouse.move(p.x + 130, p.y - 100, { steps: 10 }); await page.mouse.up()
  await expect(page.locator('.title-input')).toHaveValue('New note')
  return page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().selectedId!)
}

test('Show neighbors supports real connector creation across generations and explicit Show all', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await prepare(page)
  expect(await visible(page)).toEqual(['alpha', 'beta'])
  const edgeCount = () => page.evaluate(async () => (await import('/src/components/OptimizedGraphLayer.tsx')).graphDiagnostics.visibleEdges)
  await expect.poll(edgeCount).toBe(1)
  // A hidden node is still in the camera view but must not be selectable.
  const hidden = await point(page, 'hidden'); await page.mouse.click(hidden.x, hidden.y)
  await expect(page.locator('.title-input')).toHaveCount(0)
  const alpha = await point(page, 'alpha'); await page.mouse.click(alpha.x, alpha.y)
  const child = await branch(page, 'alpha')
  await page.locator('.title-input').fill('Child branch')
  await page.waitForTimeout(700) // Let the focus camera settle before the second drag.
  const grandchild = await branch(page, child)
  await page.locator('.title-input').fill('Grandchild branch')
  expect(await visible(page)).toEqual(['alpha', 'beta', child, grandchild].sort())
  await expect.poll(edgeCount).toBe(3)
  await expect(page.locator('.neighborhood-banner')).toBeVisible()
  await expect(page.locator('.note-tools button')).toHaveText('Show all notes')
  await page.locator('.search-shell input').fill('Hidden')
  await expect(page.locator('.search-empty')).toHaveText('No matching notes')
  await page.locator('.search-shell input').fill('Child branch')
  await page.locator('.search-result').filter({ has: page.locator('strong', { hasText: /^Child branch$/ }) }).click()
  await expect(page.locator('.title-input')).toHaveValue('Child branch')
  expect(await visible(page)).toContain(grandchild)
  await page.locator('.note-tools button').click()
  await expect.poll(edgeCount).toBe(4)
  await expect(page.locator('.neighborhood-banner')).toHaveCount(0)
  await page.locator('.search-shell input').fill('Hidden')
  await page.locator('.search-result').click()
  await expect(page.locator('.title-input')).toHaveValue('Hidden note')
  expect(errors).toEqual([])
})

test('New node, Undo/Redo and saving keep the neighborhood until its banner exits', async ({ page }) => {
  await prepare(page)
  await page.getByRole('button', { name: '+ New node', exact: true }).click()
  await expect(page.locator('.title-input')).toHaveValue('New note')
  const id = await page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().selectedId!)
  expect(await visible(page)).toEqual(['alpha', 'beta', id].sort())
  await page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().undo())
  await expect(page.locator('.neighborhood-banner')).toBeVisible()
  await page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().redo())
  await expect(page.locator('.title-input')).toHaveValue('New note')
  expect(await visible(page)).toContain(id)
  await page.keyboard.press('Control+s')
  // Camera focus can mark the view dirty again; verify the saved graph itself.
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('neuron-map-workspace-web-default')!)
    return saved.nodes.map((n: { id: string }) => n.id).sort()
  })).toEqual(['alpha', 'beta', 'hidden', 'deep', id].sort())
  await page.locator('.neighborhood-banner button').click()
  await expect(page.locator('.neighborhood-banner')).toHaveCount(0)
  expect(await page.evaluate(async () => (await import('/src/services/graphView.ts')).visibleNoteIds())).toBeNull()
})
