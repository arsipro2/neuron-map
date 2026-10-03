import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/production.spec.ts',
  timeout: 30_000,
  workers: 1,
  globalTimeout: 120_000,
  use: {
    screenshot: 'only-on-failure',
    baseURL: 'http://127.0.0.1:5183',
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: { timeout: 30_000, command: 'npm run dev:web -- --host 127.0.0.1 --port 5183', url: 'http://127.0.0.1:5183', reuseExistingServer: false },
})
