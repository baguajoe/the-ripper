// v1.2 phase 4 polish: the first-run tour, the "?" shortcut sheet, tooltips, and what the free
// plan keeps vs. what Pro unlocks. Runs against the dev app and, in CI, the INSTALLED app.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv, setWindowSize } = require('./helpers')

test.setTimeout(300_000)

let app
let win
let dirs

async function launch(extra) {
  const packaged = process.env.RIPPER_E2E_EXECUTABLE
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [path.join(ROOT, 'desktop')]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: appEnv(dirs, { RIPPER_E2E_FAKE_OS_DRAG: '1', ...extra }),
  })
  win = await app.firstWindow({ timeout: 60_000 })
  await setWindowSize(app, win)
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
}

test.beforeAll(() => { dirs = tempDirs() })
test.afterAll(async () => {
  await app?.close()
  if (dirs) fs.rmSync(dirs.root, { recursive: true, force: true })
})

test('first-run tour (skippable, once) and the ? cheat sheet', async () => {
  await launch({ RIPPER_SKIP_TOUR: '0' })
  await expect(win.getByTestId('tour')).toBeVisible()
  const titles = []
  for (let i = 0; i < 5; i++) {
    titles.push(await win.getByTestId('tour-title').textContent())
    await win.getByTestId('tour-next').click()
  }
  expect(titles).toEqual(['Import', 'Select', 'Chop', 'Play', 'Drag to your DAW'])
  await expect(win.getByTestId('tour')).toHaveCount(0)
  // "?" opens / closes the shortcut sheet
  await win.keyboard.press('?')
  await expect(win.getByTestId('shortcuts')).toBeVisible()
  await expect(win.getByTestId('shortcuts')).toContainText('Nudge the marker 1 ms')
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('shortcuts')).toHaveCount(0)
  // once done, it doesn't come back
  await app.close()
  await launch({ RIPPER_SKIP_TOUR: '0' })
  await win.waitForTimeout(1500)
  await expect(win.getByTestId('tour')).toHaveCount(0)
  await app.close()
})

test('free plan: pads, trim, one pattern pair and Fast stems stay; Pro features are locked', async () => {
  await launch({ RIPPER_PRO: '0' })
  await expect(win.getByTestId('plan-badge')).toHaveText('FREE')
  await win.getByTestId('file-input').setInputFiles(fixtures().wav120)
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(win.getByTestId('slice-count')).toHaveText('16 slices') // import, analysis, chopping: free
  await win.getByTestId('pad-0').dblclick()
  await expect(win.getByTestId('trim-editor')).toBeVisible() // trim: free
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('bank-2')).toBeDisabled()
  await expect(win.getByTestId('bank-vintage')).toBeDisabled()
  await expect(win.getByTestId('match-fit')).toBeDisabled()
  await expect(win.getByTestId('export-kit')).toBeDisabled()
  await win.getByTestId('side-tab-pad').click()
  await expect(win.getByTestId('shape-keeplength')).toBeDisabled()
  await expect(win.getByTestId('shape-tune')).toBeEnabled() // pads: free
  await win.getByTestId('side-tab-fx').click()
  await expect(win.getByTestId('fx-locked')).toBeVisible()
  await win.getByTestId('side-tab-seq').click()
  await expect(win.getByTestId('pattern-A')).toBeEnabled()
  await expect(win.getByTestId('pattern-B')).toBeEnabled()
  await expect(win.getByTestId('pattern-C')).toBeDisabled()
  await expect(win.getByTestId('resample-pass')).toBeDisabled()
  await expect(win.getByTestId('resample-live')).toBeDisabled()
  await expect(win.getByTestId('beat-stems-save')).toBeDisabled()
  await expect(win.getByTestId('beat-chops-save')).toBeDisabled()
  // every control has a tooltip
  const untitled = await win.locator('button:visible, select:visible, input:visible').evaluateAll((els) => els
    .filter((e) => e.type !== 'file' && !e.title && !e.closest('[title]')).map((e) => e.dataset.testid || e.outerHTML.slice(0, 80)))
  expect(untitled).toEqual([])
  await app.close()
})
