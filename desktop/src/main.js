// The Ripper — Electron main process.
// Spawns/reuses the Flask engine, serves the React build on ripper://app/, and owns every
// native action (drag-out to DAW, folder dialogs, saving files). The renderer only reaches
// these through the whitelisted IPC channels exposed by preload.js.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, net, protocol, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { EngineManager, health: engineHealth } = require('./engine')
const { createLogs } = require('./logs')
const tools = require('./tools')
const { RestartPolicy, deElevate } = require('./supervisor')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || null
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const UI_DIST = process.env.RIPPER_UI_DIST
  || (app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(REPO_ROOT, 'ui', 'dist'))
const APP_ORIGIN = 'ripper://app'
const DRAG_ROOT = path.join(app.getPath('temp'), 'TheRipper-drag')
const SETTINGS_KEYS = new Set(['exportOptions', 'exportFolder', 'downloadFolder'])

protocol.registerSchemesAsPrivileged([
  { scheme: 'ripper', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

if (process.env.RIPPER_USER_DATA) app.setPath('userData', process.env.RIPPER_USER_DATA)

// Windows: if we were started elevated (e.g. "Run as administrator", or by an elevated
// installer), Windows blocks drag-and-drop from Explorer into our window. Relaunch as the
// normal user before doing anything else (before taking the single-instance lock).
const elevation = deElevate({ markerFile: path.join(app.getPath('temp'), 'TheRipper-deelevate.txt') })
if (elevation === 'relaunched') {
  app.exit(0)
  process.exit(0)
}
if (!app.requestSingleInstanceLock()) app.quit()

// --- logs: <userData>/logs/{main,engine}.log, rotated, 10 MB max ----------------------------------
const logs = createLogs(path.join(app.getPath('userData'), 'logs'))
const log = {
  info: (...a) => { console.log(...a); logs.app.write(a.join(' ')) },
  warn: (...a) => { console.warn(...a); logs.app.write(`WARN ${a.join(' ')}`) },
  error: (...a) => { console.error(...a); logs.app.write(`ERROR ${a.join(' ')}`) },
}
process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack || e}`))
process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${e?.stack || e}`))

// --- engine + start-up status (shown by the renderer's splash / error screen) ----------------------
// state: starting -> ready; ready -> restarting (crash / hang) -> ready; any -> failed.
// generation goes up every time a (new) engine becomes ready, so the UI knows to reconnect.
const status = { state: 'starting', stage: 'Starting', startedAt: Date.now(), readyAt: null, error: null, generation: 0, restarts: 0, lastExit: null }
const restartPolicy = new RestartPolicy({ max: 3, windowMs: 60_000 })
function setStatus(patch) {
  Object.assign(status, patch)
  if (win && !win.isDestroyed()) win.webContents.send('engine:status', { ...status })
}

const engine = new EngineManager({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: REPO_ROOT,
  dev: !!DEV_URL,
  log,
  expectedVersion: app.getVersion(),
  onStage: (stage) => setStatus({ stage }),
  engineLog: (line) => logs.engine.write(line),
  logDir: logs.dir,
  onExit: ({ code, signal }) => engineDown(`exited (code ${code}${code > 255 ? ` = 0x${(code >>> 0).toString(16).toUpperCase()}` : ''}${signal ? `, ${signal}` : ''})`),
})
globalThis.__ripperEngine = engine // e2e: the engine-kill test reads engine.child.pid
let win = null
let quitting = false
let engineReady = null // Promise<info>; the window opens immediately and the UI waits on this

const toolOpts = () => ({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: REPO_ROOT })

/** Plain-text report a tester can paste to us: versions, OS, tools found, log tails. */
async function diagnostics() {
  const found = tools.findAll(toolOpts())
  const fmt = (t) => (t ? `${t.path}  (${t.source === 'path' ? 'system PATH' : t.source})` : 'NOT FOUND')
  let health = null
  if (status.state === 'ready' && engine.baseUrl) {
    try { health = await (await fetch(`${engine.baseUrl}/api/v1/health`)).json() } catch { /* engine gone */ }
  }
  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`
  return [
    '=== The Ripper diagnostics ===',
    `App version:   ${app.getVersion()}${app.isPackaged ? '' : ' (dev)'}`,
    `OS:            ${os.type()} ${os.release()} (${process.platform} ${process.arch})${os.version ? ` — ${os.version()}` : ''}`,
    `Electron:      ${process.versions.electron} (Chrome ${process.versions.chrome}, Node ${process.versions.node})`,
    `Memory:        ${(os.totalmem() / 2 ** 30).toFixed(1)} GB, ${os.cpus().length} CPUs`,
    `Engine:        ${status.state}${status.restarts ? ` (auto-restarted ${status.restarts}x, last: ${status.lastExit})` : ''}${status.state === 'starting' ? ` — ${status.stage} (${secs(Date.now() - status.startedAt)})` : ''}`
      + `${status.readyAt ? ` — started in ${secs(status.readyAt - status.startedAt)}` : ''}`
      + `${engine.info ? ` — v${engine.info.version}, port ${engine.info.port}${engine.info.reused ? ', reused' : ''}` : ''}`,
    ...(status.error ? [`Engine error:  [${status.error.code}] ${status.error.message}`] : []),
    `ffmpeg:        ${fmt(found.ffmpeg)}`,
    `ffprobe:       ${fmt(found.ffprobe)}`,
    `deno:          ${fmt(found.deno)}`,
    `node:          ${fmt(found.node)}`,
    ...(health ? [`Engine sees:   ${JSON.stringify(health.tools)} demucs=${health.demucs_available}`] : []),
    `Log folder:    ${logs.dir}`,
    `Generated:     ${new Date().toISOString()}`,
    '',
    '--- engine log (last 60 lines) ---',
    ...logs.engine.tail(60),
    '',
    '--- app log (last 25 lines) ---',
    ...logs.app.tail(25),
    '',
    '--- engine crash traces (engine-crash.log, last 40 lines) ---',
    ...crashTail(40),
  ].join('\n')
}

/** faulthandler output from native crashes in the engine or its workers (engine/runtime.py). */
function crashTail(n) {
  try {
    const lines = fs.readFileSync(path.join(logs.dir, 'engine-crash.log'), 'utf8').split(/\r?\n/).filter((l) => l.trim())
    return lines.length ? lines.slice(-n) : ['(none)']
  } catch {
    return ['(none)']
  }
}

async function copyDiagnostics() {
  const text = await diagnostics()
  clipboard.writeText(text)
  return text
}

function openLogFolder() {
  fs.mkdirSync(logs.dir, { recursive: true })
  return shell.openPath(logs.dir)
}

// --- settings (tiny JSON store in userData) -------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} }
}
function saveSetting(key, value) {
  const s = loadSettings()
  s[key] = value
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
}

// --- temp drag folder ----------------------------------------------------------------------------
function cleanDragRoot() {
  try { fs.rmSync(DRAG_ROOT, { recursive: true, force: true }) } catch { /* in use */ }
}

const renderCache = new Map() // spec hash -> { promise, files|null }
let pendingRenders = 0
const DRAG_READY_MS = 400 // dragstart can only wait this long; the mouse may be released after

function specKey(spec) {
  return crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 16)
}

function validSpec(spec) {
  return spec && typeof spec === 'object' && typeof spec.trackId === 'string' && /^[a-f0-9]{32}$/.test(spec.trackId)
    && ['slice', 'slices', 'stem', 'kit', 'midi'].includes(spec.kind)
}

/** Ask the engine to render a DragSpec into dir. Returns absolute file paths. */
async function renderSpec(spec, dir, extra = {}) {
  await engineReady
  fs.mkdirSync(dir, { recursive: true })
  const res = await engine.request('POST', `/tracks/${spec.trackId}/render`, {
    kind: spec.kind,
    slices: spec.slices || [],
    stems: spec.kind === 'stem' ? spec.stems : spec.kind === 'kit' ? 'all' : undefined,
    include_midi: spec.kind === 'kit',
    ...(spec.options || {}),
    dest_dir: dir,
    ...extra,
  })
  return (await res.json()).files
}

function prepareDrag(spec) {
  if (!validSpec(spec)) return Promise.reject(new Error('Invalid drag'))
  const key = specKey(spec)
  let entry = renderCache.get(key)
  if (!entry) {
    entry = { files: null, promise: null }
    pendingRenders++
    entry.promise = renderSpec(spec, path.join(DRAG_ROOT, key))
      .then((files) => { entry.files = files; return files })
      .catch((e) => { renderCache.delete(key); throw e })
      .finally(() => { pendingRenders--; globalThis.__ripperPendingRenders = pendingRenders })
    renderCache.set(key, entry)
    globalThis.__ripperPendingRenders = pendingRenders
    if (renderCache.size > 200) renderCache.delete(renderCache.keys().next().value)
  }
  return entry.promise
}

/** Files for a drag if they're ready within DRAG_READY_MS, else null. */
async function filesForDrag(spec) {
  const p = prepareDrag(spec)
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), DRAG_READY_MS))
  return Promise.race([p, timeout])
}

// drag.png is asarUnpack'ed (see electron-builder.yml); macOS startDrag rejects an empty icon.
const FALLBACK_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mP4H2P5nxLMMGrAqAGjBgwXAwD79pMfwdge6QAAAABJRU5ErkJggg=='
let cachedIcon = null
function dragIcon() {
  if (cachedIcon) return cachedIcon
  const p = path.join(__dirname, '..', 'assets', 'drag.png').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  let img = nativeImage.createFromPath(p)
  if (img.isEmpty()) img = nativeImage.createFromDataURL(FALLBACK_ICON)
  cachedIcon = img
  return img
}

// --- IPC -------------------------------------------------------------------------------------------
function trustedSender(event) {
  const url = event.senderFrame?.url || ''
  return url.startsWith(`${APP_ORIGIN}/`) || (DEV_URL && url.startsWith(DEV_URL))
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    return fn(event, ...args)
  })
}

function registerIpc() {
  handle('engine:get', async () => {
    await engineReady
    return { baseUrl: engine.baseUrl, token: engine.info.token, version: engine.info.version }
  })
  handle('engine:status', () => ({ ...status }))
  handle('engine:retry', () => { if (status.state === 'failed') { restartPolicy.reset(); startEngine() } })
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, logDir: logs.dir, elevated: elevation === 'elevated' }))
  handle('diag:copy', () => copyDiagnostics())
  handle('diag:openLogs', async () => { await openLogFolder() })

  handle('drag:prepare', async (_e, spec) => ({ files: await prepareDrag(spec) }))

  // dragstart must be answered quickly: the file was normally pre-rendered on hover.
  // Never call startDrag late — if the mouse was already released, some platforms (X11)
  // block in the native drag loop. Ask the user to drag again instead.
  ipcMain.on('drag:start', async (event, spec) => {
    if (!trustedSender(event)) return
    try {
      const files = await filesForDrag(spec)
      if (!files) {
        globalThis.__ripperLastDrag = { spec, error: 'not_ready', at: Date.now() }
        event.sender.send('host:error', 'Still preparing that file — drag again in a moment.')
        return
      }
      if (!files.length) return
      globalThis.__ripperLastDrag = { spec, files, at: Date.now() }
      if (process.env.RIPPER_E2E_FAKE_OS_DRAG === '1') return // e2e on macOS/Windows: no OS drag loop
      const icon = dragIcon()
      event.sender.startDrag(files.length === 1 ? { file: files[0], icon } : { file: files[0], files, icon })
    } catch (err) {
      globalThis.__ripperLastDrag = { spec, error: err.message, at: Date.now() }
      event.sender.send('host:error', `Drag failed: ${err.message}`)
    }
  })

  handle('dialog:pickFolder', async () => {
    const s = loadSettings()
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose export folder',
      defaultPath: s.exportFolder || app.getPath('music'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (r.canceled || !r.filePaths[0]) return null
    saveSetting('exportFolder', r.filePaths[0])
    return r.filePaths[0]
  })

  handle('export:toFolder', async (_e, spec) => {
    if (!validSpec(spec)) throw new Error('Invalid export')
    let folder = process.env.RIPPER_EXPORT_DIR || loadSettings().exportFolder
    if (!folder || !fs.existsSync(folder)) {
      const r = await dialog.showOpenDialog(win, { title: 'Export to folder', properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      folder = r.filePaths[0]
      saveSetting('exportFolder', folder)
    }
    const files = await renderSpec(spec, folder, { subfolder: spec.subfolder, folders: spec.kind === 'kit' })
    return { files, folder }
  })

  handle('export:download', async (_e, req) => {
    if (!req || typeof req.path !== 'string' || !req.path.startsWith('/tracks/') || typeof req.filename !== 'string') {
      throw new Error('Invalid download')
    }
    await engineReady
    const dir = process.env.RIPPER_DOWNLOAD_DIR || loadSettings().downloadFolder || app.getPath('downloads')
    fs.mkdirSync(dir, { recursive: true })
    const res = await engine.request('POST', req.path, req.body || {})
    const name = path.basename(req.filename).replace(/[<>:"/\\|?*]/g, '-') || 'export.bin'
    let target = path.join(dir, name)
    for (let i = 2; fs.existsSync(target); i++) {
      const ext = path.extname(name)
      target = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`)
    }
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()))
    return { path: target }
  })

  handle('shell:showItem', (_e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) shell.showItemInFolder(p)
  })

  handle('settings:get', (_e, key) => (SETTINGS_KEYS.has(key) ? loadSettings()[key] ?? null : null))
  handle('settings:set', (_e, key, value) => {
    if (!SETTINGS_KEYS.has(key)) throw new Error('Unknown setting')
    saveSetting(key, value)
  })
}

// --- window ----------------------------------------------------------------------------------------
function serveUi() {
  protocol.handle('ripper', (req) => {
    const { pathname } = new URL(req.url)
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
    let file = path.normalize(path.join(UI_DIST, rel))
    if (!file.startsWith(path.normalize(UI_DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      rel = 'index.html'
      file = path.join(UI_DIST, rel)
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0e1014',
    title: 'The Ripper',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false, // keep transport/pads responsive while the DAW has focus
    },
  })
  win.once('ready-to-show', () => win.show())
  if (process.env.RIPPER_LOG_RENDERER === '1') {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN) && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault()
  })
  win.loadURL(DEV_URL || `${APP_ORIGIN}/index.html`)
  win.on('closed', () => { win = null })
}

// --- menu --------------------------------------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const copyDiag = async () => {
    await copyDiagnostics()
    dialog.showMessageBox(win, { type: 'info', message: 'Diagnostics copied', detail: 'Paste them into your message to us. They include the app version, your OS, which helper tools were found and the end of the engine log.' })
  }
  const help = [
    { label: 'Open Log Folder', click: () => openLogFolder() },
    { label: 'Copy Diagnostics', click: copyDiag },
    ...(isMac ? [] : [{ type: 'separator' }, { label: 'About The Ripper', click: () => win?.webContents.send('app:showAbout') }]),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: help },
  ]))
  app.setAboutPanelOptions({ applicationName: 'The Ripper', applicationVersion: app.getVersion(), version: '', copyright: 'Copyright © 2026 The Ripper' })
}

// --- engine start-up ------------------------------------------------------------------------------
function startEngine({ restart = false } = {}) {
  setStatus({ state: restart ? 'restarting' : 'starting', stage: restart ? 'Restarting the audio engine' : 'Starting', startedAt: Date.now(), readyAt: null, error: null })
  log.info(`[app] The Ripper ${app.getVersion()} on ${process.platform} ${process.arch} (${os.release()}) — starting engine`)
  for (const t of Object.values(tools.findAll(toolOpts()))) if (t) log.info(`[app] found ${t.name}: ${t.path} (${t.source})`)
  const prep = app.isPackaged ? tools.prepareBundledTools({ resourcesPath: process.resourcesPath, log }) : Promise.resolve()
  engineReady = prep.then(() => engine.start())
  engineReady.then(
    (info) => {
      setStatus({ state: 'ready', stage: 'Ready', readyAt: Date.now(), generation: status.generation + 1 })
      healthFailures = 0
      log.info(`[app] engine ready on :${info.port} after ${((status.readyAt - status.startedAt) / 1000).toFixed(1)} s${info.reused ? ' (reused)' : ''}`)
    },
    (err) => {
      log.error(`[engine] failed to start: ${err.code || ''} ${err.message}`)
      setStatus({ state: 'failed', error: { code: err.code || 'unknown', message: err.message } })
      // Only when the bundled copy AND PATH both came up empty (the engine checks both).
      if (err.code === 'ffmpeg_missing') {
        dialog.showErrorBox('ffmpeg is required',
          'The Ripper could not find its built-in copy of ffmpeg, and there is none installed on this computer.\n\n'
          + 'Reinstalling The Ripper should fix this. If it keeps happening, use Help → Copy Diagnostics and send us the result.')
      }
    },
  )
  engineReady.catch(() => {}) // handled above; IPC callers get the rejection themselves
}

// --- engine supervision: restart it if it dies or stops answering -----------------------------
let healthFailures = 0
let restartTimer = null

async function engineDown(reason) {
  if (status.state !== 'ready' || quitting) return
  log.error(`[engine] ${reason} — restarting it`)
  logs.engine.write(`--- engine down: ${reason}`)
  setStatus({ state: 'restarting', stage: 'Restarting the audio engine', lastExit: reason })
  await engine.stop().catch(() => {}) // a hung engine is killed; a dead one is a no-op
  if (!restartPolicy.allow()) {
    setStatus({ state: 'failed', error: { code: 'crash_loop', message: `The audio engine stopped 3 times within a minute (last: ${reason}).` } })
    return
  }
  status.restarts += 1
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => startEngine({ restart: true }), 500)
}

function watchEngineHealth() {
  setInterval(async () => {
    if (status.state !== 'ready' || !engine.info) return
    const port = engine.info.port
    const ok = await engineHealth(port, 2500)
    if (status.state !== 'ready' || engine.info?.port !== port) return
    healthFailures = ok ? 0 : healthFailures + 1
    if (healthFailures >= 2) engineDown('stopped answering /health')
  }, 2500).unref()
}

async function boot() {
  cleanDragRoot()
  fs.mkdirSync(DRAG_ROOT, { recursive: true })
  serveUi()
  registerIpc()
  buildMenu()
  // Open the window right away: the UI shows a "Starting The Ripper…" screen with progress
  // until the engine is up (a cold first start of Python + librosa can take a while), or a
  // friendly error with "Copy diagnostics" if it fails.
  startEngine()
  createWindow()
  watchEngineHealth()
  if (elevation === 'elevated') log.warn('[app] running elevated (as administrator): drag-and-drop from Explorer is blocked by Windows')
}

app.whenReady().then(boot)

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
})
app.on('window-all-closed', () => app.quit())
app.on('activate', () => { if (!win && engineReady) createWindow() })
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  engine.stop().finally(() => {
    cleanDragRoot()
    app.exit(0)
  })
})
