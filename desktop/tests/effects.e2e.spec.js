// v1.2 phase 3: effects rendered into exports, resample (recorded == offline render, imported as a
// new track) and fit-to-tempo/key (new track, chops carried over). Runs against the dev app
// and, in CI, the INSTALLED app on Windows and macOS.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv, pyJson, setWindowSize } = require('./helpers')

test.setTimeout(400_000)

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
    env: appEnv(dirs, { RIPPER_E2E_FAKE_OS_DRAG: '1' }),
  })
  win = await app.firstWindow({ timeout: 60_000 })
  await setWindowSize(app, win)
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  win.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
})

test.afterAll(async () => {
  await app?.close()
  if (dirs) fs.rmSync(dirs.root, { recursive: true, force: true })
})

let n = 0
async function download(index) {
  const before = new Set(fs.readdirSync(dirs.downloads))
  const fxTab = await win.getByTestId('fx-panel').isVisible()
  await win.getByTestId('side-tab-slices').click()
  await win.getByTestId(`slice-download-${index}`).dispatchEvent('click')
  let f
  await expect.poll(() => { f = fs.readdirSync(dirs.downloads).find((x) => x.endsWith('.wav') && !before.has(x)); return !!f }, { timeout: 60_000 }).toBe(true)
  await win.waitForTimeout(200)
  const dest = path.join(dirs.exports, `fx-${n++}-${f}`)
  fs.renameSync(path.join(dirs.downloads, f), dest)
  if (fxTab) await win.getByTestId('side-tab-fx').click()
  return dest
}
const check = (testId) => win.getByTestId(testId).check()
async function slide(testId, value) {
  await win.getByTestId(testId).evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

test('effects render into exports; tempo-synced delay lands on the beat', async () => {
  const fx = fixtures()
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
  await win.getByTestId('file-input').setInputFiles(fx.wav120)
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(win.getByTestId('slice-count')).toHaveText('16 slices')
  const dry = await download(2)

  // pad 3: delay 1/8 at 120 BPM (250 ms), no feedback, 100% wet
  await win.getByTestId('pad-2').dispatchEvent('mousedown', { button: 0 })
  await win.getByTestId('side-tab-fx').click()
  await check('padfx-delay-on')
  await win.getByTestId('padfx-delay-time').selectOption('1/8')
  await slide('padfx-delay-feedback', 0)
  await slide('padfx-delay-mix', 1)
  const wet = await download(2)
  let r = pyJson(`import json, sys, numpy as np, soundfile as sf
a = sf.read(sys.argv[1], always_2d=True)[0]; b = sf.read(sys.argv[2], always_2d=True)[0]; d = round(0.25 * 44100)
pad = np.zeros_like(b); pad[:len(a)] = a
echo = np.zeros_like(b); echo[d:d + len(a)] = a[:max(0, len(b) - d)]
print(json.dumps({"dry": len(a), "wet": len(b), "err": float(np.max(np.abs(b - pad - echo)))}))`, dry, wet)
  expect(r.wet).toBeGreaterThanOrEqual(r.dry + 0.25 * 44100) // the echo tail is in the file
  expect(r.err).toBeLessThan(1e-4) // = dry + the dry sound exactly one 8th later

  // reverb + drive also change the export and add a tail
  await check('padfx-reverb-on')
  await check('padfx-drive-on')
  const verb = await download(2)
  r = pyJson(`import json, sys, soundfile as sf
print(json.dumps({"n": sf.info(sys.argv[1]).frames, "m": sf.info(sys.argv[2]).frames}))`, wet, verb)
  expect(r.m).toBeGreaterThan(r.n)
  expect(consoleErrors).toEqual([])
})

test('resample: the recording equals the offline render, and imports as a new track', async () => {
  // a pattern on pads 1-3 (pad 3 has its effects) + master reverb + compressor
  await win.getByTestId('side-tab-fx').click()
  await win.getByTestId('master-reverb-on').check()
  await win.getByTestId('master-comp-on').check()
  await win.getByTestId('side-tab-seq').click()
  for (const [pad, s] of [[0, 0], [1, 4], [2, 8], [0, 10], [1, 12]]) {
    const st = win.getByTestId(`step-${pad}-${s}`)
    await st.dispatchEvent('pointerdown')
    await st.dispatchEvent('pointerup')
  }
  await win.waitForTimeout(300)
  const r = await win.evaluate(async () => {
    const p = window.__ripperTest.player
    const rec = await p.resamplePass()
    const off = p.renderPass()
    const n = Math.min(rec.channels[0].length, off[0].length)
    let err = 0
    let peak = 0
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { err = Math.max(err, Math.abs(rec.channels[c][i] - off[c][i])); peak = Math.max(peak, Math.abs(off[c][i])) }
    return { err, peak, rec: rec.channels[0].length, off: off[0].length, sr: rec.sr }
  })
  expect(r.peak).toBeGreaterThan(0.05)
  expect(r.err).toBeLessThan(1e-6) // the live recording is the offline render, sample for sample
  expect(r.rec).toBeGreaterThanOrEqual(Math.round(2 * r.sr)) // the whole bar (+ the reverb tail)

  // the button: record one pass -> a new track in the library, ready to chop
  await win.getByTestId('resample-pass').click()
  await expect(win.getByTestId('toast-success').filter({ hasText: 'Resampled track ready' })).toBeVisible({ timeout: 120_000 })
  const id = await win.evaluate(() => window.__ripperTest.lastResample.trackId)
  await win.getByTestId('back-to-library').click()
  const card = win.getByTestId(`track-card-${id}`)
  await expect(card).toHaveAttribute('data-status', 'ready')
  await expect(card).toContainText('resampled pattern A')
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(win.getByTestId('slice-count')).toHaveText('16 slices') // chopped and ready on pads
  expect(consoleErrors).toEqual([])
})

test('fit to the project tempo and key: a new track with the chops carried over', async () => {
  await win.getByTestId('back-to-library').click()
  await win.locator('[data-testid^="track-card-"]', { hasText: 'beat_120' }).first().click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  const before = await win.locator('[data-testid^="slice-row-"]').evaluateAll((els) => els.map((e) => [Number(e.dataset.start), Number(e.dataset.end)]))
  await win.getByTestId('match-bpm').fill('100')
  await win.getByTestId('match-fit').click()
  await expect(win.getByTestId('editor-title')).toContainText('(100 BPM)', { timeout: 120_000 })
  await expect(win.getByTestId('bpm-input')).toHaveValue('100')
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  const after = await win.locator('[data-testid^="slice-row-"]').evaluateAll((els) => els.map((e) => [Number(e.dataset.start), Number(e.dataset.end)]))
  expect(after).toHaveLength(before.length)
  // every chop scaled by the same stretch ratio (detected BPM / 100, ~1.2)
  const ratio = after[after.length - 1][1] / before[before.length - 1][1]
  expect(ratio).toBeGreaterThan(1.17)
  expect(ratio).toBeLessThan(1.23)
  after.forEach(([a, b], i) => { expect(a).toBeCloseTo(before[i][0] * ratio, 6); expect(b).toBeCloseTo(before[i][1] * ratio, 6) })
  // key shift from here: Am -> Bm keeps the tempo
  await win.getByTestId('match-key').selectOption('Bm')
  await win.getByTestId('match-fit').click()
  await expect(win.getByTestId('editor-key')).toHaveText('Bm', { timeout: 120_000 })
  await expect(win.getByTestId('bpm-input')).toHaveValue('100')
  expect(consoleErrors).toEqual([])
})
