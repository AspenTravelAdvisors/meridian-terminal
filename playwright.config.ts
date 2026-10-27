import { defineConfig, devices } from '@playwright/test';

/** E2E runs against the production build served by scripts/serve.mjs (same CSP as Vercel). SIM:* symbols keep it offline-safe. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:8788', trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  projects: [
    { name: 'desktop', testMatch: /smoke\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    // Pixel 7: Chromium with touch, a phone viewport and a coarse pointer (the preinstalled browser is Chromium)
    { name: 'mobile', testMatch: /mobile\.spec\.ts/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: { command: 'node scripts/serve.mjs', env: { PORT: '8788' }, url: 'http://localhost:8788/api/health', reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
