// Run Python from the repo venv (falls back to python3/python): node scripts/py.mjs <args>
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const venv = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python')
const py = process.env.RIPPER_PYTHON || (existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3')
const r = spawnSync(py, process.argv.slice(2), { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
