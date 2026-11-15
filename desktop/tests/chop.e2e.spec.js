// v1.1.3: chop a selection (not the whole song) into pad banks, re-chop on change with undo,
// and pads that behave like a classic sampler (mono choke, note-on, stop). Runs against the dev app and,
// in CI, the INSTALLED app on Windows and macOS.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv } = require('./helpers')

test.setTimeout(300_000)

const BPM = 128
const BAR = 240 / BPM

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
  app.process().stderr?.on('data', (d) => {
    const text = String(d).split('\n').filter((l) => l && !/dbus|Fontconfig|ALSA|alsa/.test(l)).join('\n')
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

/** [start, end] of every slice row in the current bank. */
const sliceTimes = () => win.locator('[data-testid^="slice-row-"]').evaluateAll(
  (rows) => rows.map((r) => [Number(r.dataset.start), Number(r.dataset.end)]))
const count = () => win.getByTestId('slice-count')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('selection chopping, banks, undo/redo, sampler pads', async () => {
  const fx = fixtures()
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
  await win.getByTestId('file-input').setInputFiles(fx.wav128)
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  // the producer types the exact tempo (the analysis may read 128.6), which re-grids the track
  if ((await win.getByTestId('bpm-input').inputValue()) !== String(BPM)) {
    await win.getByTestId('bpm-input').fill(String(BPM))
    await win.getByTestId('bpm-apply').click()
    await expect(win.getByTestId('bpm-input')).toHaveValue(String(BPM))
    await win.getByTestId('select-bars-4').click()
    await win.getByTestId('chop-count').selectOption('16') // re-chop on the exact grid
  }

  // --- no selection: 4 bars from the playhead, Even 16, into bank A: exactly 16 equal slices
  await expect(count()).toHaveText('16 slices')
  await expect(win.getByTestId('bank-info')).toContainText('Bank A · Even 16')
  await expect(win.getByTestId('selection-info')).toContainText('4 bars')
  let t = await sliceTimes()
  const D = t[0][0] // bar 1 (the detected downbeat, a few ms in)
  expect(D).toBeLessThan(BAR / 8)
  expect(t).toHaveLength(16)
  expect(t[15][1]).toBeCloseTo(D + 4 * BAR, 3)
  for (const [a, b] of t) expect(b - a).toBeCloseTo((4 * BAR) / 16, 4)
  for (let b = 1; b < 8; b++) await expect(win.getByTestId(`bank-${b}`)).toHaveAttribute('data-count', '0')

  // --- changing the size re-chops right away; undo / redo (buttons and keys)
  await win.getByTestId('chop-count').selectOption('8')
  await expect(count()).toHaveText('8 slices')
  await win.getByTestId('chop-count').selectOption('32') // 32 slices: banks A + B
  await expect(count()).toHaveText('16 slices')
  await expect(win.getByTestId('bank-1')).toHaveAttribute('data-count', '16')
  await win.getByTestId('undo').click()
  await expect(count()).toHaveText('8 slices')
  await expect(win.getByTestId('bank-1')).toHaveAttribute('data-count', '0')
  await win.locator('body').click({ position: { x: 5, y: 5 } }) // focus off the dropdown
  await win.keyboard.press(`${mod}+z`)
  await expect(count()).toHaveText('16 slices')
  await win.keyboard.press(`${mod}+Shift+z`)
  await expect(count()).toHaveText('8 slices')
  await win.getByTestId('redo').click()
  await expect(count()).toHaveText('16 slices')
  await expect(win.getByTestId('bank-1')).toHaveAttribute('data-count', '16')

  // --- Grid inside the selection: 1/2 beat over 4 bars = 32 slices; 1 bar = 4
  await win.getByTestId('chop-mode-grid').click()
  await win.getByTestId('chop-division').selectOption('1bar')
  await expect(count()).toHaveText('4 slices')
  t = await sliceTimes()
  expect(t.map(([a, b]) => Number((b - a).toFixed(4)))).toEqual(Array(4).fill(Number(BAR.toFixed(4))))
  await expect(win.getByTestId('bank-1')).toHaveAttribute('data-count', '0') // the 32-slice chop's bank B was freed

  // --- pick bars 3-4 (click a bar number, shift-click another) and chop: the next empty bank
  await win.getByTestId('bar-tag-3').click()
  await win.getByTestId('bar-tag-4').click({ modifiers: ['Shift'] })
  await expect(win.getByTestId('selection-info')).toContainText('bar 3.1 → 5.1 · 2 bars')
  await win.getByTestId('chop-mode-even').click() // re-chops bank A with the new selection
  await win.getByTestId('chop-count').selectOption('8')
  await expect(count()).toHaveText('8 slices')
  t = await sliceTimes()
  expect(t[0][0]).toBeCloseTo(D + 2 * BAR, 3)
  expect(t[7][1]).toBeCloseTo(D + 4 * BAR, 3)
  await win.getByTestId('select-bars-1').click() // 1 bar from the playhead (at 0)
  await expect(win.getByTestId('selection-info')).toContainText('bar 1.1 → 2.1 · 1 bar')
  await expect(win.getByTestId('chop-apply')).toContainText('Bank B')
  await win.getByTestId('chop-apply').click()
  await expect(win.getByTestId('pad-grid')).toHaveAttribute('data-bank', '1')
  await expect(count()).toHaveText('8 slices')
  await expect(win.getByTestId('bank-0')).toHaveAttribute('data-count', '8') // A untouched
  t = await sliceTimes()
  expect(t[7][1]).toBeCloseTo(D + BAR, 3)
  // "Replace current bank" chops into the bank you're on
  await win.getByTestId('chop-replace').check()
  await win.getByTestId('select-bars-2').click()
  await win.getByTestId('chop-apply').click()
  await expect(win.getByTestId('pad-grid')).toHaveAttribute('data-bank', '1')
  await expect(win.getByTestId('bank-2')).toHaveAttribute('data-count', '0')
  await win.getByTestId('chop-replace').uncheck()

  // --- Transients inside the selection, capped at 16 by default
  await win.getByTestId('select-all').click()
  await win.getByTestId('chop-mode-transients').click()
  await expect(win.getByTestId('chop-cap')).toHaveValue('16')
  await expect(count()).toHaveText('16 slices', { timeout: 30_000 })
  t = await sliceTimes()
  for (const [a, b] of t) expect(b - a).toBeGreaterThanOrEqual(0.05 - 1e-6) // 50 ms minimum
  await win.getByTestId('chop-cap').selectOption('4')
  await expect(count()).toHaveText('4 slices')

  // --- sampler-style pads: Mono on by default, Poly, choke all / unchoke all, note-on, stop
  await expect(win.getByTestId('bank-mono')).toBeChecked()
  const playing = () => win.evaluate(() => window.__ripperTest?.player?.playing ?? 0)
  await win.getByTestId('pad-0').dispatchEvent('mousedown', { button: 0 })
  await win.getByTestId('pad-1').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(playing).toBe(1) // pad 2 cut pad 1
  await win.getByTestId('bank-mono').uncheck()
  await win.getByTestId('pad-0').dispatchEvent('mousedown', { button: 0 })
  await win.getByTestId('pad-1').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(playing).toBeGreaterThanOrEqual(2) // poly: they ring out together
  await win.keyboard.press('Escape') // Esc stops everything
  await expect.poll(playing).toBe(0)
  await win.getByTestId('pad-2').dispatchEvent('mousedown', { button: 0 })
  await win.getByTestId('stop-all').click() // so does the Stop button
  await expect.poll(playing).toBe(0)
  await win.getByTestId('choke-all').click()
  await expect(win.locator('[data-testid^="pad-"] .pad-flag', { hasText: 'CH' })).toHaveCount(4)
  await win.getByTestId('unchoke-all').click()
  await expect(win.locator('[data-testid^="pad-"] .pad-flag', { hasText: 'CH' })).toHaveCount(0)
  await win.getByTestId('slice-padmode-0').selectOption('noteon')
  await expect(win.getByTestId('pad-0')).toContainText('HOLD')
  await win.getByTestId('pad-0').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(playing).toBe(1)
  await win.getByTestId('pad-0').dispatchEvent('mouseup', { button: 0 })
  await expect.poll(playing).toBe(0) // note-on: stops when released

  expect(consoleErrors).toEqual([])
})

test('mono choke: pad 1 is silent within 10 ms of pad 2 (rendered with the app\'s pad engine)', async () => {
  // Render the app's own pad engine (the code the AudioWorklet runs) offline: pad 1, then pad 2
  // at T. pad 1's contribution = render(both) - render(pad 2 alone); it must be gone by T + 10 ms.
  await expect.poll(() => win.evaluate(() => !!window.__ripperTest?.Engine)).toBe(true)
  const r = await win.evaluate(async () => {
    const { Engine } = window.__ripperTest
    const sr = 48000
    const T = 0.3
    const render = async (pads, mono) => {
      const d = new Float32Array(sr * 2)
      for (let i = 0; i < d.length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr) // loud, steady
      const e = new Engine(sr)
      e.setSource('main', [d], sr)
      const s1 = { start: 0, end: 1 }
      const s2 = { start: 1, end: 2, gain: -60 }
      if (pads.includes(1)) e.noteOn({ slice: s1, bank: 0, pad: 0, mono, frame: Math.round(0.1 * sr) })
      if (pads.includes(2)) e.noteOn({ slice: s2, bank: 0, pad: 1, mono, frame: Math.round(T * sr) })
      return e.render(sr)[0]
    }
    const peakAfter = async (mono) => {
      const both = await render([1, 2], mono)
      const two = await render([2], mono)
      let peak = 0
      for (let i = Math.round((T + 0.010) * sr); i < Math.round((T + 0.5) * sr); i++) peak = Math.max(peak, Math.abs(both[i] - two[i]))
      let before = 0
      for (let i = Math.round((T - 0.05) * sr); i < Math.round(T * sr); i++) before = Math.max(before, Math.abs(both[i] - two[i]))
      return { peak, before }
    }
    return { mono: await peakAfter(true), poly: await peakAfter(false) }
  })
  expect(r.mono.before).toBeGreaterThan(0.4) // pad 1 was really playing
  expect(r.mono.peak).toBeLessThan(1e-4)     // ...and is silent 10 ms after pad 2
  expect(r.poly.peak).toBeGreaterThan(0.4)   // control: in a poly bank it keeps ringing
})
