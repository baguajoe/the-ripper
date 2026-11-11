// End-to-end: the real Electron app starts its own engine; we drive the UI like a user.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')
const { execFileSync } = require('node:child_process')
const { ROOT, fixtures, inspectWav, tempDirs, python } = require('./helpers')

// Linux (xvfb): perform a REAL native drag — hold the X pointer with XTest, fire dragstart,
// let Electron run its XDND loop, release over the desktop. Elsewhere the OS drag loop is
// skipped (RIPPER_E2E_FAKE_OS_DRAG) and everything up to startDrag is still exercised.
const REAL_OS_DRAG = process.platform === 'linux' && !!process.env.DISPLAY && (() => {
  try { execFileSync(python(), ['-c', 'import Xlib'], { stdio: 'ignore' }); return true } catch { return false }
})()
const xdrag = (...args) => execFileSync(python(), [path.join(__dirname, 'xdrag.py'), ...args.map(String)])

let app
let win
let dirs
const consoleErrors = []

test.beforeAll(async () => {
  dirs = tempDirs()
  // RIPPER_E2E_EXECUTABLE=<packaged app binary> runs the same test against an installer build.
  const packaged = process.env.RIPPER_E2E_EXECUTABLE
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [path.join(ROOT, 'desktop')]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      RIPPER_APP_DATA: dirs.appData,
      RIPPER_STORAGE: dirs.storage,
      RIPPER_USER_DATA: dirs.userData,
      RIPPER_DOWNLOAD_DIR: dirs.downloads,
      RIPPER_EXPORT_DIR: dirs.exports,
      RIPPER_ENGINE_NEW: '1',
      ...(REAL_OS_DRAG ? {} : { RIPPER_E2E_FAKE_OS_DRAG: '1' }),
    },
  })
  // Surface the app's (and engine's) own logs in the test output, e.g. for CI failures.
  app.process().stdout?.on('data', (d) => process.stdout.write(`[app] ${d}`))
  app.process().stderr?.on('data', (d) => {
    const text = String(d).split('\n').filter((l) => l && !/dbus|Fontconfig/.test(l)).join('\n')
    if (text) process.stderr.write(`[app] ${text}\n`)
  })
  win = await app.firstWindow({ timeout: 60_000 })
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
})

test.afterAll(async () => {
  await app?.close()
  if (dirs) fs.rmSync(dirs.base, { recursive: true, force: true })
})

/** Drag the element out of the app like a user; returns main's record of the drag. */
async function nativeDrag(testId) {
  const el = win.getByTestId(testId)
  await el.hover() // pre-render on hover
  await win.waitForTimeout(300)
  await expect.poll(() => app.evaluate(() => globalThis.__ripperPendingRenders ?? 0), { timeout: 60_000 }).toBe(0)
  const before = await app.evaluate(() => globalThis.__ripperLastDrag?.at ?? 0)
  if (REAL_OS_DRAG) {
    const box = await el.boundingBox()
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds())
    xdrag('press', Math.round(bounds.x + box.x + box.width / 2), Math.round(bounds.y + box.y + box.height / 2))
  }
  await el.dispatchEvent('dragstart')
  if (REAL_OS_DRAG) {
    await win.waitForTimeout(700) // main is now inside the native drag loop
    xdrag('release')
  }
  await expect.poll(() => app.evaluate(() => globalThis.__ripperLastDrag?.at ?? 0), { timeout: 30_000 }).toBeGreaterThan(before)
  return app.evaluate(() => globalThis.__ripperLastDrag)
}

test('boot → upload → analyze → chop → pads → stems → drag → export kit', async () => {
  const fx = fixtures()

  // --- app boots and the backend is healthy
  // first start of a cold Python/librosa can be slow on CI runners
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 120_000 })
  const health = await win.evaluate(async () => {
    const e = await window.ripper.getEngine()
    return (await fetch(`${e.baseUrl}/api/v1/health`)).json()
  })
  expect(health.ok).toBe(true)
  expect(health.ffmpeg).toBe(true)
  await expect(win.getByTestId('rights-note')).toContainText('Only import content you own')

  // --- upload the fixture WAV
  await win.getByTestId('file-input').setInputFiles(fx.wav120)
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  await expect(card.getByTestId('track-bpm')).toHaveText('120 BPM')
  expect(['Am', 'C']).toContain((await card.getByTestId('track-key').textContent()).trim())

  // --- open the editor, chop by 1 bar
  await card.click()
  await expect(win.getByTestId('editor')).toBeVisible()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
  await expect(win.locator('.grid-bar').first()).toBeAttached()
  await win.getByTestId('chop-mode-grid').click()
  await win.getByTestId('chop-division').selectOption('1bar')
  await win.getByTestId('chop-apply').click()
  await expect(win.getByTestId('slice-count')).toHaveText('6 slices')

  // --- transport: Space plays, the playhead moves, Space pauses
  await win.keyboard.press('Space')
  await expect(win.getByTestId('play-toggle')).toContainText('Pause')
  await expect.poll(async () => (await win.getByTestId('playhead').textContent()).split(' / ')[0], { timeout: 10_000 }).not.toBe('0:00.0')
  await win.keyboard.press('Space')
  await expect(win.getByTestId('play-toggle')).toContainText('Play')

  // --- pad 1 plays through Web Audio (click + keyboard)
  await win.getByTestId('pad-0').dispatchEvent('mousedown', { button: 0 })
  await win.keyboard.press('2')
  const audio = await win.evaluate(() => window.__ripperDebug)
  expect(audio.padsTriggered).toBeGreaterThanOrEqual(2)
  expect(audio.audioState).toBe('running')

  // --- native drag of a slice: pre-render on hover, then dragstart -> main startDrag
  const drag = await nativeDrag('pad-0')
  expect(drag.error).toBeUndefined()
  expect(drag.files).toHaveLength(1)
  const dragged = drag.files[0]
  expect(fs.existsSync(dragged)).toBe(true)
  expect(path.basename(dragged)).toMatch(/^beat-120_120bpm_(Am|C)_slice01\.wav$/)
  expect(fs.readFileSync(dragged).includes(Buffer.from('acid'))).toBe(true)
  const info = inspectWav(dragged)
  expect(info).toMatchObject({ sr: 44100, channels: 2, subtype: 'PCM_24' })
  expect(info.acid.bpm).toBeCloseTo(120, 3)

  // --- Fast (DSP) stems
  await win.getByTestId('open-stems').click()
  await expect(win.getByTestId('stems-screen')).toBeVisible()
  await win.getByTestId('engine-dsp').check()
  await win.getByTestId('stems-run').click()
  await expect(win.getByTestId('stem-mixer')).toBeVisible({ timeout: 120_000 })
  for (const s of ['drums', 'bass', 'vocals', 'other']) await expect(win.getByTestId(`stem-${s}`)).toBeVisible()
  await expect(win.getByTestId('stems-label')).toContainText('Fast mode')
  await expect(win.getByTestId('stems-play')).toBeEnabled({ timeout: 30_000 })

  // stem drag renders a real file too
  const stemDrag = await nativeDrag('stem-drag-drums')
  expect(stemDrag.spec.kind).toBe('stem')
  expect(path.basename(stemDrag.files[0])).toMatch(/_drums\.wav$/)

  // --- back to the editor (slices kept) and export the kit
  await win.getByTestId('back-to-editor').click()
  await expect(win.getByTestId('slice-count')).toHaveText('6 slices')
  await win.getByTestId('export-kit').click()
  await expect(win.getByTestId('toast-success').filter({ hasText: '_Kit.zip' })).toBeVisible({ timeout: 60_000 })
  const zips = fs.readdirSync(dirs.downloads).filter((f) => f.endsWith('.zip'))
  expect(zips).toHaveLength(1)
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dirs.downloads, zips[0])))
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  expect(names.filter((n) => n.startsWith('Slices/') && n.endsWith('.wav'))).toHaveLength(6)
  expect(names.filter((n) => n.startsWith('Stems/') && n.endsWith('.wav')).sort().map((n) => n.split('_').pop()))
    .toEqual(['bass.wav', 'drums.wav', 'other.wav', 'vocals.wav'])
  expect(names.filter((n) => n.endsWith('.mid'))).toHaveLength(1)

  // --- kit drag uses multi-file drag
  const kit = await nativeDrag('drag-kit')
  expect(kit.spec.kind).toBe('kit')
  expect(kit.files.length).toBe(6 + 4 + 1)
  expect(kit.files.filter((f) => f.endsWith('.mid'))).toHaveLength(1)

  const midi = await nativeDrag('drag-midi')
  expect(midi.files).toHaveLength(1)
  expect(midi.files[0]).toMatch(/_slices\.mid$/)

  // --- export to folder (remembered path via RIPPER_EXPORT_DIR in tests)
  await win.getByTestId('export-folder').click()
  await expect(win.getByTestId('toast-success').filter({ hasText: 'Exported 6 file(s)' })).toBeVisible()
  const exported = fs.readdirSync(dirs.exports, { recursive: true }).filter((f) => String(f).endsWith('.wav'))
  expect(exported).toHaveLength(6)
  await expect(win.getByTestId('export-folder-pick')).toContainText(path.basename(dirs.exports))

  expect(consoleErrors).toEqual([])
})
