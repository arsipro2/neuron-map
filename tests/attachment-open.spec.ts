import { test, expect } from '@playwright/test'
import { seed } from './helpers'

test('desktop attachment opens by ID, disables duplicate requests, saves separately and recovers from errors', async ({ page }) => {
  await seed(page)
  // Exercise the real UI and Tauri invoke boundary without launching a host app.
  await page.evaluate(async () => {
    const win = window as any
    win.attachmentCalls = []
    win.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command === 'save_workspace') return 1
      win.attachmentCalls.push({ command, args })
      if (command === 'open_attachment') return new Promise<void>((resolve, reject) => {
        win.finishOpen = (error?: string) => error ? reject(new Error(error)) : resolve()
      })
      if (command === 'save_attachment_as') return null
      throw new Error(`Unexpected native command: ${command}`)
    } }
    const { useGraphStore } = await import('/src/store/useGraphStore.ts')
    useGraphStore.getState().updateNode('alpha', { attachments: [{ id: 'native-file', name: 'документ.txt', mime: 'text/plain', size: 3, addedAt: 1 }] })
  })
  const open = page.getByTitle('Open документ.txt', { exact: true })
  const save = page.getByRole('button', { name: 'Save a copy of документ.txt', exact: true })
  await expect(open).toContainText('Open in default app')
  await open.click()
  await expect(open).toBeDisabled()
  await expect(save).toBeDisabled()
  await expect(open).toContainText('Opening…')
  await expect.poll(() => page.evaluate(() => (window as any).attachmentCalls)).toEqual([
    { command: 'open_attachment', args: { workspaceId: 'web-default', attachmentId: 'native-file' } },
  ])
  await page.evaluate(() => (window as any).finishOpen())
  await expect(open).toBeEnabled()
  await save.click()
  await expect.poll(() => page.evaluate(() => (window as any).attachmentCalls.at(-1)?.command)).toBe('save_attachment_as')
  await open.click()
  await expect.poll(() => page.evaluate(() => (window as any).attachmentCalls.length)).toBe(3)
  await page.evaluate(() => (window as any).finishOpen('No default application'))
  await expect(page.getByRole('alert')).toContainText('No default application')
  await expect(open).toBeEnabled()
  await open.click()
  await expect.poll(() => page.evaluate(() => (window as any).attachmentCalls.length)).toBe(4)
  await page.evaluate(() => (window as any).finishOpen())
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.attachment-hint')).toContainText('attach the edited file again')
  await page.screenshot({ path: 'test-results/attachment-open.png' })
})
