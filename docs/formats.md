# The Ripper — formats & audio math (porting spec)

This file is the contract between the Python engine (`engine/`), the React UI (`ui/src/lib/`)
and the future JUCE plugin (C++). Every constant below is the value in code. If you change one,
change it everywhere and regenerate the parity vectors:

```bash
python -m engine.tests.parity_cases > docs/parity.json   # Python output
npm test -w ui                                            # JS must reproduce it exactly
```

`docs/parity.json` holds input/output vectors for grid beats, grid/transient slicing, snapping
and filenames. A C++ port should load it in its unit tests too.

All times are **seconds** (float64), gains **dB**, sample rates **Hz**.

---

## 1. Import

| Step | Value |
|---|---|
| Accepted uploads | `.wav`, `.mp3` (extension check, then `ffprobe` must find an audio stream with a duration) |
| Max upload | 200 MiB (209,715,200 bytes) |
| Link import | `yt-dlp`, format `bestaudio/best`, no playlists, JS runtimes `deno`, `node`, `bun` enabled |
| Conversion | `ffmpeg -i IN -vn -ac 2 -ar 44100 -c:a pcm_f32le source.wav` |
| Minimum length | 0.5 s |

Every track is stored as `storage/<uuid32>/source.wav` (44.1 kHz, stereo, 32-bit float).

## 2. Analysis

Analysis runs on a mono 22,050 Hz copy (`librosa.load(sr=22050, mono=True)`, soxr_hq).

### 2.1 Tempo

1. `onset_env = onset_strength(y, sr=22050, hop_length=512)`
2. `tempo, beats = beat_track(onset_envelope=onset_env, sr=22050, hop_length=512, units='time')`
3. `bpm_raw = float(np.atleast_1d(tempo)[0])`
4. If ≥ 4 beats: least-squares fit `beats[i] = a + slope·i`; `fitted = 60 / slope`. Use `fitted`
   when `|fitted − bpm_raw| / bpm_raw < 0.08`, else keep `bpm_raw`. (Removes tempogram bin
   quantisation: a 120 BPM loop reads 117.45 raw.)
5. If `bpm ≤ 0` → 120.
6. If `|bpm − round(bpm)| < 0.15` → `round(bpm)`. Then round to 2 decimals.
7. Flag: `bpm < 80` → `"maybe_double"`; `bpm > 160` → `"maybe_half"`; else `null`.
   `bpm_alternatives = [bpm/2, bpm*2]`.

User overrides: **½**, **×2**, typed value, or **tap tempo** (mean of the last ≤ 8 intervals,
a gap > 2000 ms restarts) → `PATCH /tracks/<id> {bpm}`. Valid range 20–400.

### 2.2 Grid anchor (downbeat)

1. Fine onset envelope: `onset_strength(y, sr=22050, hop_length=64, n_fft=512, n_mels=64)`
   (frame = 2.902 ms).
2. Refine each tracked beat `b`: search frames `[floor((b−0.060)·sr/64), floor((b+0.030)·sr/64)]`
   (end inclusive), take `argmax`; refined time = `frame·64/sr`.
3. Circular mean phase with `period = 60/bpm`:
   `φ = atan2(mean(sin(2πb/period)), mean(cos(2πb/period)))`,
   `offset = (φ/2π · period) mod period`; if `period − offset < 0.005` → `0`.
4. `downbeat = round(offset, 4)` — the first grid beat is bar 1, beat 1. The user shifts the
   downbeat with ◀/▶ (one beat at a time, wrapped into `[0, 4·period)`, rounded half-up to 1e-6):
   `shift(d, n) = ((d + n·period) mod bar + bar) mod bar`.

### 2.3 Grid beats & bars

```
period = 60 / bpm
k0     = ceil((0 − downbeat)/period − 1e-9)
beat_k = downbeat + k·period            for k = k0, k0+1, …   while beat_k < duration − 1e-6
         (kept if beat_k ≥ −1e-9, clamped to ≥ 0, rounded half-up to 1e-6)
bar line  ⇔  ((k mod 4) + 4) mod 4 == 0      (bar number = floor(k/4) + 1)
```

Meter is always 4/4.

### 2.4 Key

1. `y_h = librosa.effects.harmonic(y, margin=4.0)`
2. `chroma = chroma_cqt(y=y_h, sr=22050, hop_length=512)`; `profile = chroma.mean(axis=1)`
3. For every root `r ∈ 0..11` and mode, Pearson `corrcoef(profile, roll(template, r))`:
   - major `[6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]`
   - minor `[6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]`
4. Highest correlation wins (ties: first found, iterating root then major before minor).
5. Label: `["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"][root]` + `"m"` for minor
   (`"Am"`, `"F#"`). Camelot: minor `[5,12,7,2,9,4,11,6,1,8,3,10][root]+"A"`,
   major `[8,3,10,5,12,7,2,9,4,11,6,1][root]+"B"`.

### 2.5 Onsets (transient chopping)

Sensitivity `s ∈ [0,1]` (UI slider, default 0.5):

```
delta = 0.02 + (1 − s)·0.28
wait  = round((1 − s)·8) + 1          frames (hop 512 @ 22,050 Hz)
onset_detect(y, sr=22050, hop_length=512, units='time', backtrack=True,
             delta=delta, wait=wait, pre_max=1, post_max=1, pre_avg=3, post_avg=3)
```

### 2.6 Card waveform peaks

160 buckets over the mono 22,050 Hz signal: edges `linspace(0, N, 161)` cast to int,
value = `max|y|` in the bucket, normalised by the largest bucket, rounded to 3 decimals.

## 3. Slicing

`MIN_SLICE = 0.05` s. Rounding `round6(x) = floor(x·1e6 + 0.5)/1e6` (half-up, same as JS
`Math.round(x·1e6)/1e6`).

**Bounds → slices** (shared by every mode):

```
bounds = sorted(b for b in bounds if 0 ≤ b < duration)
clean  = drop any bound closer than MIN_SLICE to the previous kept bound
if clean is empty or clean[0] > MIN_SLICE: insert 0 at front    (lead-in / pickup slice)
else: clean[0] = 0                                              (tiny lead-in snapped to 0)
if duration − clean[-1] < MIN_SLICE and len(clean) > 1: drop clean[-1]   (tiny tail merged)
append duration
slice i = [round6(clean[i]), round6(clean[i+1])], name "slice%02d" % (i+1)
```

**Grid** — division in beats: `1/4 = 0.25`, `1/2 = 0.5`, `1 = 1`, `1 bar = 4`, `2 bars = 8`,
`4 bars = 16`. `step = division·60/bpm`; bounds = `downbeat + n·step` for
`n ≥ ceil((0−downbeat)/step − 1e-9)` while `< duration`.
⇒ 1-bar slices of a track whose grid starts at ~0 = `ceil(beats/4)`.

**Transients** — bounds = onset times (§2.5).

**Manual** — `S` (Manual mode only) splits the slice containing the playhead `t` if
`start + MIN_SLICE < t < end − MIN_SLICE`; drag on the waveform adds a slice.
Default-named slices are renumbered in time order; custom names are kept.

**Snap** — `snap(t) = clamp(downbeat + round((t − downbeat)/step)·step, 0, duration)` with the
snap division (default 1 beat). Applied to region edits, manual splits and drag-selections.

## 4. Slice rendering (export, drag, pads)

Slice object (engine JSON): `{start, end, name, reverse, gain (dB), fade_in (s), fade_out (s),
source ("mix" | stem name)}`. UI default `fade_out = 0.005` (de-click).

Processing order:

1. **Cut** at the source rate: `a = round(start·sr)`.
   - one-shot: `length = round((end−start)·sr)`, `num_beats = round((end−start)·bpm/60)`
   - loop: `num_beats = max(1, round((end−start)·bpm/60))`, `length = round(num_beats·60/bpm·sr)`;
     zero-padded if it runs past the track end
2. **Trim silence** (one-shots only, if enabled): `librosa.effects.trim(mean(channels), top_db=60)`
3. **Reverse** (if enabled)
4. **Gain**: `× 10^(gain/20)`
5. **Fades**, linear in amplitude, lengths clamped to the slice:
   in = `linspace(0, 1, fi, endpoint=False)` on the first `fi = round(fade_in·sr)` samples;
   out = `linspace(1, 0, fo, endpoint=True)` on the last `fo = round(fade_out·sr)` samples
6. **Resample** to the export rate (44,100 or 48,000) with soxr_hq
7. **Loop length lock**: loops are cut/padded to exactly `round(num_beats·60/bpm·out_sr)` samples
8. **Normalize** (if enabled): peak → −0.3 dBFS (`× 0.96605 / peak`)
9. **Clip** to [−1, 1]

Pads play the same slice through Web Audio: `BufferSource.start(t0, start, end−start)` (or a
reversed copy of the segment), gain node at `10^(gain/20)` with the same linear fades.
**Choke**: triggering a choke-enabled slice stops every other playing choke-enabled slice
(one choke group).

Stems in kits are exported full length, not normalised, `num_beats = round(dur·bpm/60)`, loop flag.

## 5. WAV + ACID chunk

* PCM 24-bit little-endian, stereo, 44,100 or 48,000 Hz, written by libsndfile (`PCM_24`).
* The ACID chunk is **appended after the data chunk**, then the RIFF size at byte offset 4 is
  rewritten as `file_length − 8` (uint32 LE). If the file length is odd a pad byte is added
  first (24-bit stereo data is always even, so this never happens in practice).

```
offset size  field
0      4     "acid"
4      4     uint32 chunk size = 24
8      4     uint32 flags
12     2     uint16 root note = 60
14     2     uint16 0x8000
16     4     float32 0.0
20     4     uint32 number of beats
24     2     uint16 meter denominator = 4
26     2     uint16 meter numerator  = 4
28     4     float32 tempo (BPM)
```

Python: `b"acid" + pack("<I", 24) + pack("<IHHfIHHf", flags, 60, 0x8000, 0.0, beats, 4, 4, bpm)`

**Flags** (bit meanings as read by libsndfile / Sony ACID):
`0x01` one-shot, `0x02` root note valid, `0x04` stretch, `0x08` disk-based.

| Export | flags |
|---|---|
| one-shot | `0x03` (one-shot + root valid) |
| loop / stem | `0x06` (root valid + stretch; *not* one-shot) |

> The original brief suggested `0x02` for one-shots and `0x01` for loops. That inverts the
> one-shot bit (`0x01` = one-shot), so DAWs would treat loops as one-shots and not
> tempo-stretch them. The values above follow the real format.

## 6. MIDI slice map

* Standard MIDI File type 1, **480 ticks per quarter note**.
* Track 0: `set_tempo = round(60,000,000 / bpm)` µs/qn, `time_signature 4/4`, `track_name`.
* Track 1 (“Slices”): one note per slice in slice order: `note = 36 + i` (C1 upward, max 127 ⇒
  at most 92 slices), velocity 100.
* Timing: `origin = downbeat + round((first_start − downbeat)/beat)·beat` (the grid beat
  nearest the first slice, so grid chops land exactly on bar lines);
  `ticks_per_sec = 480·bpm/60`; `on = max(0, round((start − origin)·tps))`,
  `off = max(on + 1, round((end − origin)·tps))`.
* Events sorted by `(tick, note_off before note_on)` then written as delta times.

Drop it on FL Slicer / Ableton Drum Rack / Simpler (slice mode) / MPC / Logic Quick Sampler:
slice *n* sits on note `36 + n − 1` in original timing, so the beat replays as-is.

## 7. Filenames & kit layout

```
sanitize(s, fallback, max) = s.replace(/[^A-Za-z0-9#]+/g, "-").strip("-")[:max].strip("-") or fallback
format_bpm(b)  = r = floor(b·10 + 0.5)/10 ;  int(r) if r is whole else "%.1f"    (half-up!)
base           = sanitize(title,"track",40) + "_" + format_bpm(bpm) + "bpm" [+ "_" + sanitize(key,"key",4)]
file           = base + "_" + sanitize(part,"part",40) + ".wav"
```

`part` = slice name (`slice01`, …) or stem name (`drums`, …); the MIDI file is
`base_slices.mid`; a zip is `base_Kit.zip`. Duplicate names get `-2`, `-3`, … before the extension.

Kit zip (stored, not deflated):

```
Slices/<base>_slice01.wav …
Stems/<base>_drums.wav …        (current stem set; Fast DSP is run first if none exists)
MIDI/<base>_slices.mid
```

Drag-outs and folder exports use the same names; drags are flat (no subfolders).

## 8. Fast (DSP) stems

| Parameter | Value |
|---|---|
| STFT | n_fft 4096, hop 1024, Hann, at 44.1 kHz |
| Masks | computed on the mono mix, applied to each channel's STFT |
| HPSS | `hpss(D_mono, margin=2.0)` (kernel 31); `mask_P = |P|/|D|`, `mask_H = |H|/|D|`, residual `= clip(1 − mask_H − mask_P, 0, 1)` |
| REPET-SIM | `S = |H|`; width = `time_to_frames(2.0 s)` = 86 frames; k = 20 nearest frames by cosine similarity of `log1p(mel128(S²))`, excluding `|i−j| < width`; `S_f = min(S, median over the k neighbours)` |
| Vocal mask | `softmask(S − S_f, 10·S_f, power=2)` |
| Stems | drums = `mask_P·D`; vocals = `mask_H·mask_v·D`; background = `mask_H·(1−mask_v)·D` |
| Bass | 8th-order Butterworth low-pass, 150 Hz, `sosfiltfilt` on background |
| Other | background − bass + residual |

The four stems sum back to the mix (max error ≈ 2e-7). Label in UI: *“Fast mode — expect bleed”*.

## 9. HQ (AI) stems — Demucs 4.1.0

Models: `htdemucs` (4), `htdemucs_6s` (6: + guitar, piano), `htdemucs_ft` (best, ~4× slower),
`two_stem` = `htdemucs` with everything except vocals summed into `instrumental`.
Device: `cuda` → `mps` → `cpu` (override `RIPPER_TORCH_DEVICE`); on a device error it retries on CPU.
Input normalised `(x − mean)/std` of the mono reference, `apply_model(split=True, overlap=0.25)`,
then de-normalised. Models are loaded once and cached; one separation runs at a time.

## 10. Engine discovery (desktop app ⇄ plugin)

`<app-data>/TheRipper/engine.json` (mode 0600):

```json
{"port": 51234, "pid": 4242, "version": "1.0.0", "api": "v1", "token": "…"}
```

`<app-data>` = macOS `~/Library/Application Support`, Windows `%APPDATA%`, Linux
`$XDG_CONFIG_HOME` or `~/.config` (override: `RIPPER_APP_DATA`).

Client algorithm: read engine.json → `GET http://127.0.0.1:<port>/api/v1/health` (no token
needed) → if `ok` and `api == "v1"`, reuse it. Otherwise launch
`ripper-engine --port 0 --parent-pid <your pid>` and read the stdout line
`RIPPER_ENGINE_READY {json}` (or `RIPPER_ENGINE_ERROR {json}`; exit code 3 = ffmpeg missing).
Every other route needs header `X-Ripper-Token: <token>` (or `?token=`). The engine only
answers on 127.0.0.1 with a loopback `Host` header, exits when `--parent-pid` dies, and removes
engine.json on shutdown (`POST /api/v1/shutdown` or SIGTERM).
