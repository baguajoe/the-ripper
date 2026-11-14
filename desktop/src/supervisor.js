// Small, pure helpers for keeping the app healthy; unit-tested in tests/unit/supervisor.test.js.
//  - RestartPolicy: auto-restart the engine, but give up after 3 restarts within a minute.
//  - Windows elevation: an app running as administrator can't receive drag-and-drop from
//    Explorer (Windows UIPI blocks it), so the app relaunches itself as the normal user.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

class RestartPolicy {
  constructor({ max = 3, windowMs = 60_000 } = {}) {
    this.max = max
    this.windowMs = windowMs
    this.history = []
  }

  /** Record a restart attempt at `now`; false if that would exceed max per window. */
  allow(now = Date.now()) {
    this.history = this.history.filter((t) => now - t < this.windowMs)
    if (this.history.length >= this.max) return false
    this.history.push(now)
    return true
  }

  reset() { this.history = [] }
}

// Mandatory integrity level SIDs in `whoami /groups`: High (elevated) and System.
const ELEVATED_SIDS = ['S-1-16-12288', 'S-1-16-16384']

function isElevatedOutput(whoamiGroups) {
  return ELEVATED_SIDS.some((sid) => String(whoamiGroups || '').includes(sid))
}

function isElevated({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'win32') return false
  try {
    return isElevatedOutput(run('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }))
  } catch {
    return false
  }
}

/**
 * If this process is elevated on Windows, relaunch the app through Explorer (which starts it
 * as the signed-in user, not elevated) and tell the caller to exit. A marker file stops a
 * loop on machines where Explorer itself is elevated (UAC off / built-in Administrator).
 * Returns 'relaunched' | 'elevated' (stay, but warn) | 'normal'.
 */
function deElevate({ platform = process.platform, env = process.env, execPath = process.execPath,
  markerFile, now = Date.now(), elevated = isElevated({ platform }), launch = defaultLaunch } = {}) {
  if (platform !== 'win32' || !elevated) return 'normal'
  if (env.RIPPER_ALLOW_ELEVATED === '1') return 'elevated'
  try {
    const last = Number(fs.readFileSync(markerFile, 'utf8'))
    if (Number.isFinite(last) && now - last < 30_000) return 'elevated' // we already tried
  } catch { /* no marker */ }
  try {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    fs.writeFileSync(markerFile, String(now))
    launch(execPath)
    return 'relaunched'
  } catch {
    return 'elevated'
  }
}

function defaultLaunch(execPath) {
  // explorer.exe "<app>.exe" runs the app at the shell's (non-elevated) integrity level.
  const child = spawn('explorer.exe', [execPath], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

// Engine log lines that are just the UI polling and succeeded. Failures are always logged.
const NOISY = /"(GET|OPTIONS) \/api\/v1\/(jobs|tracks|health)\S* HTTP\/[\d.]+" (200|204|206|304) /

module.exports = { RestartPolicy, isElevated, isElevatedOutput, deElevate, NOISY }
