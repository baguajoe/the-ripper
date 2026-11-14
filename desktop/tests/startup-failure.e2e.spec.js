// The engine can't start → the window shows a friendly error (never blank, never a silent
// exit) with "Copy diagnostics" and "Try again".
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, tempDirs, appEnv } = require('./helpers')

test('engine start-up failure shows a friendly error with diagnostics', async () => {
  const dirs = tempDirs()
  const packaged = process.env.RIPPER_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [path.join(ROOT, 'desktop')]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: appEnv(dirs, { RIPPER_ENGINE_CMD: path.join(dirs.base, 'no-such-engine') }), // spawn fails
  })
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    await expect(win.getByTestId('startup-error')).toBeVisible({ timeout: 30_000 })
    await expect(win.getByTestId('startup-error')).toContainText("couldn't start its audio engine")
    await win.getByTestId('startup-copy-diagnostics').click()
    await expect(win.getByTestId('startup-copy-diagnostics')).toHaveText('Copied ✓')
    const diag = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(diag).toContain('=== The Ripper diagnostics ===')
    expect(diag).toContain(`App version:   ${require('../package.json').version}`)
    expect(diag).toContain('[spawn_failed]')
    expect(diag).toMatch(/ffmpeg: +\S/)
    expect(diag).toMatch(/deno: +\S/)
    expect(diag).toContain('--- engine log')
    // Try again goes back through the start-up screen and fails the same way
    await win.getByTestId('startup-retry').click()
    await expect(win.getByTestId('startup-error')).toBeVisible({ timeout: 30_000 })
    expect(fs.existsSync(path.join(dirs.userData, 'logs', 'main.log'))).toBe(true)
  } finally {
    await app.close()
    fs.rmSync(dirs.root, { recursive: true, force: true })
  }
})
