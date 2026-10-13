import { test, expect, type Page } from '@playwright/test'
import { seed } from './helpers'

async function selectText(page: Page, text: string, from = 0, to = text.length) {
  await page.locator('.content-input').focus()
  await page.evaluate(({ text, from, to }) => {
    const root = document.querySelector('.content-input')!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const index = node.textContent!.indexOf(text)
      if (index >= 0) { const range = document.createRange(); range.setStart(node, index + from); range.setEnd(node, index + to); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); return }
    }
    throw new Error(`Text not found: ${text}`)
  }, { text, from, to })
  // Native selectionchange lets ProseMirror synchronize its selection.
  await page.waitForTimeout(80)
}
async function imageBytes(page: Page) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 650
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#dddddd'; ctx.fillRect(0, 0, 1000, 650)
    ctx.fillStyle = '#444444'; ctx.font = '36px sans-serif'; ctx.fillText('Neuron Map image notes', 50, 60)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(png, 'base64')
}
async function stroke(page: Page, from: [number, number], to: [number, number]) {
  const bounds = (await page.getByLabel('Draw on image', { exact: true }).boundingBox())!
  await page.mouse.move(bounds.x + bounds.width * from[0], bounds.y + bounds.height * from[1])
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * to[0], bounds.y + bounds.height * to[1], { steps: 3 })
  await page.mouse.up()
}

test('visual editor persists all six text formats and keeps wiki navigation working', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await seed(page)
  await page.locator('.content-input').fill('Bold Italic Underline Strike H2O x2 [[Beta]]')
  for (const [word, button, selector] of [['Bold', 'Bold', 'strong'], ['Italic', 'Italic', 'em'], ['Underline', 'Underline', 'u'], ['Strike', 'Strikethrough', 's']]) {
    await selectText(page, word); await page.getByRole('button', { name: button, exact: true }).click()
    await expect(page.locator(`.content-input ${selector}`)).toHaveText(word)
  }
  await selectText(page, 'H2O', 1, 2); await page.getByRole('button', { name: 'Subscript', exact: true }).click()
  await expect(page.locator('.content-input sub')).toHaveText('2')
  await selectText(page, 'x2', 1, 2); await page.getByRole('button', { name: 'Superscript', exact: true }).click()
  await expect(page.locator('.content-input sup')).toHaveText('2')
  await selectText(page, 'Beta'); await page.getByRole('button', { name: 'Bold', exact: true }).click()
  await page.keyboard.press('Control+s'); await expect(page.locator('.save-indicator')).toHaveClass(/saved/)
  await page.reload(); await expect(page.locator('.content-input strong').first()).toHaveText('Bold')
  await expect(page.locator('.content-input sub')).toHaveText('2'); await expect(page.locator('.content-input sup')).toHaveText('2')
  await page.getByRole('button', { name: '⚙', exact: true }).click()
  await page.getByLabel('Internal note navigation').check()
  await page.getByRole('button', { name: '⚙', exact: true }).click()
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.locator('.rich-reading u')).toHaveText('Underline')
  await page.getByRole('button', { name: 'Beta', exact: true }).click()
  await expect(page.locator('.title-input')).toHaveValue('Beta')
  expect(errors).toEqual([])
})

test('inline images save brush, eraser and text without changing original pixels', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await seed(page)
  const original = await imageBytes(page)
  await page.getByLabel('Insert images', { exact: true }).setInputFiles({ name: 'Evidence.png', mimeType: 'image/png', buffer: original })
  await expect(page.locator('.content-input img')).toHaveAttribute('alt', 'Evidence.png')
  await page.getByRole('button', { name: 'Open image Evidence.png', exact: true }).click()
  await expect(page.getByLabel('Draw on image', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Use color #4287ff', exact: true }).click()
  await page.getByLabel('Brush thickness', { exact: true }).focus(); await page.keyboard.press('End')
  await stroke(page, [.2, .3], [.7, .3])
  const painted = await page.getByLabel('Draw on image', { exact: true }).evaluate((canvas: HTMLCanvasElement) => [...canvas.getContext('2d')!.getImageData(canvas.width * .4, canvas.height * .3, 1, 1).data])
  expect(painted[2]).toBeGreaterThan(100); expect(painted[3]).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Eraser', exact: true }).click()
  await stroke(page, [.35, .3], [.45, .3])
  const erased = await page.getByLabel('Draw on image', { exact: true }).evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(canvas.width * .4, canvas.height * .3, 1, 1).data[3])
  expect(erased).toBe(0)
  const base = await page.getByLabel('Original image', { exact: true }).evaluate((canvas: HTMLCanvasElement) => [...canvas.getContext('2d')!.getImageData(canvas.width * .4, canvas.height * .3, 1, 1).data])
  expect(base).toEqual([221, 221, 221, 255])
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('Text to place on image').fill('Пояснение')
  await stroke(page, [.2, .6], [.2, .6])
  await page.getByRole('button', { name: 'Save annotations', exact: true }).click()
  await expect(page.getByText('Annotations saved to this note.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.keyboard.press('Control+s'); await expect(page.locator('.save-indicator')).toHaveClass(/saved/)
  const saved = await page.evaluate(async () => {
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    const { readAttachment } = await import('/src/services/attachments.ts')
    const { getActiveWorkspaceId } = await import('/src/services/persistence.ts')
    const node = useGraphStore.getState().nodes.find(n => n.id === 'alpha')!
    const layer = node.attachments!.find(file => file.name.endsWith('.annotations.json'))!
    return JSON.parse(await (await readAttachment(getActiveWorkspaceId()!, layer)).text())
  })
  expect(saved.marks.map((mark: any) => mark.kind)).toEqual(['stroke', 'stroke', 'text'])
  expect(saved.marks[0].color).toBe('#4287ff'); expect(saved.marks[1].erase).toBe(true)
  expect(saved.marks[2].text).toBe('Пояснение')
  expect(errors).toEqual([])
})

async function seedAnnotatedImage(page: Page) {
  await seed(page)
  const original = await imageBytes(page)
  await page.evaluate(async data => {
    const { storeAttachment } = await import('/src/services/attachments.ts')
    const { getActiveWorkspaceId } = await import('/src/services/persistence.ts')
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    const { saveImageAnnotations } = await import('/src/services/noteImages.ts')
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
    const file = await storeAttachment(getActiveWorkspaceId()!, new File([bytes], 'Evidence.png', { type: 'image/png' }))
    useGraphStore.getState().updateNode('alpha', { attachments: [file] })
    await saveImageAnnotations('alpha', getActiveWorkspaceId()!, file.id, [{ kind: 'stroke', color: '#4287ff', width: 40, erase: false, points: [{ x: .2, y: .3 }, { x: .7, y: .3 }] }, { kind: 'text', color: '#ff4444', size: 40, text: 'Пояснение', x: .2, y: .6 }])
  }, original.toString('base64'))
  await page.keyboard.press('Control+s'); await expect(page.locator('.save-indicator')).toHaveClass(/saved/)
  return original
}

test('saved inline image layers reopen after restart and support undo and redo', async ({ page }) => {
  await seedAnnotatedImage(page)
  await page.reload(); await expect(page.locator('.content-input img')).toBeVisible()
  await page.getByRole('button', { name: 'Open image Evidence.png', exact: true }).click()
  await expect(page.getByLabel('Draw on image', { exact: true })).toBeVisible()
  const restored = await page.getByLabel('Draw on image', { exact: true }).evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(canvas.width * .25, canvas.height * .3, 1, 1).data[3])
  expect(restored).toBeGreaterThan(0)
  await page.screenshot({ path: 'test-results/editor-annotations-v023.png' })
  await stroke(page, [.2, .8], [.6, .8])
  await page.getByRole('button', { name: 'Undo annotation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save annotations', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Redo annotation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save annotations', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Undo annotation', exact: true }).click()
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
})

test('workspace export and import keep inline images, original bytes and annotation layers', async ({ page }) => {
  const original = await seedAnnotatedImage(page)
  await page.locator('.workspace-switcher').click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export…', exact: true }).click()])
  const stream = await download.createReadStream(), chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk)
  const exported = JSON.parse(Buffer.concat(chunks).toString())
  expect(exported.files).toHaveLength(2)
  expect(exported.files.some((file: { data: string }) => file.data === original.toString('base64'))).toBe(true)
  await expect(page.locator('.workspace-busy-overlay')).toBeHidden()
  page.on('dialog', dialog => dialog.accept())
  await page.locator('.workspace-switcher').click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import…', exact: true }).click()])
  await chooser.setFiles((await download.path())!)
  await expect(page.locator('.workspace-switcher-name')).toHaveText('Main (2)')
  await expect(page.locator('.content-input img')).toBeVisible()
  await page.getByRole('button', { name: 'Open image Evidence.png', exact: true }).click()
  await expect(page.getByLabel('Draw on image', { exact: true })).toBeVisible()
})

test('clipboard and dropped images render in both editing and reading modes', async ({ page }) => {
  await seed(page)
  const bytes = (await imageBytes(page)).toString('base64')
  for (const kind of ['paste', 'drop']) {
    await page.locator('.content-input').evaluate((element, { kind, bytes }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], `${kind}.png`, { type: 'image/png' }))
      const event = kind === 'paste' ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: element.getBoundingClientRect().left + 30, clientY: element.getBoundingClientRect().bottom - 20 })
      element.dispatchEvent(event)
    }, { kind, bytes })
    await expect(page.locator('.content-input img')).toHaveCount(kind === 'paste' ? 1 : 2)
    await expect(page.locator('.workspace-busy-overlay')).toBeHidden()
  }
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.locator('.rich-reading img')).toHaveCount(2)
})

test('legacy Markdown tables, task lists and highlighted code survive a visual edit', async ({ page }) => {
  await seed(page)
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await page.getByLabel('Markdown source').fill('# Legacy\n\n- [x] Done\n- [ ] Next\n\n| Name | Value |\n| --- | --- |\n| A | 2 |\n\n![Reference](https://example.invalid/reference.png)\n\n<script>window.richUnsafe = true</script>\n\n```js\nconst value = 2\n```')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.content-input table')).toBeVisible()
  await expect(page.locator('.content-input li[data-type="taskItem"]')).toHaveCount(2)
  await expect(page.locator('.content-input input[type="checkbox"]').first()).toBeChecked()
  await selectText(page, 'Legacy'); await page.getByRole('button', { name: 'Underline', exact: true }).click()
  await page.keyboard.press('Control+s'); await expect(page.locator('.save-indicator')).toHaveClass(/saved/)
  await page.reload()
  await expect(page.locator('.content-input table')).toBeVisible()
  await expect(page.locator('.content-input u')).toHaveText('Legacy')
  await expect(page.locator('.content-input pre').filter({ hasText: 'const value = 2' }).locator('.hljs-keyword')).toContainText('const')
  await expect(page.locator('.content-input')).toContainText('https://example.invalid/reference.png')
  await expect(page.locator('.content-input')).toContainText('window.richUnsafe = true')
  expect(await page.evaluate(() => (window as any).richUnsafe)).toBeUndefined()
  await expect(page.locator('.content-input input[type="checkbox"]').first()).toBeChecked()
})
