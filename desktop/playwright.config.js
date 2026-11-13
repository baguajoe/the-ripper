// Playwright e2e against the real desktop app via _electron.launch().
// On Linux CI run under xvfb:  xvfb-run -a npx playwright test
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '*.e2e.spec.js', // tests/unit/ runs under node --test
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
