const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

function python() {
  if (process.env.RIPPER_PYTHON) return process.env.RIPPER_PYTHON
  const venv = process.platform === 'win32' ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python')
  return fs.existsSync(venv) ? venv : 'python3'
}

/** Generate the code-made fixtures (no downloads) and return their paths. */
function fixtures() {
  execFileSync(python(), ['-m', 'engine.tests.fixtures'], { cwd: ROOT, stdio: 'pipe' })
  const dir = path.join(ROOT, 'engine', 'tests', 'fixtures', 'generated')
  return { wav120: path.join(dir, 'beat_120.wav'), mp3: path.join(dir, 'beat_120.mp3') }
}

/** Re-read a WAV with python-soundfile and parse its ACID chunk. */
function inspectWav(file) {
  const code = [
    'import json, sys, soundfile as sf',
    'from engine.services.exporter import read_acid',
    'p = sys.argv[1]; info = sf.info(p); data, sr = sf.read(p, always_2d=True)',
    'print(json.dumps({"sr": sr, "channels": data.shape[1], "frames": data.shape[0], "subtype": info.subtype, "acid": read_acid(open(p, "rb").read())}))',
  ].join('\n')
  return JSON.parse(execFileSync(python(), ['-c', code, file], { cwd: ROOT }).toString())
}

function tempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-e2e-'))
  const d = (n) => { const p = path.join(base, n); fs.mkdirSync(p, { recursive: true }); return p }
  return { base, appData: d('appdata'), storage: d('storage'), userData: d('userdata'), downloads: d('downloads'), exports: d('exports') }
}

module.exports = { ROOT, fixtures, inspectWav, tempDirs, python }
