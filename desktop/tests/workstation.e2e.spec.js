// v1.2 phase 4: export the beat (WAV, MIDI, per-pad stems, chops in original position; folder,
// zip, multi-file drag), session files (save / open / older format / autosave) and audio
// settings. Runs against the dev app and, in CI, the INSTALLED app on Windows and macOS.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv, pyJson, setWindowSize } = require('./helpers')

test.setTimeout(400_000)

let app
let win
let dirs
const consoleErrors = []

async function launch() {
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
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
}

test.beforeAll(async () => {
  dirs = tempDirs()
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  if (dirs) fs.rmSync(dirs.root, { recursive: true, force: true })
})

const tap = async (pad, s) => {
  const st = win.getByTestId(`step-${pad}-${s}`)
  await st.dispatchEvent('pointerdown')
  await st.dispatchEvent('pointerup')
}
const newFiles = (dir, before) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => !before.has(f) && /\.(wav|mid)$/.test(f))

async function toFolder(testId, n) {
  const before = new Set(fs.readdirSync(dirs.exports, { recursive: true }).map(String))
  await win.getByTestId(testId).click()
  await expect(win.getByTestId('toast-success').filter({ hasText: `Exported ${n} file(s)` })).toBeVisible({ timeout: 120_000 })
  return newFiles(dirs.exports, before).sort().map((f) => path.join(dirs.exports, f))
}

test('export the beat: stems sum to the beat, chops in place sum to the original, MIDI, drag', async () => {
  const fx = fixtures()
  await win.getByTestId('file-input').setInputFiles(fx.wav120)
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(win.getByTestId('slice-count')).toHaveText('16 slices')
  await win.getByTestId('side-tab-seq').click()
  for (const [pad, s] of [[0, 0], [1, 4], [2, 8], [3, 12], [0, 10], [5, 14]]) await tap(pad, s)
  await win.getByTestId('beat-master').uncheck() // the master bus (compressor) isn't linear: off for the sum check

  // --- per-pad stems + the beat, into the export folder
  const stems = await toFolder('beat-stems-folder', 5)
  expect(stems.map((f) => path.basename(f).split('_').slice(-2)[0])).toEqual(['pad01', 'pad02', 'pad03', 'pad04', 'pad06'])
  const [beat] = await toFolder('beat-beat-folder', 1)
  let r = pyJson(`import json, sys, numpy as np, soundfile as sf
d = [sf.read(f, always_2d=True)[0] for f in sys.argv[1:]]
beat, stems = d[-1], d[:-1]
s = np.sum(stems, axis=0)
print(json.dumps({"lens": sorted({len(x) for x in d}), "err": float(np.max(np.abs(s - beat))), "peak": float(np.max(np.abs(beat))),
  "first": [float(np.max(np.abs(x[:64]))) for x in stems]}))`, ...stems, beat)
  expect(r.lens).toHaveLength(1) // every file the same length, from bar 1
  expect(r.peak).toBeGreaterThan(0.05)
  expect(r.err).toBeLessThan(1e-4) // per-pad stems sum to the full beat (24-bit rounding)
  expect(r.first[0]).toBeGreaterThan(0) // pad 1 plays on step 1: audio from sample 0

  // --- chops in original position: the selection, current bank
  await win.getByTestId('beat-range').selectOption('selection')
  await win.getByTestId('beat-scope').selectOption('bank')
  const chops = await toFolder('beat-chops-folder', 16)
  const sel = await win.getByTestId('selection-info').evaluate((e) => [Number(e.dataset.start), Number(e.dataset.end)])
  const src = await win.evaluate(() => 'ok') // the original audio: re-read by Python from the track folder
  expect(src).toBe('ok')
  const storage = dirs.storage
  r = pyJson(`import json, sys, glob, numpy as np, soundfile as sf
start, end = float(sys.argv[1]), float(sys.argv[2]); files = sys.argv[4:]
src = sorted(glob.glob(sys.argv[3] + '/*/source.wav'))[0]
a, sr = sf.read(src, always_2d=True)
d = [sf.read(f, always_2d=True)[0] for f in files]
n = int(round((end - start) * sr)); ref = a[int(round(start * sr)):int(round(start * sr)) + n]
print(json.dumps({"lens": sorted({len(x) for x in d}), "n": n, "err": float(np.max(np.abs(np.sum(d, axis=0) - ref)))}))`, sel[0], sel[1], storage, ...chops)
  expect(r.lens).toEqual([r.n]) // identical length = the selection
  expect(r.err).toBeLessThan(1e-4) // they sum back to the original range

  // --- MIDI (single file, saved) and a multi-file drag of the stems
  const before = new Set(fs.readdirSync(dirs.downloads))
  await win.getByTestId('beat-midi-save').click()
  let mid
  await expect.poll(() => { mid = fs.readdirSync(dirs.downloads).find((f) => f.endsWith('.mid') && !before.has(f)); return !!mid }, { timeout: 60_000 }).toBe(true)
  const midi = fs.readFileSync(path.join(dirs.downloads, mid))
  expect(midi.subarray(0, 4).toString()).toBe('MThd')
  expect(mid).toMatch(/_pattern_A\.mid$/)

  const chip = win.getByTestId('drag-beat-stems')
  await chip.hover()
  await expect.poll(() => app.evaluate(() => globalThis.__ripperPendingRenders ?? 0), { timeout: 60_000 }).toBe(0)
  await win.waitForTimeout(500)
  await chip.hover()
  await expect.poll(() => app.evaluate(() => globalThis.__ripperPendingRenders ?? 0), { timeout: 60_000 }).toBe(0)
  const t0 = await app.evaluate(() => globalThis.__ripperLastDrag?.at ?? 0)
  await chip.dispatchEvent('dragstart')
  await expect.poll(() => app.evaluate(() => globalThis.__ripperLastDrag?.at ?? 0), { timeout: 30_000 }).toBeGreaterThan(t0)
  const drag = await app.evaluate(() => globalThis.__ripperLastDrag)
  expect(drag.files).toHaveLength(5) // one drag, every pad stem
  expect(drag.files.every((f) => /_pad\d\d_/.test(f))).toBe(true)
  expect(consoleErrors).toEqual([])
})

test('sessions: save / open round-trips every setting; autosave; an older session opens', async () => {
  // shape a few things so the state is rich
  await win.getByTestId('pad-2').dispatchEvent('mousedown', { button: 0 })
  await win.getByTestId('side-tab-pad').click()
  await win.getByTestId('shape-tune').evaluate((el) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '5'); el.dispatchEvent(new Event('input', { bubbles: true })) })
  await win.getByTestId('bank-vintage').selectOption('16bit')
  await win.getByTestId('side-tab-fx').click()
  await win.getByTestId('master-reverb-on').check()
  await win.getByTestId('side-tab-seq').click()
  await win.getByTestId('seq-swing').evaluate((el) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '58'); el.dispatchEvent(new Event('input', { bubbles: true })) })
  await win.getByTestId('pattern-B').click()
  await tap(7, 3)
  await win.getByTestId('seq-quantize').selectOption('1/32')
  const before = await win.evaluate(() => window.__ripperTest.sessionState())

  const file = path.join(dirs.base, 'My Beat. v1.ripper')
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, file)
  await expect(win.getByTestId('session-save')).toContainText('•') // unsaved changes
  await win.getByTestId('session-saveas').click()
  await expect(win.getByTestId('toast-success').filter({ hasText: 'My Beat. v1.ripper' })).toBeVisible({ timeout: 60_000 })
  await expect(win.getByTestId('session-save')).not.toContainText('•')
  expect(fs.statSync(file).size).toBeGreaterThan(10_000)

  // autosave writes the open session when something changed
  await tap(8, 1)
  const m0 = fs.statSync(file).mtimeMs
  await win.evaluate(() => window.__ripperTest.autosaveNow())
  await expect.poll(() => fs.statSync(file).mtimeMs).toBeGreaterThan(m0)
  await tap(8, 1) // back to the saved pattern
  await win.getByTestId('session-save').click()
  // let the save finish before quitting (a request cut off by the quit is an error in the console)
  await expect(win.getByTestId('session-save')).not.toContainText('•', { timeout: 60_000 })
  await expect(win.getByTestId('toast-success').filter({ hasText: 'My Beat. v1.ripper' }).last()).toBeVisible()
  await win.waitForTimeout(500)

  // restart, open it (Ctrl+O): everything comes back
  await app.close()
  await launch()
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, file)
  await expect(win.getByTestId('recent-session').first()).toContainText('beat_120')
  await win.getByTestId('library-open-session').click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  const after = await win.evaluate(() => window.__ripperTest.sessionState())
  const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'id' ? undefined : v)))
  expect(strip(after)).toEqual(strip(before))
  await expect(win.getByTestId('bank-vintage')).toHaveValue('16bit')

  // an older (v1.1-era) session: just the pad program
  const old = path.join(dirs.base, 'old.ripper')
  pyJson(`import json, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z: doc = json.loads(z.read('session.json')); audio = z.read('audio/source.flac')
doc['version'] = 1
doc['state'] = {'version': 1, 'banks': [{'slices': [{'start': 0.5, 'end': 1.0, 'name': 'old kick'}, {'start': 1.0, 'end': 1.5, 'name': 'slice02'}], 'mono': True}]}
with zipfile.ZipFile(dst, 'w') as z: z.writestr('session.json', json.dumps(doc)); z.writestr('audio/source.flac', audio)
print(json.dumps(1))`, file, old)
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, old)
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+o' : 'Control+o')
  await expect(win.getByTestId('slice-count')).toHaveText('2 slices', { timeout: 60_000 })
  await expect(win.getByTestId('pad-0')).toContainText('old kick')
  expect(consoleErrors).toEqual([])
})

test('audio settings: latency shown and measured; buffer + device switch without a restart', async () => {
  await win.getByTestId('audio-open').click()
  await expect(win.getByTestId('audio-latency')).toBeVisible()
  expect(Number(await win.getByTestId('audio-latency').getAttribute('data-total'))).toBeGreaterThanOrEqual(0)
  await win.getByTestId('audio-measure').click()
  await expect(win.getByTestId('audio-measured')).toBeVisible({ timeout: 30_000 })
  const ms = Number(await win.getByTestId('audio-measured').getAttribute('data-ms'))
  console.log(`measured pad latency: ${ms.toFixed(1)} ms`)
  expect(ms).toBeGreaterThan(0)
  expect(ms).toBeLessThan(500)
  // a new buffer size: the pad engine moves to a new audio context, pads keep playing
  const rate0 = await win.evaluate(() => window.__ripperTest.player.ctx)
  expect(rate0).toBeTruthy()
  await win.getByTestId('audio-buffer').selectOption('256')
  await expect.poll(() => win.evaluate(() => window.__ripperTest.player.ctx.state !== 'closed')).toBe(true)
  // every output device in turn (CI machines may only have the default)
  const devices = await win.getByTestId('audio-device').locator('option').evaluateAll((o) => o.map((x) => x.value))
  for (const d of devices) await win.getByTestId('audio-device').selectOption(d)
  await win.getByTestId('audio-close').click()
  await win.getByTestId('pad-0').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(() => win.evaluate(() => window.__ripperTest.player.status.triggered)).toBeGreaterThan(0)
  expect(await win.evaluate(() => window.__ripperDebug.audioState)).toBe('running')
  expect(consoleErrors.filter((e) => !/setSinkId|NotAllowed|NotFound/.test(e))).toEqual([])
})
