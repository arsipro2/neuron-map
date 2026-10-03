import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', testMatch: '**/production.spec.ts', timeout: 30_000, globalTimeout: 60_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5185', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 5185 --strictPort', url: 'http://127.0.0.1:5185', reuseExistingServer: false, timeout: 30_000 },
})
