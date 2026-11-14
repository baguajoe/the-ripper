// v1.1.1 end-to-end: what broke on a real Windows PC, proven fixed in the real app (and, in
// CI, in the INSTALLED app on Windows and macOS):
//   - user folders with a space and a period ("J. Test"), 24-core thread settings
//   - a 4-minute song and an MP4 of it import + analyze in < 60 s with the right BPM and key
//   - drop-in: highlight on drag-over, unsupported types and audio-less videos explained
//   - a native crash in analysis fails only that job (error + Retry), the engine stays up
//   - killing the engine: the app restarts it, the dot goes red then green, library reloads
const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')
const { ROOT, fixtures, tempDirs, appEnv, MANY_CORES_ENV } = require('./helpers')

test.setTimeout(900_000)

const SONG_BPM = 126
const SONG_KEY = 'Em'

let app
let win
let dirs
let crashFile
const consoleErrors = []

test.beforeAll(async () => {
  dirs = tempDirs()
  crashFile = path.join(dirs.base, 'crash-next.txt')
  const packaged = process.env.RIPPER_E2E_EXECUTABLE
  app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [...(packaged ? [] : [path.join(ROOT, 'desktop')]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: appEnv(dirs, { ...MANY_CORES_ENV, RIPPER_TEST_CRASH_FILE: crashFile, RIPPER_E2E_FAKE_OS_DRAG: '1' }),
  })
  app.process().stdout?.on('data', (d) => process.stdout.write(`[app] ${d}`))
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

const cardByTitle = (title) => win.locator('[data-testid^="track-card-"]').filter({ has: win.getByTestId('track-title').getByText(title, { exact: true }) })
const errorToasts = () => win.getByTestId('toast-error')

/** Fire a synthetic OS-style file drop (real File objects in a DataTransfer) at the window. */
async function dragFilesOver(files) {
  await win.evaluate((list) => {
    const dt = new DataTransfer()
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
      dt.items.add(new File([bytes], f.name, { type: f.type || '' }))
    }
    window.__testDrop = dt
    const target = document.querySelector('[data-testid="track-grid"]') || document.body
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, files.map((f) => ({ name: f.name, type: f.type, b64: fs.readFileSync(f.path).toString('base64') })))
}
async function dropNow() {
  await win.evaluate(() => {
    const target = document.querySelector('[data-testid="track-grid"]') || document.body
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__testDrop }))
  })
}

async function waitReady(title, started) {
  const card = cardByTitle(title)
  await expect(card).toHaveAttribute('data-status', /ready|error/, { timeout: 120_000 })
  const secs = (Date.now() - started) / 1000
  await expect(card.getByTestId('track-error')).toHaveCount(0)
  await expect(card).toHaveAttribute('data-status', 'ready')
  return { card, secs }
}

test('4-min song + MP4 import fast and right; drop-in; crash recovery; engine restart', async () => {
  const fx = fixtures()
  // file names with spaces + periods, inside the "J. Test" folder
  const songPath = path.join(dirs.base, 'My Song. v1.wav')
  fs.copyFileSync(fx.song, songPath)

  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
  const health = await win.evaluate(async () => {
    const e = await window.ripper.getEngine()
    return (await fetch(`${e.baseUrl}/api/v1/health`)).json()
  })
  // 24 simulated cores, 24-thread settings in the environment -> every pool capped at 8
  expect(health.threads).toMatchObject({ cpus: 24, cap: 8, OMP_NUM_THREADS: '8', OPENBLAS_NUM_THREADS: '8', MKL_NUM_THREADS: '8', NUMBA_NUM_THREADS: '8', VECLIB_MAXIMUM_THREADS: '8' })
  expect(health.workers.isolated).toBe(true)
  if (process.env.RIPPER_E2E_EXPECT_BUNDLED === '1') {
    expect(health.tools).toMatchObject({ ffmpeg: 'bundled', ffprobe: 'bundled' })
  }
  await expect(win.getByTestId('library-empty')).toBeVisible()

  // --- 4-minute song (Browse…)
  let t0 = Date.now()
  await win.getByTestId('file-input').setInputFiles(songPath)
  const song = await waitReady('My Song. v1', t0)
  console.log(`4-min WAV: imported + analyzed in ${song.secs.toFixed(1)} s`)
  expect(song.secs).toBeLessThan(60)
  await expect(song.card.getByTestId('track-bpm')).toHaveText(`${SONG_BPM} BPM`)
  await expect(song.card.getByTestId('track-key')).toHaveText(SONG_KEY)

  // --- the same song as an MP4, dropped onto the window: highlight, then import
  await dragFilesOver([{ path: fx.mp4, name: 'My Video. v1.mp4', type: 'video/mp4' }])
  await expect(win.getByTestId('drop-overlay')).toBeVisible()
  t0 = Date.now()
  await dropNow()
  await expect(win.getByTestId('drop-overlay')).toHaveCount(0)
  const vid = await waitReady('My Video. v1', t0)
  console.log(`4-min MP4: imported + analyzed in ${vid.secs.toFixed(1)} s`)
  expect(vid.secs).toBeLessThan(60)
  await expect(vid.card.getByTestId('track-bpm')).toHaveText(`${SONG_BPM} BPM`)
  await expect(vid.card.getByTestId('track-key')).toHaveText(SONG_KEY)
  // only the extracted audio is kept, never the video
  const vidId = (await vid.card.getAttribute('data-testid')).replace('track-card-', '')
  expect(fs.readdirSync(path.join(dirs.storage, vidId)).sort()).toEqual(['meta.json', 'source.wav'])

  // the library loaded and refreshed the whole time without a single error toast
  await expect(errorToasts()).toHaveCount(0)

  // --- export kit from the 4-minute song (4-bar slices + stems + MIDI)
  await song.card.click()
  await expect(win.getByTestId('editor')).toBeVisible()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await win.getByTestId('chop-mode-grid').click()
  await win.getByTestId('chop-division').selectOption('4bar')
  await win.getByTestId('chop-apply').click()
  const nSlices = Number((await win.getByTestId('slice-count').textContent()).match(/\d+/)[0])
  expect(nSlices).toBeGreaterThanOrEqual(30)
  await win.getByTestId('export-kit').click()
  await expect(win.getByTestId('toast-success').filter({ hasText: '_Kit.zip' })).toBeVisible({ timeout: 300_000 })
  const zipName = fs.readdirSync(dirs.downloads).find((f) => f.endsWith('_Kit.zip'))
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dirs.downloads, zipName)))
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  expect(names.filter((n) => n.startsWith('Slices/'))).toHaveLength(nSlices)
  expect(names.filter((n) => n.startsWith('Stems/'))).toHaveLength(4)
  expect(names.filter((n) => n.endsWith('.mid'))).toHaveLength(1)
  expect(zipName).toContain(`${SONG_BPM}bpm_${SONG_KEY}`)
  await expect(errorToasts()).toHaveCount(0)
  await win.getByTestId('nav-home').click()

  // --- drop-in errors: unsupported type, and a video with no audio track
  await dragFilesOver([{ path: fx.txt, name: 'notes.txt', type: 'text/plain' }])
  await dropNow()
  await expect(errorToasts().filter({ hasText: 'notes.txt: unsupported file type' })).toBeVisible()
  await dragFilesOver([{ path: fx.mp4NoAudio, name: 'Silent clip.mp4', type: 'video/mp4' }])
  await dropNow()
  await expect(errorToasts().filter({ hasText: 'Silent clip.mp4' }).filter({ hasText: 'no audio track' })).toBeVisible({ timeout: 30_000 })
  await expect(cardByTitle('Silent clip')).toHaveCount(0)

  // --- crash recovery: the next analysis crashes natively (a real access violation / SIGSEGV)
  fs.writeFileSync(crashFile, 'import_file')
  const crashPath = path.join(dirs.base, 'Crash me. v1.wav')
  fs.copyFileSync(fx.wav120, crashPath)
  await win.getByTestId('file-input').setInputFiles(crashPath)
  const crashed = cardByTitle('Crash me. v1')
  await expect(crashed).toHaveAttribute('data-status', 'error', { timeout: 60_000 })
  await expect(crashed.getByTestId('track-error')).toContainText('crashed')
  await expect(crashed.getByTestId('track-retry')).toBeVisible()
  expect(fs.existsSync(crashFile)).toBe(false) // the hook really fired
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true') // engine still up
  await expect(cardByTitle('My Song. v1')).toHaveAttribute('data-status', 'ready')
  await crashed.getByTestId('track-retry').click()
  await expect(crashed).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  await expect(crashed.getByTestId('track-bpm')).toHaveText('120 BPM')
  const crashLog = path.join(dirs.userData, 'logs', 'engine-crash.log')
  expect(fs.readFileSync(crashLog, 'utf8')).toMatch(/Fatal Python error|Windows fatal exception/)

  // --- engine kill: the app notices, restarts it, dot red -> green, library reloads
  const pid = await app.evaluate(() => globalThis.__ripperEngine?.child?.pid)
  expect(pid).toBeTruthy()
  process.kill(pid, 'SIGKILL')
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'false', { timeout: 15_000 })
  await expect(win.getByTestId('engine-restarting')).toBeVisible()
  await expect(win.getByTestId('engine-status')).toHaveAttribute('data-ok', 'true', { timeout: 180_000 })
  await expect(win.getByTestId('toast-success').filter({ hasText: 'Audio engine restarted' })).toBeVisible()
  const newPid = await app.evaluate(() => globalThis.__ripperEngine?.child?.pid)
  expect(newPid).toBeTruthy()
  expect(newPid).not.toBe(pid)
  // the library reloads from the new engine: every track is still there and ready
  for (const t of ['My Song. v1', 'My Video. v1', 'Crash me. v1']) {
    await expect(cardByTitle(t)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
  }
  // and the new engine works: open the song (fetches audio over the new port + token)
  await cardByTitle('My Song. v1').click()
  await expect(win.getByTestId('waveform')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })

  const unexpected = consoleErrors.filter((e) => !/Failed to load resource|net::ERR_CONNECTION_REFUSED|status of 4\d\d/.test(e))
  expect(unexpected).toEqual([])
})
