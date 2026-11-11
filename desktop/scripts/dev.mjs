// `npm run dev`: Vite (hot reload) + Electron pointing at it. The Electron main process
// spawns the Python engine from ../.venv (see README). Ctrl+C stops everything.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const require = createRequire(import.meta.url)
const URL_ = 'http://127.0.0.1:5173'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const vite = spawn(npm, ['run', 'dev', '-w', 'ui'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Vite dev server did not start at ${url}`)
}

let electron
const stop = () => { electron?.kill(); vite.kill(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

await waitFor(URL_)
electron = spawn(require('electron'), [path.join(root, 'desktop')], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: URL_, RIPPER_DEV: '1' },
})
electron.on('exit', (code) => { vite.kill(); process.exit(code ?? 0) })
