// Editor layout: fits the window (no page scroll at 1280x800 and up), and nothing moves while
// playing - not the page scroll position, not the layout - even with pads being hit.
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, fixtures, tempDirs, appEnv } = require('./helpers')

test.setTimeout(300_000)

let app
let win
let dirs

test.beforeAll(async () => {
  dirs = tempDirs()
  const packaged = process.env.RIPPER_E2E_EXECUTABLE
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [path.join(ROOT, 'desktop')]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: appEnv(dirs, { RIPPER_E2E_FAKE_OS_DRAG: '1' }),
  })
  win = await app.firstWindow({ timeout: 60_000 })
})

test.afterAll(async () => {
  await app?.close()
  if (dirs) fs.rmSync(dirs.root, { recursive: true, force: true })
})

const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h])

/** Page scroll state + the position/size of everything that could move. */
const snapshot = () => win.evaluate(() => {
  const c = document.querySelector('.content')
  const d = document.scrollingElement || document.documentElement
  const rect = (sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect()
    return r ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2) : null
  }
  return {
    scroll: { contentTop: c.scrollTop, contentLeft: c.scrollLeft, pageX: window.scrollX, pageY: window.scrollY, docTop: d.scrollTop },
    overflow: { v: c.scrollHeight - c.clientHeight, h: c.scrollWidth - c.clientWidth, docV: d.scrollHeight - d.clientHeight, docH: d.scrollWidth - d.clientWidth },
    layout: Object.fromEntries(['.editor-head', '.waveform-wrap', '.transport', '[data-testid=play-toggle]', '[data-testid=playhead]',
      '[data-testid=loop-toggle]', '[data-testid=zoom]', '[data-testid=slice-count]', '.chop-controls', '.padgrid', '[data-testid=pad-0]',
      '[data-testid=pad-15]', '.export-panel', '.slices-panel'].map((s) => [s, rect(s)])),
  }
})

test('editor fits the window and nothing moves during 10 s of playback', async () => {
  const fx = fixtures()
  await setSize(1280, 800)
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
  await win.getByTestId('file-input').setInputFiles(fx.wav120) // 12 s, so 10 s of playback fits
  const card = win.locator('[data-testid^="track-card-"]').first()
  await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await card.click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await win.getByTestId('chop-division').selectOption('1/2') // 24 slices: a scrolling slice list
  await win.getByTestId('chop-apply').click()
  await win.waitForTimeout(500)

  // --- fits: no page scroll at 1280x800 or bigger; the waveform + pads grow instead
  const small = await snapshot()
  expect(small.overflow).toEqual({ v: 0, h: 0, docV: 0, docH: 0 })
  await setSize(1920, 1080)
  await win.waitForTimeout(700)
  const big = await snapshot()
  expect(big.overflow).toEqual({ v: 0, h: 0, docV: 0, docH: 0 })
  expect(big.layout['.waveform-wrap'][3]).toBeGreaterThan(small.layout['.waveform-wrap'][3])
  expect(big.layout['[data-testid=pad-0]'][3]).toBeGreaterThan(small.layout['[data-testid=pad-0]'][3])
  await setSize(1280, 800)
  await win.waitForTimeout(700)
  // the slice list scrolls inside its own panel
  expect(await win.getByTestId('slice-list').evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true)

  // --- play for 10 s, hitting pads by mouse and keyboard; sample 4x a second
  const before = await snapshot()
  expect(before.scroll).toEqual({ contentTop: 0, contentLeft: 0, pageX: 0, pageY: 0, docTop: 0 })
  await win.keyboard.press('Space')
  await expect(win.getByTestId('play-toggle')).toContainText('Pause')
  const started = Date.now()
  const samples = []
  let i = 0
  while (Date.now() - started < 10_000) {
    if (i % 4 === 1) await win.getByTestId(`pad-${i % 16}`).dispatchEvent('mousedown', { button: 0 })
    if (i % 4 === 3) await win.keyboard.press(['1', 'q', 'a', 'z', 'v'][i % 5])
    await win.waitForTimeout(250)
    samples.push(await snapshot())
    i++
  }
  const t = (await win.getByTestId('playhead').textContent()).split(' / ')[0]
  expect(t >= '0:09.0').toBe(true) // it really played ~10 s
  await win.keyboard.press('Space')
  samples.push(await snapshot()) // after pausing (Pause -> Play label) too

  expect(samples.length).toBeGreaterThanOrEqual(30)
  for (const s of samples) {
    expect(s.scroll).toEqual(before.scroll)
    expect(s.overflow).toEqual(before.overflow)
    expect(s.layout).toEqual(before.layout)
  }
})
