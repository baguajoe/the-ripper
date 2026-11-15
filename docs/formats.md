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

`MIN_SLICE = 0.05` s — no slice is ever shorter. Rounding `round6(x) = floor(x·1e6 + 0.5)/1e6`
(half-up, same as JS `Math.round(x·1e6)/1e6`). `half_beat = 30/bpm`.

### 3.1 Whole track (engine API, `GET /tracks/<id>/slices?mode=grid|transient`)

```
bounds = sorted(b for b in bounds if 0 ≤ b < duration)
clean  = drop any bound closer than MIN_SLICE to the previous kept bound
if clean is empty or clean[0] > lead_min: insert 0 at front   (lead-in / pickup slice)
else: clean[0] = 0                                             (short lead-in merged into slice01)
if duration − clean[-1] < MIN_SLICE and len(clean) > 1: drop clean[-1]   (tiny tail merged)
append duration
slice i = [round6(clean[i]), round6(clean[i+1])], name "slice%02d" % (i+1)
```

`lead_min = max(MIN_SLICE, half_beat)` for grid slices (a pickup shorter than half a beat, e.g.
a 0.1 s gap before the first downbeat, merges into slice01), `MIN_SLICE` for transients.

**Grid** — division in beats: `1/4 = 0.25`, `1/2 = 0.5`, `1 = 1`, `1 bar = 4`, `2 bars = 8`,
`4 bars = 16`. `step = division·60/bpm`; bounds = `downbeat + n·step` for
`n ≥ ceil((0−downbeat)/step − 1e-9)` while `< duration`.

### 3.2 A selection (the editor's Chop; API: add `start=&end=`)

The editor chops a **selection** `[start, end)`, never the whole song unless *All* is selected.
With no selection, Chop takes 4 bars from the bar line at (or before) the playhead; a bar that
would start before 0 s starts at the first bar line instead. Drag-selections snap to the grid.

```
region(bounds): clean = [start] + interior bounds (start < b < end, each ≥ MIN_SLICE after the last kept)
                if end − clean[-1] < MIN_SLICE: drop it
                if clean[1] ≤ first_downbeat + 1e-6 and clean[1] − clean[0] < half_beat:
                    drop clean[1]                (a pickup fragment before bar 1 merges)
                append end
first_downbeat = downbeat − floor(downbeat/bar + 1e-9)·bar      (first bar line ≥ 0)
```

| Mode | Boundaries |
|---|---|
| **Even N** (8 / 16 / 32) | `N' = min(N, floor(len/MIN_SLICE + 1e-9))` equal slices: `start + i·len/N'` (last ends exactly at `end`) |
| **Grid** (1/4 beat … 1 bar) | grid points `downbeat + n·step` in `[start, end)` → `region()` |
| **Transients** (cap, default 16) | onsets in `[start+MIN_SLICE, end−MIN_SLICE]`, strongest first (ties: earlier), each ≥ MIN_SLICE from those kept, at most `cap − 1` of them → `region()` |

Onset strength = the normalised onset envelope at the onset's peak frame (`GET /onsets` returns
`onsets` and `strengths`).

**Pad banks.** 8 banks (A–H) × 16 pads. A chop goes into the bank you're on if it's empty,
else the next empty bank(s); a chop of more than 16 slices fills consecutive banks; *Replace
current bank* chops into the current one. Each bank remembers the chop that made it (region +
settings); changing the mode or size re-chops that chop in place. Every chop, slice edit and
bank change is one undo step (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z). Banks C–H are Pro.

**Manual** — `S` (Manual mode only) splits the slice containing the playhead `t` if
`start + MIN_SLICE < t < end − MIN_SLICE`; dragging on the waveform adds a slice.
Default-named slices are renumbered `slice01…` in time order within their bank; custom names
are kept.

**Snap** — `snap(t) = clamp(downbeat + round((t − downbeat)/step)·step, 0, duration)` with the
snap division (default 1 beat). Applied to selections, region edits, manual splits and drags.

### 3.3 Pads

Per bank: **Mono** (default) — a pad cuts whatever that bank is playing; **Poly** — pads ring
out. Choked pads cut each other in any bank. A cut pins the voice's envelope at the cut time
and ramps it to 0 over 5 ms (`CUT_FADE`), then stops it, so the old voice is silent within
~6 ms. Pad mode **One-shot** plays the slice to its end; **Note-on** plays while the pad (or
key) is held. Esc / Stop fades out everything.

## 4. Slice rendering (export, drag, pads)

Slice object (engine JSON): `{start, end, name, reverse, gain (dB), fade_in (s), fade_out (s),
source ("mix" | stem name), clip? (see 4.2)}`. UI default `fade_out = 0.005` (de-click).

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

Pads play through **the pad engine** (`ui/src/dsp/`, plain JavaScript): live inside an
AudioWorklet, offline for exports, resampling and tests — one implementation, so a pad sounds
exactly like its export. Its rounding matches the steps above (Python's round-half-even), so an
unshaped pad is bit-identical to the exporter's cut. **Choke**: triggering a choke-enabled slice
stops every other playing choke-enabled slice (one choke group).

### 4.1 Pad sound shaping (v1.2)

Extra slice fields (UI, camelCase; all optional, defaults = no change):
`tune` (semitones, −24..24), `fine` (cents, −50..50), `keepLength` (bool),
`env {a, d, s, r}` (seconds / sustain 0..1), `filter {type: off|lp|hp|bp, cutoff Hz, res 0..1}`,
`velVol` (0..1, default 1), `velFilter` (0..1), `pan` (−1..1), `color`, `pad` (0..15).

Per output sample, a voice does: read the source at `a + k·rate` (reversed: `a + n−1 − k·rate`),
cubic (Catmull-Rom) interpolation, exact at whole positions →
gain × fades (in **source** samples, as above) × envelope (output time) × velocity gain →
biquad (RBJ cookbook, Q = 0.7071 + res·(12 − 0.7071), the cutoff lowered by
`velFilter·4·(1 − vel/127)` octaves) → pan (the Web Audio StereoPanner law).

* `rate = 2^((tune + fine/100)/12) · source_sr/out_sr` — pitch changes speed (and length).
* **Keep length**: the engine makes a pitch-shifted copy of the slice with the same length
  (`POST /tracks/<id>/pitch {start, end, semitones, source}` → planar float32, headers
  `X-Ripper-SR`, `X-Ripper-Channels`; Signalsmith Stretch, seed 1) and the voice plays it at
  rate 1.
* Velocity gain = `(1 − velVol) + velVol · vel/127`. Pads hit from the mouse / keyboard and
  exports use velocity 127.
* Envelope: linear attack 0→1, linear decay 1→s, hold s; release is linear from the level at
  the moment the gate closes. Note-on pads close the gate on release (no release = the 5 ms
  de-click); a one-shot's gate closes `r` seconds before its end so the release ends with it.

### 4.2 Rendered clips

A slice whose shaping isn't all defaults (or, from v1.2 phase 2, sits in a vintage bank /
has effects) is exported as a **clip**: the UI renders it with the pad engine at the source
rate (one-shot, velocity 127, plus any effect tail), uploads it with
`POST /clips` (body: planar little-endian float32, headers `X-Ripper-SR`,
`X-Ripper-Channels`; reply `{clip: sha1}`), and the export slice carries `"clip": "<id>"`.
For a clip the exporter skips steps 1–5 above (the clip *is* the processed slice), takes
`num_beats` from the clip's length, and does trim / resample / loop-lock / normalize / clip
as usual. Clips live in `<storage>/.clips/` and are deleted after 24 h.

Stems in kits are exported full length, not normalised, `num_beats = round(dur·bpm/60)`, loop flag.

### 4.3 Vintage banks (v1.2)

A bank's `vintage` (`off` | `12bit` | `16bit`) runs on that bank's bus (every pad of the bank,
live, in the sequencer and in exports — a pad in a vintage bank exports as a clip, 4.2):

* `12bit`: 4th-order low-pass at 0.45 × 40 kHz → sample-and-hold at 40 kHz → round to 12 bits
  (±2047) → the same low-pass again.
* `16bit`: low-pass at 15 kHz → `tanh(1.6x)/tanh(1.6)` saturation → round to 16 bits.

Both end in a soft limiter above 0.9 (never reaches 1.0), and run on every sample (idle or not)
so a render doesn't depend on block boundaries.

### 4.4 Step sequencer (v1.2)

Saved with the pad program as `seq`: `{patterns: {A..H: {steps: 16|32|64, notes: [{bank, pad,
tick, vel, len}], accents: [step]}}, current, song: [pattern id], mode: 'pattern'|'song',
swing: 50..75}`.

* Ticks at **960 PPQ** (a 16th = 240). A step's notes are those with `round(tick/240)` = step.
* **Swing** S%: each 8th (480 ticks) is warped piecewise-linearly so its second 16th lands at
  `S/100 × 480`; swung ticks are rounded to whole ticks. Accented steps play at velocity 127.
* A **pass** is the current pattern, or the song's patterns back to back; event time =
  `start + round(tick × 60 / (bpm × 960) × sr)` samples (each pass computed from absolute ticks,
  so loops never drift). Note-on pads are released at `tick + len`.
* **Recording** un-swings the played position, quantizes it (off / 480 / 240 / 120 ticks) and
  wraps it into the pattern. One recording take = one undo step. Overdub off = the take replaces
  the pattern.
* **Note repeat** (1/8 = 480, 1/16 = 240, 1/32 = 120, 1/8T = 320, 1/16T = 160 ticks): on the
  swung grid while playing, free-running from the press while stopped.
* **Count-in**: one bar of clicks; the metronome clicks every beat (accent on the bar).

**MIDI file** of a pass: type 1, 960 PPQ, track 1 = tempo + 4/4 + name, track 2 = notes on
channel 10, note = `36 + bank × 16 + pad` (C1 = bank A pad 1), the pass's exact ticks and
velocities (swing + accents applied).

### 4.6 Effects (v1.2)

Per pad (`slice.fx`) and on the master bus (`program.master`), each with `on` and a wet/dry
`mix`: **drive** (`amount`: `x + mix·(0.8·tanh(k·x)/tanh(k) − x)`, k = 1 + 15·amount),
**delay** (`time` as a note value at the project tempo — 1/2, 1/4, 1/4T, 1/8, 1/8., 1/8T, 1/16 —
`feedback` ≤ 0.9, stereo ping-pong), **reverb** (Freeverb: 8 combs + 4 allpasses per channel,
`size` → feedback 0.7..0.98, `damp`), and on the master only a **compressor** (peak, stereo
linked, 6 dB soft knee, `threshold`, `ratio`, `attack`, `release`, `makeup`). Order: drive →
delay → reverb (→ compressor). A pad with effects gets its own bus before its bank's bus
(vintage) → master effects → output; the metronome skips the master bus.
A pad's export (a clip, 4.2) includes its effect tail: delay `time × echoes to −60 dB` +
reverb `0.8 + 3.2·size` s (max 8 s). Single-pad exports don't include the master bus; beat
exports and resampling do. After an effect's input has been silent for its tail length its
state is cleared on that exact sample, so renders never depend on audio block boundaries.

### 4.7 Resample (v1.2)

The pad engine records its own output (after the master bus): **Resample** records one pass of
the pattern / song from the pass's first sample, plus effect tails (until 0.5 s below −80 dB,
max 6 s); **Live** records until stopped. The recording is identical to an offline render of
the same pass. It's imported as a 32-bit float WAV upload (`<title> (resampled …).wav`) and
analysed like any track.

### 4.8 Fit to tempo / key (v1.2)

`POST /tracks/<id>/fit {bpm?, key?}` → 202 `{job_id, track_id, ratio, semitones}`. A new track:
the source time-stretched by `ratio = bpm_old / bpm` (pitch kept) and transposed by
`semitones` = the shortest move between the two keys' tonics (−6..+5; a minor key and its
relative major count as the same key), with Signalsmith Stretch (seed 1). The new track is
analysed from scratch; then the grid snaps to the target: `bpm` = target, `downbeat` = old ×
ratio, `key` = old key + semitones. What the analyser detected is kept in `analysis.fit`
(`detected_bpm`, `detected_key`, `ratio`, `semitones`, `from`). The editor opens the new track
with the old chops / pads / patterns, times × ratio.

### 4.5 MIDI controllers (v1.2)

Web MIDI inputs (any device) plus virtual inputs. Note-ons hit pads with their velocity;
default notes 36–51 = pads 1–16 of the current bank. MIDI learn maps a note to a pad, or a
note / CC to Play, Stop or Record; the map is saved in the app settings (`midiMap`:
`{pads: {"n60": 5}, buttons: {play: "c20"}}`).

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

Drop it on FL Slicer / Ableton Drum Rack / Simpler (slice mode) / hardware samplers / Logic Quick Sampler:
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

## 8. Fast (no AI) stems

Two modes; both only promise what DSP can do. UI label: *"Fast (no AI) — for vocals use HQ (AI)"*.

**`dsp` → drums / bass / music**

| Parameter | Value |
|---|---|
| STFT | n_fft 4096, hop 1024, Hann, at 44.1 kHz |
| Masks | computed on the mono mix, applied to each channel's STFT |
| HPSS | `hpss(D_mono, margin=2.0)` (kernel 31); `mask_P = |P|/|D|`, `mask_H = |H|/|D|`, residual `= clip(1 − mask_H − mask_P, 0, 1)` |
| Drums | `mask_P·D` |
| Bass | 8th-order Butterworth low-pass, 150 Hz, `sosfiltfilt` on the harmonic part `mask_H·D` |
| Music | harmonic − bass + residual (vocals stay in here) |

The three stems sum back to the mix (max error ≈ 2e-7).

**`center_cancel` → instrumental** (mid/side vocal removal): `mid = (L+R)/2`, `side = (L−R)/2`,
`low = lowpass₈(mid, 120 Hz)`; output `L' = low + side`, `R' = low − side`. Removes whatever is
mixed dead centre above 120 Hz (usually the lead vocal); keeps the stereo sides and the low end.

## 9. HQ (AI) stems — Demucs 4.1.0 (the HQ (AI) add-on)

Models: `htdemucs` (4: drums, bass, other, vocals), `htdemucs_6s` (6: + guitar, piano),
`two_stem` = `htdemucs` with everything except vocals summed into `instrumental`.

Separation never runs inside the engine: it runs `ripper_ai.py` in the add-on's own Python
(`<app-data>/TheRipper/addons/ai/runtime/`, or the engine's Python in a dev checkout with
torch installed) and reads JSON-line progress from it. Device: `cuda` → `mps` → `cpu` (override
`RIPPER_TORCH_DEVICE`); on a device error it retries on the CPU. Input normalised
`(x − mean)/std` of the mono reference, `apply_model(split=True, overlap=0.25)`, de-normalised.
Weights are read from `addons/ai/models/` only (`<model>.yaml` + `<sig>.safetensors`).

**Add-on.** A release asset per platform (`ripper-ai-<version>-{win-cpu,win-cuda,mac-arm64}.zip.NNN`,
parts < 2 GiB) listed in `ripper-ai-manifest.json` with sizes + SHA-256. Install = download
(HTTP Range resume, retries, per-part and whole-zip SHA-256) → fetch the weights from the
author's Hugging Face repos (pinned commits + SHA-256, never redistributed by us) → unzip
(executable bits kept, no paths outside the folder) → self-test (`ripper_ai.py probe`) → swap in.
Variant: Windows with an NVIDIA GPU (`nvidia-smi -L`) → `win-cuda`, other Windows → `win-cpu`,
Apple Silicon → `mac-arm64`. **Estimate** = `startup + rtf·duration`, defaults per device,
replaced by this machine's measured speed after the first run (`addons/ai/timings.json`).

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
