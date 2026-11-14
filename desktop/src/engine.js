// Engine lifecycle for the desktop shell: reuse a healthy running engine (shared with plugin
// instances via engine.json) or spawn our own, wait for /api/v1/health, kill it on quit.
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { NOISY } = require('./supervisor')

const API = '/api/v1'

function appDataDir() {
  if (process.env.RIPPER_APP_DATA) return process.env.RIPPER_APP_DATA
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'TheRipper')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TheRipper')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'TheRipper')
}

function readEngineJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDataDir(), 'engine.json'), 'utf8'))
  } catch {
    return null
  }
}

async function health(port, timeoutMs = 1500) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${port}${API}/health`, { signal: ctl.signal })
    if (!r.ok) return null
    const body = await r.json()
    return body.ok ? body : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** How to launch the engine: bundled PyInstaller binary, or python -m engine in dev. */
function engineCommand({ packaged, resourcesPath, repoRoot }) {
  const exe = process.platform === 'win32' ? 'ripper-engine.exe' : 'ripper-engine'
  if (process.env.RIPPER_ENGINE_CMD) {
    return { cmd: process.env.RIPPER_ENGINE_CMD, args: [], cwd: repoRoot }
  }
  const bundled = packaged ? path.join(resourcesPath, 'engine', exe) : path.join(repoRoot, 'engine', 'dist', 'ripper-engine', exe)
  if (packaged || (process.env.RIPPER_USE_BUNDLED_ENGINE === '1' && fs.existsSync(bundled))) {
    return { cmd: bundled, args: [], cwd: path.dirname(bundled) }
  }
  const venvPy = process.platform === 'win32'
    ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(repoRoot, '.venv', 'bin', 'python')
  const py = process.env.RIPPER_PYTHON || (fs.existsSync(venvPy) ? venvPy : process.platform === 'win32' ? 'python' : 'python3')
  return { cmd: py, args: ['-m', 'engine'], cwd: repoRoot }
}

const START_TIMEOUT_MS = 180_000 // a cold first start on a slow Mac can take a minute or more

class EngineManager {
  /**
   * onStage(text): start-up progress for the splash screen.
   * engineLog(line): every line the engine prints (minus polling noise), for engine.log.
   * expectedVersion: only reuse an already-running engine of this version.
   */
  constructor({ packaged, resourcesPath, repoRoot, dev, log = console, onStage = () => {}, engineLog = () => {}, expectedVersion = null, logDir = null, onExit = () => {} }) {
    Object.assign(this, { packaged, resourcesPath, repoRoot, dev, log, onStage, engineLog, expectedVersion, logDir, onExit })
    this.child = null
    this.info = null
    this.spawned = false
    this.gen = 0
    this.stderrTail = []
  }

  get baseUrl() {
    return this.info ? `http://127.0.0.1:${this.info.port}` : null
  }

  /** Resolve {port, token, version, reused}. Throws Error with .code on failure. */
  async start() {
    if (process.env.RIPPER_ENGINE_NEW !== '1') {
      const existing = readEngineJson()
      if (existing?.port && existing.token) {
        const h = await health(existing.port)
        if (h && h.api === 'v1' && (!this.expectedVersion || h.version === this.expectedVersion)) {
          this.info = { ...existing, version: h.version, reused: true }
          this.log.info?.(`[engine] reusing running engine on :${existing.port} (pid ${existing.pid})`)
          return this.info
        }
      }
    }
    const { cmd, args, cwd } = engineCommand(this)
    const fullArgs = [...args, '--port', '0', '--parent-pid', String(process.pid)]
    if (process.env.RIPPER_ENGINE_NEW === '1') fullArgs.push('--new')
    this.log.info?.(`[engine] spawning ${cmd} ${fullArgs.join(' ')}`)
    this.engineLog(`--- spawning ${cmd} ${fullArgs.join(' ')}`)
    this.onStage('Starting the audio engine')
    const env = { ...process.env, PYTHONUNBUFFERED: '1' }
    if (this.dev) env.RIPPER_DEV = '1'
    if (this.logDir) env.RIPPER_LOG_DIR = this.logDir // engine-crash.log (faulthandler) goes next to engine.log
    const child = spawn(cmd, fullArgs, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.spawned = true
    this.stopping = false
    let started = false
    const gen = (this.gen = (this.gen || 0) + 1)

    const ready = new Promise((resolve, reject) => {
      const fail = (code, message) => {
        const e = new Error(message)
        e.code = code
        reject(e)
      }
      child.on('error', (err) => fail('spawn_failed', `Could not start the audio engine (${err.message}). ${this.dev ? 'Is the Python venv set up? See README.' : ''}`))
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null
        const hex = code !== null && code > 255 ? ` = 0x${(code >>> 0).toString(16).toUpperCase()}` : ''
        this.engineLog(`--- engine exited (code ${code}${hex}${signal ? `, ${signal}` : ''})`)
        if (started) {
          // After start-up: a crash or kill. Let the app restart it (unless we stopped it).
          if (!this.stopping && gen === this.gen) this.onExit({ code, signal, pid: child.pid })
          return
        }
        if (code === 3) fail('ffmpeg_missing', 'ffmpeg was not found on PATH.')
        else fail('engine_exited', `The audio engine exited (code ${code}).\n${this.stderrTail.slice(-8).join('\n')}`)
      })
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith('RIPPER_ENGINE_READY ')) this.engineLog(line) // READY carries the token
        if (line.startsWith('RIPPER_ENGINE_STAGE ')) this.onStage(line.slice(20))
        else if (line.startsWith('RIPPER_ENGINE_READY ')) resolve(JSON.parse(line.slice(20)))
        else if (line.startsWith('RIPPER_ENGINE_ERROR ')) {
          const e = JSON.parse(line.slice(20))
          fail(e.error, e.detail)
        } else console.log(`[engine] ${line}`) // console only: engineLog has it
      })
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        this.stderrTail.push(line)
        if (this.stderrTail.length > 50) this.stderrTail.shift()
        if (NOISY.test(line)) return
        this.engineLog(line)
        console.log(line)
      })
    })
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`The audio engine did not start within ${START_TIMEOUT_MS / 1000} s`), { code: 'timeout' })), START_TIMEOUT_MS)
    })
    let info
    try {
      info = await Promise.race([ready, timeout])
    } catch (err) {
      if (this.child) await this.stop().catch(() => {}) // don't leave a half-started engine behind
      throw err
    } finally {
      clearTimeout(timer)
    }
    if (info.reused) this.spawned = false // another engine won the race; ours exited
    this.onStage('Connecting')
    // Wait until it answers health.
    for (let i = 0; i < 100; i++) {
      if (await health(info.port)) {
        this.info = info
        started = true
        return info
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw Object.assign(new Error('The audio engine is not answering /api/v1/health'), { code: 'unhealthy' })
  }

  /** Stop the engine if we spawned it: graceful /shutdown, then kill. */
  async stop() {
    const child = this.child
    this.stopping = true
    if (!this.spawned || !child) return
    try {
      await fetch(`${this.baseUrl}${API}/shutdown`, { method: 'POST', headers: { 'X-Ripper-Token': this.info.token } })
    } catch { /* already gone */ }
    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true)
      const t = setTimeout(() => resolve(false), 3000)
      child.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    if (!exited) {
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
      else child.kill('SIGKILL')
    }
    this.child = null
  }

  async request(method, route, body) {
    const res = await fetch(`${this.baseUrl}${API}${route}`, {
      method,
      headers: { 'X-Ripper-Token': this.info.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      let err = {}
      try { err = await res.json() } catch { /* not json */ }
      const e = new Error(err.detail || err.error || `Engine error ${res.status}`)
      e.status = res.status
      throw e
    }
    return res
  }
}

module.exports = { EngineManager, appDataDir, readEngineJson, health }
