import { test, expect, type Page } from '@playwright/test'
import { seed, point } from './helpers'

const canvas = (page: Page) => page.getByRole('application', { name: 'Diagram canvas' })
async function open(page: Page) {
  await page.getByRole('button', { name: 'Diagram', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Rectangle', exact: true })).toBeEnabled()
}
async function shape(page: Page, kind: string, x: number, y: number, text: string) {
  await page.getByRole('button', { name: kind, exact: true }).click()
  await canvas(page).click({ position: { x, y } })
  await page.getByLabel('Diagram label', { exact: true }).fill(text)
  return (await page.locator('[data-shape-id]').last().getAttribute('data-shape-id'))!
}
async function content(page: Page) {
  return page.evaluate(async () => {
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    const { loadNoteDiagram } = await import('/src/services/noteDiagrams.ts')
    const { getActiveWorkspaceId } = await import('/src/services/persistence.ts')
    const state = useGraphStore.getState()
    return loadNoteDiagram(getActiveWorkspaceId()!, state.nodes.find(n => n.id === state.selectedId)!)
  })
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save diagram', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Diagram saved$/ })).toBeVisible()
}

test('shapes, routed connectors, drag, resize and styles persist without replacing note text', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await seed(page); await open(page)
  const a = await shape(page, 'Rounded', 210, 170, 'Начало'), b = await shape(page, 'Diamond', 570, 330, 'Решение?')
  await page.getByRole('button', { name: 'Connector', exact: true }).click()
  await page.locator(`[data-shape-id="${a}"]`).click(); await page.locator(`[data-shape-id="${b}"]`).click()
  await page.getByLabel('Diagram label', { exact: true }).fill('Да')
  await expect(page.locator('[data-edge-id]')).toHaveCount(1)
  const edgeBefore = await page.locator('[data-edge-id] path').last().getAttribute('d')
  const box = (await page.locator(`[data-shape-id="${b}"]`).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 4 }); await page.mouse.up()
  await expect(page.locator('[data-edge-id] path').last()).not.toHaveAttribute('d', edgeBefore!)
  await page.getByLabel('Shape width', { exact: true }).fill('220')
  await page.getByLabel('Shape fill', { exact: true }).fill('#b8d8ff')
  await page.getByLabel('Shape text size', { exact: true }).fill('20')
  await save(page)
  const saved = await content(page)
  expect(saved!.shapes[1]).toMatchObject({ width: 220, fill: '#b8d8ff', fontSize: 20, text: 'Решение?' })
  expect(saved!.edges[0]).toMatchObject({ source: a, target: b, text: 'Да', route: 'orthogonal' })
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.locator('.content-input')).toHaveText('Alpha contents')
  await expect(page.locator('.attachment-row')).toHaveCount(0)
  await page.reload(); await expect(page.locator('.title-input')).toHaveValue('Alpha'); await open(page)
  await expect(page.locator('[data-shape-id]')).toHaveCount(2)
  expect(await content(page)).toEqual(saved)
  await page.screenshot({ path: 'test-results/diagram-editor.png' })
  expect(errors).toEqual([])
})

test('SVG and PNG exports work offline, and editable diagrams survive workspace export/import', async ({ page }) => {
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:5183') ? route.continue() : route.abort())
  await seed(page); await open(page)
  await shape(page, 'Ellipse', 220, 180, 'Схема <A> & B')
  await save(page); const original = await content(page)
  const [svgDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export SVG', exact: true }).click()])
  const svgStream = (await svgDownload.createReadStream())!, svgChunks: Buffer[] = []; for await (const part of svgStream) svgChunks.push(part)
  expect(Buffer.concat(svgChunks).toString()).toContain('&lt;A&gt; &amp; B')
  const [pngDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PNG', exact: true }).click()])
  const pngStream = (await pngDownload.createReadStream())!, pngChunks: Buffer[] = []; for await (const part of pngStream) pngChunks.push(part)
  expect(Buffer.concat(pngChunks).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.locator('.workspace-switcher').click()
  const [exported] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export…', exact: true }).click()])
  const file = (await exported.path())!
  await expect(page.locator('.workspace-busy-overlay')).toBeHidden()
  await page.locator('.workspace-switcher').click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import…', exact: true }).click()])
  await chooser.setFiles(file)
  await expect(page.locator('.workspace-switcher-name')).toHaveText('Main (2)')
  await open(page); expect(await content(page)).toEqual(original)
})

test('diagram shortcuts, duplicate, resize handle and dirty close stay isolated from the graph', async ({ page }) => {
  await seed(page); await open(page)
  await shape(page, 'Rectangle', 220, 180, 'Один')
  const handle = (await page.getByLabel('Resize shape', { exact: true }).boundingBox())!
  await page.mouse.move(handle.x + 6, handle.y + 6); await page.mouse.down(); await page.mouse.move(handle.x + 66, handle.y + 46, { steps: 4 }); await page.mouse.up()
  await expect(page.getByLabel('Shape width', { exact: true })).toHaveValue('240')
  const initialZoom = await page.getByLabel('Diagram zoom', { exact: true }).textContent()
  const stage = (await canvas(page).boundingBox())!
  await page.mouse.move(stage.x + 300, stage.y + 250); await page.mouse.wheel(0, -120)
  await expect(page.getByLabel('Diagram zoom', { exact: true })).not.toHaveText(initialZoom!)
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  await canvas(page).focus(); await page.keyboard.press('Control+d')
  await expect(page.locator('[data-shape-id]')).toHaveCount(2)
  await page.keyboard.press('Control+z'); await expect(page.locator('[data-shape-id]')).toHaveCount(1)
  await page.keyboard.press('Control+Shift+z'); await expect(page.locator('[data-shape-id]')).toHaveCount(2)
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v')
  await expect(page.locator('[data-shape-id]')).toHaveCount(4)
  await page.keyboard.press('Delete'); await expect(page.locator('[data-shape-id]')).toHaveCount(2)
  // A focused dialog header must also block shortcuts from deleting the graph note.
  await page.getByRole('button', { name: 'Close dialog', exact: true }).focus(); await page.keyboard.press('Delete')
  expect(await page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().nodes.length)).toBe(2)
  page.once('dialog', d => d.dismiss())
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  page.once('dialog', d => d.dismiss())
  expect(await page.evaluate(() => window.dispatchEvent(new Event('neuron-map:before-close', { cancelable: true })))).toBe(false)
  await save(page)
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const beta = await point(page, 'beta'); await page.mouse.click(beta.x, beta.y); await open(page)
  await expect(page.locator('[data-shape-id]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.locator('.title-input')).toHaveValue('Beta')
})

test('failed diagram storage keeps edits available for retry', async ({ page }) => {
  await seed(page); await open(page)
  await shape(page, 'Rectangle', 220, 180, 'Не потерять')
  await page.evaluate(() => { (window as any).__TAURI_INTERNALS__ = { invoke: async () => { throw new Error('Disk is full') } } })
  await page.getByRole('button', { name: 'Save diagram', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Disk is full')
  await expect(page.getByLabel('Diagram label', { exact: true })).toHaveValue('Не потерять')
  await page.evaluate(() => { delete (window as any).__TAURI_INTERNALS__ })
  await save(page); expect((await content(page))!.shapes[0].text).toBe('Не потерять')
})

test('diagram revisions follow graph Undo/Redo and failed workspace flush can be retried', async ({ page }) => {
  await seed(page); await open(page)
  await shape(page, 'Rounded', 220, 180, 'Version one'); await save(page)
  await page.getByLabel('Diagram label', { exact: true }).fill('Version two')
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    ;(window as any).__restoreStorage = () => { Storage.prototype.setItem = original }
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('neuron-map-workspace-')) throw new Error('Workspace disk is full')
      return original.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: 'Save diagram', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Workspace disk is full' })).toBeVisible()
  await page.evaluate(() => { (window as any).__restoreStorage(); delete (window as any).__restoreStorage })
  await save(page)
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  // First undo removes the retry's metadata; the next restores the first saved revision.
  await page.evaluate(async () => {
    const store = (await import('/src/store/useGraphStore.ts')).useGraphStore.getState()
    store.undo(); store.undo()
  })
  await open(page); expect((await content(page))!.shapes[0].text).toBe('Version one')
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.evaluate(async () => (await import('/src/store/useGraphStore.ts')).useGraphStore.getState().redo())
  await open(page); expect((await content(page))!.shapes[0].text).toBe('Version two')
})

test('a damaged stored diagram reports an error and cannot be silently overwritten', async ({ page }) => {
  await seed(page)
  await page.evaluate(async () => {
    const { storeAttachment } = await import('/src/services/attachments.ts')
    const { DIAGRAM_MIME } = await import('/src/services/diagrams.ts')
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    const file = await storeAttachment('web-default', new File(['{broken'], 'diagram.neuron.json', { type: DIAGRAM_MIME }))
    useGraphStore.getState().updateNode('alpha', { attachments: [file] })
  })
  await page.getByRole('button', { name: 'Diagram', exact: true }).click()
  await expect(page.locator('.diagram-loading')).not.toHaveText('Opening diagram…')
  await expect(page.getByRole('button', { name: 'Save diagram', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.locator('.content-input')).toHaveText('Alpha contents')
})
