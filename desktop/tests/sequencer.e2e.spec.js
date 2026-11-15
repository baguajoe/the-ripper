// v1.2 phase 2: step sequencer (live timing, swing, note repeat, live record, chaining), MIDI
// controllers (a virtual MIDI device, velocity, MIDI learn that survives a restart) and vintage
// banks. Runs against the dev app and, in CI, the INSTALLED app on Windows and macOS.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv, inspectWav, pyJson, setWindowSize } = require('./helpers')

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

async function openTrack() {
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await expect(win.getByTestId('slice-count')).toHaveText('16 slices')
  await expect.poll(() => win.evaluate(() => !!window.__ripperTest?.player)).toBe(true)
}

test.beforeAll(async () => {
  dirs = tempDirs()
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  if (dirs) fs.rmSync(dirs.root, { recursive: true, force: true })
})

const step = (pad, s) => win.getByTestId(`step-${pad}-${s}`)
const tap = (loc) => loc.dispatchEvent('pointerdown').then(() => loc.dispatchEvent('pointerup'))
const transport = () => win.evaluate(() => window.__ripperTest.player.transport)

async function setBpm(bpm) {
  await win.getByTestId('bpm-input').fill(String(bpm))
  await win.getByTestId('bpm-apply').click()
  await expect(win.getByTestId('seq-bpm')).toHaveText(`${bpm} BPM`)
}

/** Play one pass (no loop) and return the sequencer's trigger frames + the context rate. */
async function firesOfOnePass() {
  await win.evaluate(() => window.__ripperTest.player.traceFires(true))
  await win.getByTestId('seq-play').click()
  await expect.poll(transport).toMatchObject({ playing: true })
  await expect.poll(transport, { timeout: 15_000 }).toMatchObject({ playing: false })
  return win.evaluate(async () => ({ fires: await window.__ripperTest.player.fires(), sr: window.__ripperTest.player.ctx.sampleRate }))
}

test('sequencer: steps play on the grid at 90 and 140 BPM, swing, chaining', async () => {
  const fx = fixtures()
  await win.getByTestId('file-input').setInputFiles(fx.wav120)
  await openTrack()
  await win.getByTestId('side-tab-seq').click()
  await expect(win.getByTestId('seq-grid')).toHaveAttribute('data-steps', '16')
  for (let s = 0; s < 16; s++) await tap(step(s % 4, s))
  await expect(step(1, 1)).toHaveAttribute('data-on', '1')
  await win.getByTestId('seq-loop').uncheck()

  for (const bpm of [90, 140]) {
    await setBpm(bpm)
    const { fires, sr } = await firesOfOnePass()
    expect(fires).toHaveLength(16)
    const t0 = fires[0].frame
    fires.forEach((f, s) => {
      expect(f.pad).toBe(s % 4)
      expect(Math.abs((f.frame - t0) / sr - (s * 15) / bpm)).toBeLessThan(0.001) // within 1 ms of the grid
    })
  }

  // swing 66%: every second 16th moves to 66% of its 8th
  await win.getByTestId('seq-swing').evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '66')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(win.getByTestId('seq-swing-value')).toHaveText('66%')
  let { fires, sr } = await firesOfOnePass()
  const eighth = 30 / 140
  fires.forEach((f, s) => {
    const grid = Math.floor(s / 2) * eighth + (s % 2 ? 0.66 * eighth : 0)
    expect(Math.abs((f.frame - fires[0].frame) / sr - grid)).toBeLessThan(0.001)
  })

  // pattern B (2 bars) chained after A: A A B in song mode
  await win.getByTestId('pattern-B').click()
  await win.getByTestId('seq-length').selectOption('32')
  await tap(step(5, 20))
  await win.getByTestId('pattern-A').click()
  await win.getByTestId('song-add').click()
  await win.getByTestId('song-add').click()
  await win.getByTestId('pattern-B').click()
  await win.getByTestId('song-add').click()
  await win.getByTestId('seq-mode-song').click()
  ;({ fires, sr } = await firesOfOnePass())
  expect(fires).toHaveLength(33)
  const b = fires[32]
  expect(b.pad).toBe(5)
  expect(Math.abs((b.frame - fires[0].frame) / sr - (32 + 20) * (15 / 140))).toBeLessThan(0.001)
  await win.getByTestId('seq-mode-pattern').click()
  await win.getByTestId('pattern-A').click()
  expect(consoleErrors).toEqual([])
})

test('note repeat, live record with quantize, overdub', async () => {
  await setBpm(120)
  // swing back to straight for the recording
  await win.getByTestId('seq-swing').evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '50')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // --- note repeat 1/16 while stopped: hold pad 3 for ~1 s => ~8 hits, 125 ms apart
  await win.getByTestId('seq-repeat').selectOption('1/16')
  await win.evaluate(() => window.__ripperTest.player.traceFires(true))
  await win.getByTestId('pad-2').dispatchEvent('mousedown', { button: 0 })
  await win.waitForTimeout(1000)
  await win.getByTestId('pad-2').dispatchEvent('mouseup', { button: 0 })
  await win.waitForTimeout(300)
  const { fires, sr } = await win.evaluate(async () => ({ fires: await window.__ripperTest.player.fires(), sr: window.__ripperTest.player.ctx.sampleRate }))
  expect(fires.length).toBeGreaterThanOrEqual(6)
  expect(fires.length).toBeLessThanOrEqual(11)
  for (let i = 1; i < fires.length; i++) expect(Math.abs((fires[i].frame - fires[i - 1].frame) / sr - 0.125)).toBeLessThan(0.0001)
  for (const r of ['1/8', '1/32', '1/8T', '1/16T']) await win.getByTestId('seq-repeat').selectOption(r) // every rate is offered
  await win.getByTestId('seq-repeat').selectOption('off')

  // --- live record, overdub off (replaces A), quantize 1/16: tap pads while it loops
  await win.getByTestId('seq-loop').check()
  await win.getByTestId('seq-overdub').uncheck()
  await win.getByTestId('seq-quantize').selectOption('1/16')
  await win.getByTestId('seq-record').click()
  await expect.poll(transport).toMatchObject({ playing: true, recording: true })
  for (const k of ['q', 'w', 'e']) { await win.keyboard.press(k); await win.waitForTimeout(260) }
  await win.getByTestId('seq-stop').click()
  await expect.poll(transport).toMatchObject({ playing: false })
  const notes = () => win.locator('[data-testid^="step-"][data-on="1"]').evaluateAll((els) => els.map((e) => e.dataset.testid))
  const rec = await notes()
  expect(rec.length).toBe(3) // the old pattern was replaced; three quantized hits
  expect(rec.map((t) => t.split('-')[1]).sort()).toEqual(['4', '5', '6']) // pads Q W E
  // undo removes the whole take (and brings the old pattern back)
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await notes()).length).toBe(16)
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expect.poll(async () => (await notes()).length).toBe(3)
  // overdub on: a new take adds to the pattern
  await win.getByTestId('seq-overdub').check()
  await win.getByTestId('seq-countin').check()
  await win.getByTestId('seq-record').click()
  await expect.poll(transport, { timeout: 5000 }).toMatchObject({ playing: true })
  await win.waitForTimeout(2100) // the count-in bar
  await win.keyboard.press('v')
  await win.waitForTimeout(200)
  await win.getByTestId('seq-stop').click()
  await expect.poll(async () => (await notes()).length).toBe(4)
  await win.getByTestId('seq-countin').uncheck()
  expect(consoleErrors).toEqual([])
})

test('MIDI: a virtual device plays pads with velocity; learn persists across a restart', async () => {
  const last = () => win.evaluate(() => window.__ripperDebug?.lastPad)
  await win.evaluate(() => { window.__vdev = window.__ripperTest.midi.addVirtualInput('Test Pad Controller') })
  await win.evaluate(() => window.__vdev.send([0x99, 37, 64])) // note 37 = pad 2 (default map 36-51)
  await expect.poll(last).toEqual({ bank: 0, pad: 1, vel: 64 })
  await win.evaluate(() => window.__vdev.send([0x89, 37, 0]))
  await win.evaluate(() => window.__vdev.send([0x99, 51, 127]))
  await expect.poll(last).toEqual({ bank: 0, pad: 15, vel: 127 })

  // learn: note 60 -> pad 6, CC 20 -> Play
  await win.getByTestId('midi-learn').click()
  await win.getByTestId('pad-5').dispatchEvent('mousedown', { button: 0 })
  await win.evaluate(() => window.__vdev.send([0x90, 60, 100]))
  await expect(win.getByTestId('midi-learn')).toContainText('pick a target')
  await win.getByTestId('seq-play').click()
  await win.evaluate(() => window.__vdev.send([0xb0, 20, 127]))
  await expect(win.getByTestId('midi-learn')).toContainText('pick a target')
  await win.getByTestId('midi-learn').click()
  await win.evaluate(() => window.__vdev.send([0x90, 60, 90]))
  await expect.poll(last).toEqual({ bank: 0, pad: 5, vel: 90 })
  await win.evaluate(() => window.__vdev.send([0xb0, 20, 127]))
  await expect.poll(transport).toMatchObject({ playing: true })
  await win.getByTestId('seq-stop').click()

  // restart the app: the learned map is still there
  await app.close()
  await launch()
  await openTrack()
  await win.evaluate(() => { window.__vdev = window.__ripperTest.midi.addVirtualInput('Test Pad Controller') })
  await win.evaluate(() => window.__vdev.send([0x90, 60, 33]))
  await expect.poll(last).toEqual({ bank: 0, pad: 5, vel: 33 })
  await win.evaluate(() => window.__vdev.send([0xb0, 20, 127]))
  await expect.poll(transport).toMatchObject({ playing: true })
  await win.getByTestId('stop-all').click()
  await expect.poll(transport).toMatchObject({ playing: false })
  expect(consoleErrors).toEqual([])
})

test('vintage bank: the export differs, same length, no clipping', async () => {
  const dl = async () => {
    const before = new Set(fs.readdirSync(dirs.downloads))
    await win.getByTestId('side-tab-slices').click()
    await win.getByTestId('slice-download-3').dispatchEvent('click')
    let f
    await expect.poll(() => { f = fs.readdirSync(dirs.downloads).find((x) => x.endsWith('.wav') && !before.has(x)); return !!f }, { timeout: 60_000 }).toBe(true)
    await win.waitForTimeout(200)
    const dest = path.join(dirs.exports, `v-${Date.now()}-${f}`)
    fs.renameSync(path.join(dirs.downloads, f), dest)
    return dest
  }
  const plain = await dl()
  for (const mode of ['12bit', '16bit']) {
    await win.getByTestId('bank-vintage').selectOption(mode)
    const v = await dl()
    const r = pyJson(`import json, sys, numpy as np, soundfile as sf
a = sf.read(sys.argv[1], always_2d=True)[0]; b = sf.read(sys.argv[2], always_2d=True)[0]
print(json.dumps({"same": a.shape == b.shape, "diff": float(np.max(np.abs(a - b))), "peak": float(np.max(np.abs(b)))}))`, plain, v)
    expect(r.same).toBe(true)
    expect(r.diff).toBeGreaterThan(0.001)
    expect(r.peak).toBeLessThan(1)
    expect(inspectWav(v).frames).toBe(inspectWav(plain).frames)
  }
  await win.getByTestId('bank-vintage').selectOption('off')
  expect(consoleErrors).toEqual([])
})
