// Where the app's helper programs are: ffmpeg, ffprobe (audio import) and Deno (yt-dlp link
// import). Mirrors engine/services/tools.py — override env var → bundled copy → PATH — so
// diagnostics can report what the engine will use even when the engine failed to start.
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ENV_OVERRIDE = { ffmpeg: 'RIPPER_FFMPEG', ffprobe: 'RIPPER_FFPROBE', deno: 'RIPPER_DENO' }
const VENDOR = { ffmpeg: 'ffmpeg', ffprobe: 'ffmpeg', deno: 'deno' } // desktop/vendor/<dir>/<os>
const BUNDLED = ['ffmpeg', 'ffprobe', 'deno']

const osKey = (platform) => (platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux')

function usable(p, platform) {
  try {
    if (!fs.statSync(p).isFile()) return false
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Folders holding the app's own copies: <resources>/engine when packaged, else desktop/vendor. */
function bundledDirs(name, { packaged, resourcesPath, repoRoot, platform = process.platform, env = process.env }) {
  const dirs = []
  if (env.RIPPER_BIN_DIR) dirs.push(env.RIPPER_BIN_DIR)
  if (packaged) dirs.push(path.join(resourcesPath, 'engine'))
  else if (repoRoot && VENDOR[name]) dirs.push(path.join(repoRoot, 'desktop', 'vendor', VENDOR[name], osKey(platform)))
  return dirs
}

/**
 * Resolve one tool. opts: { packaged, resourcesPath, repoRoot, platform, env, bundled? }
 * Returns { name, path, source: 'env'|'bundled'|'path' } or null.
 */
function findTool(name, opts = {}) {
  const platform = opts.platform || process.platform
  const env = opts.env || process.env
  const exe = name + (platform === 'win32' ? '.exe' : '')
  const override = ENV_OVERRIDE[name] && env[ENV_OVERRIDE[name]]
  if (override && usable(override, platform)) return { name, path: override, source: 'env' }
  for (const dir of opts.bundled || bundledDirs(name, { ...opts, platform, env })) {
    const p = path.join(dir, exe)
    if (usable(p, platform)) return { name, path: p, source: 'bundled' }
  }
  const pathVar = env.PATH ?? env.Path ?? ''
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const p = path.join(dir, exe)
    if (usable(p, platform)) return { name, path: p, source: 'path' }
  }
  return null
}

/** Every tool the diagnostics report mentions. */
function findAll(opts) {
  return Object.fromEntries(['ffmpeg', 'ffprobe', 'deno', 'node'].map((n) => [n, findTool(n, n === 'node' ? { ...opts, bundled: [] } : opts)]))
}

/**
 * macOS: make sure the bundled helpers can run from inside the app bundle. Files copied out
 * of a downloaded .dmg carry com.apple.quarantine, and exec'ing a quarantined CLI binary from
 * the app pops a Gatekeeper prompt (or is refused). Best effort: an app run read-only from
 * the dmg / App Translocation can't be changed, and then nothing here is needed anyway.
 */
async function prepareBundledTools({ resourcesPath, platform = process.platform, log = console }) {
  if (platform !== 'darwin') return
  const dir = path.join(resourcesPath, 'engine')
  const files = [...BUNDLED, 'ripper-engine'].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p))
  await Promise.all(files.map(async (f) => {
    try {
      const mode = fs.statSync(f).mode
      if ((mode & 0o111) !== 0o111) fs.chmodSync(f, mode | 0o755)
    } catch (e) { log.warn?.(`[tools] chmod ${f}: ${e.message}`) }
    await new Promise((resolve) => execFile('/usr/bin/xattr', ['-d', 'com.apple.quarantine', f], () => resolve()))
  }))
}

module.exports = { findTool, findAll, bundledDirs, prepareBundledTools, osKey }
