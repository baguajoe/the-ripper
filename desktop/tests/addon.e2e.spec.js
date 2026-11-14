// v1.1.3: HQ (AI) stems as a one-click add-on. CI builds the add-on in the same run, serves
// it locally (RIPPER_E2E_AI_MANIFEST) and runs this against the INSTALLED app on Windows and
// macOS: install from a clean app, separate a 10 s clip with 4 and 6 stems, remove.
// The model weights come from the Demucs author's Hugging Face repos, as for users.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv } = require('./helpers')

const MANIFEST = process.env.RIPPER_E2E_AI_MANIFEST
test.skip(!MANIFEST, 'set RIPPER_E2E_AI_MANIFEST to a served add-on manifest (CI builds one)')
test.setTimeout(45 * 60_000)

let app
let win
let dirs
const consoleErrors = []

test.beforeAll(async () => {
  dirs = tempDirs()
  const packaged = process.env.RIPPER_E2E_EXECUTABLE
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [path.join(ROOT, 'desktop')]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: appEnv(dirs, { RIPPER_E2E_FAKE_OS_DRAG: '1', RIPPER_AI_MANIFEST_URL: MANIFEST, RIPPER_AI_NO_DEV_RUNTIME: '1' }),
  })
  app.process().stdout?.on('data', (d) => process.stdout.write(`[app] ${d}`))
  app.process().stderr?.on('data', (d) => {
    const text = String(d).split('\n').filter((l) => l && !/dbus|Fontconfig|ALSA|alsa|GET \/api\/v1\/(jobs|health|addons)/.test(l)).join('\n')
    if (text) process.stderr.write(`[app] ${text}\n`)
  })
  win = await app.firstWindow({ timeout: 60_000 })
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
})

test.afterAll(async () => {
  await app?.close()
  if (dirs) fs.rmSync(dirs.root, { recursive: true, force: true })
})

async function separate(model, names, label) {
  await win.getByTestId('ai-model').selectOption(model)
  await expect(win.getByTestId('stems-estimate')).toContainText('Estimated time: ~')
  console.log(`[test] ${model}: ${await win.getByTestId('stems-estimate').textContent()}`)
  const t0 = Date.now()
  await win.getByTestId('stems-run').click()
  await expect(win.getByTestId('stems-progress')).toBeVisible()
  await expect(win.getByTestId('stems-label')).toContainText(label, { timeout: 30 * 60_000 })
  console.log(`[test] ${model}: separated in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await expect(win.locator('[data-testid^="stem-drag-"]')).toHaveCount(names.length)
  for (const n of names) await expect(win.getByTestId(`stem-${n}`)).toBeVisible()
  await expect(win.getByTestId('stems-play')).toBeEnabled({ timeout: 60_000 })
}

test('get HQ (AI) stems in one click, separate 4 + 6 stems, remove it', async () => {
  const fx = fixtures()
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
  await win.getByTestId('file-input').setInputFiles(fx.clip10)
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await win.getByTestId('open-stems').click()

  // --- a clean app: HQ (AI) is offered as a download, with its size up front; no pip anywhere
  const addon = win.getByTestId('addon-card')
  await expect(addon).toHaveAttribute('data-state', 'available', { timeout: 60_000 })
  await expect(win.getByTestId('addon-size')).toContainText(/Download: \d+(\.\d)? (MB|GB)/)
  console.log(`[test] ${await win.getByTestId('addon-size').textContent()}`)
  await expect(win.getByTestId('engine-ai')).toBeDisabled()
  await expect(win.getByTestId('stems-screen')).not.toContainText('pip')

  // --- one click: progress, then HQ (AI) appears without restarting the app
  const t0 = Date.now()
  await win.getByTestId('addon-get').click()
  await expect(win.getByTestId('addon-progress')).toBeVisible()
  await expect(win.getByTestId('engine-ai')).toBeEnabled({ timeout: 30 * 60_000 })
  console.log(`[test] add-on installed in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  await expect(addon).toHaveAttribute('data-state', 'installed')
  await expect(win.getByTestId('ai-device')).toBeVisible()
  const runtime = path.join(dirs.appData, 'addons', 'ai', 'runtime')
  const models = path.join(dirs.appData, 'addons', 'ai', 'models')
  expect(fs.existsSync(path.join(runtime, 'pack.json'))).toBe(true)
  expect(fs.readdirSync(models).sort()).toEqual(['5c90dfd2.safetensors', '955717e8.safetensors', 'htdemucs.yaml', 'htdemucs_6s.yaml'])

  // --- separate the 10 s clip: 4 stems, then 6 stems
  await win.getByTestId('engine-ai').check()
  await separate('htdemucs', ['drums', 'bass', 'other', 'vocals'], 'HQ (AI) · 4 stems')
  await separate('htdemucs_6s', ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'], 'HQ (AI) · 6 stems')
  // the estimate learned from the runs
  await expect(win.getByTestId('stems-estimate')).toContainText('Estimated time')

  // --- remove: everything goes, and the download is offered again
  await win.getByTestId('addon-remove').click()
  await expect(addon).toHaveAttribute('data-state', 'available', { timeout: 60_000 })
  await expect(win.getByTestId('engine-ai')).toBeDisabled()
  await expect(win.getByTestId('addon-get')).toBeVisible()
  expect(fs.existsSync(runtime)).toBe(false)
  expect(fs.existsSync(models)).toBe(false)

  expect(consoleErrors).toEqual([])
})
