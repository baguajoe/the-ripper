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
  return {
    wav120: path.join(dir, 'beat_120.wav'),
    mp3: path.join(dir, 'beat_120.mp3'),
    song: path.join(dir, 'song_126.wav'), // 4:00, 126 BPM, E minor
    mp4: path.join(dir, 'song_126.mp4'), // the same song as an MP4's audio
    mp4NoAudio: path.join(dir, 'video_noaudio.mp4'),
    txt: path.join(dir, 'notes.txt'),
  }
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

/** Per-test folders. They live under a "J. Test" folder (a space and a period, like
 *  C:\Users\J. Gallop) so every path the app and engine build is exercised with one. */
function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-e2e-'))
  const base = path.join(root, 'J. Test')
  const d = (n) => { const p = path.join(base, n); fs.mkdirSync(p, { recursive: true }); return p }
  return { root, base, appData: d('AppData. Roaming'), storage: d('storage'), userData: d('user data'), downloads: d('Downloads'), exports: d('Music. Exports'), temp: d('Temp') }
}

/** Environment for launching the app in tests. */
function appEnv(dirs, extra = {}) {
  return {
    ...process.env,
    RIPPER_APP_DATA: dirs.appData,
    RIPPER_STORAGE: dirs.storage,
    RIPPER_USER_DATA: dirs.userData,
    RIPPER_DOWNLOAD_DIR: dirs.downloads,
    RIPPER_EXPORT_DIR: dirs.exports,
    RIPPER_ENGINE_NEW: '1',
    RIPPER_ALLOW_ELEVATED: '1', // CI runners are admin; don't relaunch through Explorer
    TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp, // Electron's temp (drag files) under "J. Test"
    ...extra,
  }
}

/** Simulate a 24-core PC: 24-thread settings in the environment, 24 CPUs reported. */
const MANY_CORES_ENV = {
  RIPPER_TEST_CPU_COUNT: '24',
  OMP_NUM_THREADS: '24', OPENBLAS_NUM_THREADS: '24', MKL_NUM_THREADS: '24', NUMBA_NUM_THREADS: '24', VECLIB_MAXIMUM_THREADS: '24',
}

module.exports = { ROOT, fixtures, inspectWav, tempDirs, appEnv, MANY_CORES_ENV, python }
