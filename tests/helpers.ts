import { expect, type Page } from '@playwright/test'

export const fixture = {
  nodes: [
    { id: 'alpha', title: 'Alpha', summary: 'First note', content: 'Alpha contents', position: [0, 0, 0] },
    { id: 'beta', title: 'Beta', summary: 'Second note', content: 'Beta contents', position: [3, 0, 0] },
  ],
  edges: [], camera: { position: [0, 0, 10], quaternion: [0, 0, 0, 1], orbitTarget: [0, 0, 0] },
  preferences: { linkNavigationEnabled: false },
}
export async function seed(page: Page, state = fixture) {
  await page.addInitScript((state) => {
    if (!localStorage.getItem('neuron-test-seeded')) {
      localStorage.setItem('neuron-test-seeded', '1')
      localStorage.setItem('neuron-map-workspace-web-default', JSON.stringify(state))
    }
  }, state)
  await page.goto('/')
  await expect(page.locator('canvas')).toBeVisible()
  await expect(page.locator('.title-input')).toHaveValue('Alpha')
  await page.waitForFunction(async () => {
    const { graphEngine } = await import('/src/engine/graphEngine.ts')
    return graphEngine.runtime.ids.length === 2
  })
}
export async function point(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const { graphEngine } = await import('/src/engine/graphEngine.ts')
    const { getCameraSnapshot } = await import('/src/services/persistence.ts')
    const THREE = await import('/node_modules/three/build/three.module.js')
    const rect = document.querySelector('canvas')!.getBoundingClientRect()
    const camera = new THREE.PerspectiveCamera(55, rect.width / rect.height, 0.005, 500)
    const saved = getCameraSnapshot()
    camera.position.fromArray(saved.position); camera.quaternion.fromArray(saved.quaternion); camera.updateMatrixWorld()
    const p = new THREE.Vector3(...graphEngine.runtime.positionOf(id)!).project(camera)
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 }
  }, id)
}

