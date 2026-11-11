# The Ripper

A desktop producer tool: drop a WAV/MP3 or paste a link → it lands on a beat grid with BPM and
key → chop it onto a 4×4 pad grid → split stems → **drag slices, stems, a whole kit or a slice-map
MIDI file straight into your DAW**.

Desktop app for macOS and Windows (Linux works for development). Electron shell + React UI + a
local Python audio engine that runs on your own machine. There is no hosted/web version.

```
engine/    Flask audio engine (import, analysis, stems, export) — /api/v1, PyInstaller "ripper-engine"
ui/        React 19 + Vite 8 UI; all native calls go through ui/src/host/ (electronHost / juceHost stub)
desktop/   Electron 45 shell: spawns/reuses the engine, serves the UI, native drag-out, dialogs
plugin/    JUCE VST3/AU placeholder (reuses engine + UI later)
docs/      formats.md (exact audio math for porting) + parity.json (shared JS/Python test vectors)
scripts/   smoke.sh, build_engine.py, py.mjs
```

---

## 1. Requirements

| | Version |
|---|---|
| Python | 3.10 – 3.14 (tested on 3.12 and 3.14) |
| Node.js | 20.19+ (tested on 24) |
| ffmpeg + ffprobe | on `PATH` (the engine refuses to start without them and says how to install) |

### Install ffmpeg

| OS | Command |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` (or `choco install ffmpeg`), then open a new terminal |
| Linux | `sudo apt install ffmpeg` (Debian/Ubuntu) · `sudo dnf install ffmpeg` (Fedora) |

Or point the engine at specific binaries with `RIPPER_FFMPEG` / `RIPPER_FFPROBE`.

## 2. Setup (once)

**macOS / Linux**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r engine/requirements.txt
npm install
```

**Windows (PowerShell)**

```powershell
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r engine\requirements.txt
npm install
```

The desktop shell finds the engine's Python at `.venv/` automatically (override with
`RIPPER_PYTHON=/path/to/python`).

### Optional: HQ (AI) stems — Demucs

```bash
pip install -r engine/requirements-ai.txt        # torch + torchaudio + demucs 4.1.0
```

* **NVIDIA GPU (Windows/Linux):** install the CUDA build of torch first, e.g.
  `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128`, then
  `pip install demucs==4.1.0`. The app shows `device: cuda`.
* **Apple Silicon:** the default wheels support Metal; the app shows `device: mps`
  (unsupported ops fall back to CPU automatically).
* **CPU only:** works everywhere but is slow — measured: `htdemucs` took 29 s for a 12 s clip
  on a 2-core VM (including model load). Faster CPUs scale roughly with cores; `htdemucs_ft`
  runs 4 models and takes about 4× as long. A GPU is strongly recommended for full songs.
* The first run of each model downloads its weights (~80–320 MB) to the torch cache.
* Without torch/demucs the HQ option is hidden and a setup hint is shown; Fast (DSP) stems
  always work.

## 3. Run the desktop app (dev mode, hot reload)

```bash
npm run dev
```

Starts Vite on `127.0.0.1:5173` and Electron pointed at it; Electron spawns the engine
(`python -m engine`) on a free localhost port and kills it on quit. UI edits hot-reload; restart
for changes in `desktop/src` or `engine/`.

## 4. Tests

```bash
npm run test:engine     # pytest: analysis, slicing, DSP + Demucs stems, export, every API route, link import
npm run test:ui         # vitest: grid math, pad keys, filenames, JS<->Python parity vectors
npm run lint            # eslint (ui) + syntax check (desktop)
npm run build           # vite production build
npm run test:e2e        # Playwright drives the real Electron app (Linux: prefix with xvfb-run -a)
bash scripts/smoke.sh   # engine-only smoke: health → upload → poll → kit zip → list contents
```

* Fixtures are generated in code (`npm run fixtures`): 12 s 120 BPM kick + A-minor pad + A1 bass
  (WAV + MP3), and a 90 BPM version.
* The Demucs test is skipped (not failed) when torch/demucs isn't installed; the link-import
  tests are skipped when the network blocks them. Override the URL with `RIPPER_TEST_URL`.
* On Linux the e2e performs a **real** X11 drag-and-drop (via XTest; needs `python-xlib`, in
  `engine/requirements.txt`). On macOS/Windows it exercises everything up to the OS drag call.
* `RIPPER_E2E_EXECUTABLE=desktop/release/linux-unpacked/the-ripper npx playwright test` (in
  `desktop/`) runs the same e2e against a packaged build.

## 5. Build installers

Each installer must be built on its own OS (PyInstaller does not cross-compile).

```bash
npm run dist:mac      # macOS → desktop/release/The Ripper-1.0.0-arm64.dmg (+ x64)
npm run dist:win      # Windows → desktop/release/The Ripper Setup 1.0.0.exe (NSIS)
npm run dist:linux    # Linux → AppImage (dev convenience)
```

Each runs: `vite build` → `python scripts/build_engine.py` (PyInstaller onedir →
`engine/dist/ripper-engine/`) → `electron-builder`. The engine and UI ship in the app's
`resources/` folder.

* **PyInstaller needs a Python with a shared libpython** (python.org installers, Homebrew, `uv`
  and pyenv with `--enable-shared` are fine; some minimal Docker/static builds are not).
* **AI stems in installers:** the default engine build excludes torch (~300 MB+ CPU, multi-GB CUDA).
  `python scripts/build_engine.py --with-ai` bundles them.
* **ffmpeg:** either require users to install it (the app shows instructions on launch), or bundle
  it: put `ffmpeg`/`ffprobe` (`.exe` on Windows) in `desktop/vendor/ffmpeg/mac|win/` before
  building; they're copied next to `ripper-engine` and used automatically. Use an LGPL build
  (e.g. from evermeet.cx / BtbN `ffmpeg-*-lgpl`) if you ship it, and follow its licence.
* **Signing:** set the usual electron-builder variables (`CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) to sign/notarize. Unsigned builds
  work locally (macOS: right-click → Open the first time).

## 6. Using it

1. **Import** — paste a link and hit *Rip*, or drop WAV/MP3 files (≤ 200 MB). *Only import
   content you own or have rights to.* Cards show status, BPM, key, duration and a mini waveform.
2. **Editor** — click a card. The yellow lines are bars, faint lines beats. Fix the tempo with
   ½ / ×2 / TAP / typing, move bar 1 with ◀ ▶.
3. **Chop** — Grid (¼ beat … 4 bars), Transients (sensitivity slider) or Manual (`S` at the
   playhead, or drag on the waveform). Snap on/off. Drag slice edges to adjust.
4. **Pads** — keys `1234 / QWER / ASDF / ZXCV` (`S` is pad 10 except in Manual mode), banks for
   > 16 slices. Per slice: rename, reverse, gain, fades, choke.
5. **Stems** — HQ (AI) or Fast (DSP); solo/mute/volume; download; *Send to Chop Editor*.
6. **To the DAW** — drag any pad, slice handle `⠿`, stem, the **KIT** chip (all files) or the
   **MIDI** chip straight into FL Studio / Ableton / Logic / Studio One / MPC or the desktop. Or
   *Export Kit (.zip)* (saved to Downloads), *Slices → folder…*, *Kit → folder…* (remembered).

Shortcuts: `Space` play/pause · `L` loop (selected slice or 1 bar) · `Esc` stop pads.

Every WAV is 24-bit, 44.1/48 kHz, named `{track}_{bpm}bpm_{key}_{slice##|stem}.wav`, with an
ACID tempo chunk so DAWs pick up the BPM. Details: [docs/formats.md](docs/formats.md).

## 7. Free vs Pro

`engine/config.py`: `PRO_ENABLED` (env `RIPPER_PRO`, default **on**) and the `FEATURES` table.
Pro = HQ (AI) stems, 6-stem model, batch export (more than one slice), Export Kit (zip/folder/
drag with stems and/or MIDI). Free = everything else (import, analysis, chopping, pads, Fast
stems, single slice / single stem export and drag). The API returns `403 {"error":
"pro_required"}` and the UI shows a PRO tag on locked buttons.

## 8. Engine API (`/api/v1`, 127.0.0.1 only)

All routes except `/health` need `X-Ripper-Token` (see docs/formats.md §10). Errors are
`{"error", "detail"}` JSON — never tracebacks.

| Method | Path | |
|---|---|---|
| GET | `/health` | `{ok, version, api, ffmpeg, demucs_available, device, pro, features, models}` |
| POST | `/tracks/link` `{url}` | `202 {job_id, track_id}` |
| POST | `/tracks/upload` (multipart `file`) | `202 {job_id, track_id}`; 400 bad type/unreadable, 413 too big |
| GET | `/jobs/<id>` | `{status, progress, message, result, error}` |
| GET | `/tracks` · `/tracks/<id>` | list · metadata + analysis |
| GET | `/tracks/<id>/audio` | 44.1 kHz WAV, HTTP Range (206) |
| PATCH | `/tracks/<id>` `{bpm, downbeat, title}` | re-grid |
| DELETE | `/tracks/<id>` | |
| GET | `/tracks/<id>/onsets?sensitivity=` · `/tracks/<id>/slices?mode=grid&division=1bar` | |
| POST | `/tracks/<id>/stems` `{engine: "ai"\|"dsp", model}` | `202 {job_id}` |
| GET | `/tracks/<id>/stems` · `/tracks/<id>/stems/<name>` | |
| POST | `/tracks/<id>/export` `{slices, stems, mode, sr, normalize, trim_silence, include_stems, include_midi, format}` | zip (or one WAV with `format: "wav"`) |
| POST | `/tracks/<id>/render` `{kind, dest_dir, …}` | writes files to a local folder (drag/folder export) |
| POST | `/shutdown` | |

Storage: `engine/storage/` in dev (`<app-data>/TheRipper/storage` when packaged; override
`RIPPER_STORAGE`). Tracks older than 24 h are purged at start-up and hourly.

## 9. Troubleshooting

* **“ffmpeg is required”** on launch — install it (§1) and restart the app.
* **YouTube links fail** — keep yt-dlp current (`pip install -U yt-dlp`) and install a JS runtime
  (`deno` or Node) — YouTube needs one. Some networks/datacenter IPs are blocked by YouTube.
* **Linux: app hangs after a drag** — Electron's X11 drag loop needs the mouse button held; the
  app never starts a drag unless the file is ready within 400 ms (hover first, then drag).
* **Port / stale engine** — delete `<app-data>/TheRipper/engine.json`; the app starts a new engine.
