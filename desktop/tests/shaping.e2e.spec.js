// v1.2 phase 1: slice trim editor, pad sound shaping (rendered into the exported WAVs) and pad
// management. Runs against the dev app and, in CI, the INSTALLED app on Windows and macOS.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv, inspectWav, pyJson, setWindowSize } = require('./helpers')

test.setTimeout(400_000)

let app
let win
let dirs
const consoleErrors = []
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

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

const rows = () => win.locator('[data-testid^="slice-row-"]').evaluateAll(
  (els) => els.map((r) => ({ start: Number(r.dataset.start), end: Number(r.dataset.end), pad: Number(r.dataset.pad) })))

/** Set a range input like a user dragging it (React listens to input events). */
async function slide(testId, value) {
  if (!(await win.getByTestId('pad-panel').isVisible())) await win.getByTestId('side-tab-pad').click()
  await win.getByTestId(testId).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

/** Click the slice row's Save-WAV button; returns the saved file (moved aside so names never clash). */
let saved = 0
async function download(index) {
  const before = new Set(fs.readdirSync(dirs.downloads))
  const onPad = await win.getByTestId('pad-panel').isVisible()
  await win.getByTestId('side-tab-slices').click()
  await win.getByTestId(`slice-download-${index}`).dispatchEvent('click') // may be scrolled out of a small window
  let file
  await expect.poll(() => {
    file = fs.readdirSync(dirs.downloads).find((f) => f.endsWith('.wav') && !before.has(f))
    return !!file
  }, { timeout: 60_000 }).toBe(true)
  await win.waitForTimeout(200)
  const dest = path.join(dirs.exports, `dl-${saved++}-${file}`)
  fs.renameSync(path.join(dirs.downloads, file), dest)
  if (onPad) await win.getByTestId('side-tab-pad').click()
  return dest
}

const PY_LOAD = 'import json, sys, numpy as np, soundfile as sf\nld = lambda p: sf.read(p, always_2d=True, dtype="float64")[0]\n'

test('trim editor: exact typed times, zero-crossing nudges, link neighbors', async () => {
  const fx = fixtures()
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
  await win.getByTestId('file-input').setInputFiles(fx.wav120)
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(win.getByTestId('slice-count')).toHaveText('16 slices')
  await expect.poll(() => win.evaluate(() => !!window.__ripperTest?.editorSource)).toBe(true)

  // --- double-click a pad: the trim editor; type exact times
  await win.getByTestId('pad-0').dblclick()
  await expect(win.getByTestId('trim-editor')).toBeVisible()
  await expect(win.getByTestId('trim-zero')).toBeChecked() // zero-crossing snap is on by default
  await expect(win.getByTestId('trim-link')).not.toBeChecked() // link neighbors is off by default
  await win.getByTestId('trim-start').fill('0.1234')
  await win.getByTestId('trim-start').press('Enter')
  await win.getByTestId('trim-end').fill('0.4321')
  await win.getByTestId('trim-end').press('Enter')
  await expect.poll(async () => (await rows())[0]).toEqual({ start: 0.1234, end: 0.4321, pad: 0 })
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('trim-editor')).toHaveCount(0)
  // the trimmed slice exports at exactly its new length
  const trimmed = await download(0)
  expect(inspectWav(trimmed).frames).toBe(Math.round((0.4321 - 0.1234) * 44100))

  // --- nudges land on zero crossings (start, then end)
  await win.getByTestId('slice-row-1').dblclick()
  await expect(win.getByTestId('trim-editor')).toBeVisible()
  const r0 = (await rows())[1]
  await win.keyboard.press('ArrowRight') // start + 1 ms, to the next zero crossing
  await expect.poll(async () => (await rows())[1].start).toBeGreaterThan(r0.start)
  const onZero = (t) => win.evaluate((time) => {
    const { sr, channels: [a, b] } = window.__ripperTest.editorSource
    const j = Math.round(time * sr)
    const m = (i) => 0.5 * (a[i] + (b ? b[i] : a[i]))
    const neg = m(j) < 0
    return { exact: Math.abs(j / sr - time) < 1e-9, zero: m(j) === 0 || (m(j - 1) < 0) !== neg || (m(j + 1) < 0) !== neg }
  }, t)
  expect(await onZero((await rows())[1].start)).toEqual({ exact: true, zero: true })
  await win.keyboard.press(']') // the end marker
  await win.keyboard.press('Shift+ArrowLeft')
  await expect.poll(async () => (await rows())[1].end).toBeLessThan(r0.end)
  expect(await onZero((await rows())[1].end)).toEqual({ exact: true, zero: true })
  // without link the neighbour stayed put: there's now a gap before slice 3
  expect((await rows())[2].start).toBe(r0.end)

  // --- link neighbors: moving the end drags the next slice's start along (contiguous)
  await win.getByTestId('trim-link').check()
  for (let i = 0; i < 4; i++) await win.keyboard.press('Shift+ArrowRight')
  await expect.poll(async () => (await rows())[1].end).toBeGreaterThan(r0.end + 0.02)
  let r = await rows()
  expect(r[2].start).toBe(r[1].end)
  await win.keyboard.press('[')
  await win.keyboard.press('Shift+ArrowLeft')
  await expect.poll(async () => (await rows())[1].start).toBeLessThan(r0.start)
  r = await rows()
  expect(r[0].end).toBe(r[1].start) // the previous slice followed too
  // grid snap option + typed times keep working with link
  await win.getByTestId('trim-snap').selectOption('grid')
  await win.getByTestId('trim-audition').check() // loops the slice while trimming
  await expect.poll(() => win.evaluate(() => window.__ripperTest.player.playing)).toBeGreaterThan(0)
  await win.getByTestId('trim-close').click()
  await expect.poll(() => win.evaluate(() => window.__ripperTest.player.playing)).toBe(0)
  expect(consoleErrors).toEqual([])
})

test('pad shaping renders into the exported WAVs', async () => {
  const ref = await download(4) // pad 5, unshaped
  await win.getByTestId('pad-4').dispatchEvent('mousedown', { button: 0 })
  await win.getByTestId('side-tab-pad').click()
  await expect(win.getByTestId('pad-panel')).toBeVisible()

  // tune +12: one octave up = exactly every other sample of the original, half the length
  await slide('shape-tune', 12)
  await expect(win.getByTestId('shape-tune-value')).toHaveText('+12 st')
  await expect(win.getByTestId('pad-4').locator('.pad-flag-shaped')).toBeVisible()
  const up = await download(4)
  let r = pyJson(`${PY_LOAD}a = ld(sys.argv[1]); b = ld(sys.argv[2]); n = len(b)
e = np.abs(b[:n - 1] - a[0:2 * (n - 1):2]); i = int(np.argmax(e.max(axis=1)))
print(json.dumps({"ref": len(a), "n": n, "err": float(e.max()), "at": i, "a": a[2*i].tolist(), "b": b[i].tolist(), "a1": a[2*i+1].tolist()}))`, ref, up)
  expect(r.n).toBe(Math.ceil(r.ref / 2))
  expect(r.err).toBeLessThan(1e-4)

  // keep length: +7 semitones by time-stretching — same length (within 1%), different audio
  await slide('shape-tune', 7)
  await win.getByTestId('shape-keeplength').check()
  await expect(win.getByTestId('shape-tune-value')).toHaveText('+7 st')
  const kept = await download(4)
  r = pyJson(`${PY_LOAD}a = ld(sys.argv[1]); b = ld(sys.argv[2])
print(json.dumps({"ref": len(a), "n": len(b), "diff": float(np.max(np.abs(a[:min(len(a), len(b))] - b[:min(len(a), len(b))])))}))`, ref, kept)
  expect(Math.abs(r.n - r.ref) / r.ref).toBeLessThan(0.01)
  expect(r.diff).toBeGreaterThan(0.01)

  // envelope: a 200 ms attack ramps the start in (source x linear ramp)
  await win.getByTestId('shape-reset').click()
  await slide('shape-attack', 200)
  const att = await download(4)
  r = pyJson(`${PY_LOAD}a = ld(sys.argv[1]); b = ld(sys.argv[2]); k = int(0.2 * 44100)
ramp = (np.arange(k) / k)[:, None]
print(json.dumps({"same_len": len(a) == len(b), "err": float(np.max(np.abs(b[:k] - a[:k] * ramp))), "after": float(np.max(np.abs(b[k:] - a[k:])))}))`, ref, att)
  expect(r).toEqual({ same_len: true, err: expect.any(Number), after: expect.any(Number) })
  expect(r.err).toBeLessThan(1e-3)
  expect(r.after).toBeLessThan(1e-4)

  // pan hard left: the right channel is silent
  await win.getByTestId('shape-reset').click()
  await slide('shape-pan', -100)
  const left = await download(4)
  r = pyJson(`${PY_LOAD}b = ld(sys.argv[1]); print(json.dumps({"l": float(np.max(np.abs(b[:, 0]))), "r": float(np.max(np.abs(b[:, 1])))}))`, left)
  expect(r.r).toBe(0)
  expect(r.l).toBeGreaterThan(0.05)

  // low-pass at ~200 Hz: the highs are gone
  await win.getByTestId('shape-reset').click()
  await win.getByTestId('shape-filter-lp').click()
  await slide('shape-cutoff', 230) // log scale: ~ 98 Hz.. see PadPanel
  const lp = await download(4)
  r = pyJson(`${PY_LOAD}from scipy.signal import welch
def hi(x):
    f, p = welch(x.mean(axis=1), 44100, nperseg=2048); return float(p[f > 2000].sum() / p.sum())
print(json.dumps({"ref": hi(ld(sys.argv[1])), "lp": hi(ld(sys.argv[2]))}))`, ref, lp)
  expect(r.lp).toBeLessThan(r.ref / 50)

  // velocity -> volume / -> filter, through the same engine the pads and exports use
  const v = await win.evaluate(() => {
    const { renderPad, editorSource: src } = window.__ripperTest
    const s = { start: 2, end: 2.5 }
    const pk = ([L]) => L.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
    return { full: pk(renderPad(src, s, { vel: 127 })), half: pk(renderPad(src, s, { vel: 64 })), none: pk(renderPad(src, { ...s, velVol: 0 }, { vel: 1 })) }
  })
  expect(v.half / v.full).toBeCloseTo(64 / 127, 3)
  expect(v.none / v.full).toBeCloseTo(1, 6)
  expect(consoleErrors).toEqual([])
})

test('pad management: copy / paste, swap, rename, color, undo', async () => {
  await win.getByTestId('side-tab-slices').click()
  const padSlice = (i) => win.getByTestId(`pad-${i}`).getAttribute('data-slice')
  const p2 = await padSlice(2)
  const p3 = await padSlice(3)
  // Alt-drag pad 3 onto pad 4 swaps them
  const dt = await win.evaluateHandle(() => new DataTransfer())
  await win.getByTestId('pad-2').dispatchEvent('dragstart', { dataTransfer: dt, altKey: true })
  await win.getByTestId('pad-3').dispatchEvent('dragover', { dataTransfer: dt })
  await win.getByTestId('pad-3').dispatchEvent('drop', { dataTransfer: dt })
  await expect.poll(() => padSlice(2)).toBe(p3)
  expect(await padSlice(3)).toBe(p2)
  await win.keyboard.press(`${mod}+z`) // undo the swap
  await expect.poll(() => padSlice(2)).toBe(p2)

  // Ctrl+C / Ctrl+V: pad 1 onto pad 16
  const src0 = (await rows()).find((x) => x.pad === 0)
  await win.getByTestId('pad-0').dispatchEvent('mousedown', { button: 0 })
  await win.keyboard.press(`${mod}+c`)
  await win.getByTestId('pad-15').dispatchEvent('mousedown', { button: 0 })
  await win.keyboard.press(`${mod}+v`)
  await expect.poll(async () => (await rows()).filter((x) => x.pad === 15).map((x) => [x.start, x.end])).toEqual([[src0.start, src0.end]])

  // right-click: rename + color on the pad itself
  await win.getByTestId('pad-5').click({ button: 'right' })
  await expect(win.getByTestId('pad-menu')).toBeVisible()
  await win.getByTestId('pad-color-3').click()
  await win.getByTestId('pad-rename').fill('Snare hit')
  await win.getByTestId('pad-rename').press('Enter')
  await expect(win.getByTestId('pad-5')).toContainText('Snare hit')
  expect(await win.getByTestId('pad-5').evaluate((el) => el.style.getPropertyValue('--pad-color'))).toBe('#40c4ff')
  expect(consoleErrors).toEqual([])
})
