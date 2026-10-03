import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
import { fixture } from './helpers'

test('production chunks, offline Markdown and PDF run under the desktop content policy', async ({ page }) => {
  const errors: string[] = [], external: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.route('**/*', async route => {
    const request = route.request()
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5185')) { external.push(request.url()); return route.abort() }
    if (request.isNavigationRequest()) { const response = await route.fetch(); return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': config.app.security.csp } }) }
    return route.continue()
  })
  await page.addInitScript(state => localStorage.setItem('neuron-map-workspace-web-default', JSON.stringify(state)), fixture)
  await page.goto('/')
  await expect(page.locator('.title-input')).toHaveValue('Alpha')
  await expect(page.getByLabel('Tags', { exact: true })).toHaveCount(1)
  await page.locator('.content-input').fill('# Research notes\n\n**Readable notes** with tables, code and attached files.\n\n- [x] Recovery snapshots\n- [x] Local attachments\n\n```js\nconst idea = "keep exploring";\n```\n\n[Malformed internal link](neuron:%E0)')
  await page.getByRole('button', { name: 'Read', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Research notes' })).toBeVisible()
  await page.getByLabel('Attach files', { exact: true }).setInputFiles('tests/fixtures/preview.pdf')
  await expect(page.locator('.attachment-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'Preview preview.pdf', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled({ timeout: 10000 })
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.screenshot({ path: 'test-results/production-v022.png' })
  expect(external).toEqual([]); expect(errors).toEqual([])
})
