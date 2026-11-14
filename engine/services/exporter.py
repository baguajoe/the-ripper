"""DAW export: 24-bit WAVs with an ACID tempo chunk, a slice-map MIDI file, and kit zips.

Byte layouts and DSP order are specified in docs/formats.md so the JUCE plugin can port
this identically.
"""
from __future__ import annotations

import io
import math
import re
import struct
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import mido
import numpy as np
import soundfile as sf

# --- ACID chunk ------------------------------------------------------------------------
# dwFlags bits (as read by libsndfile wav.c / Sony ACID): 0x01 one-shot, 0x02 root note
# valid, 0x04 stretch, 0x08 disk-based. A loop is "not one-shot + stretch".
ACID_ONESHOT = 0x01 | 0x02
ACID_LOOP = 0x02 | 0x04
ACID_ROOT_NOTE = 60
ACID_STRUCT = "<IHHfIHHf"   # flags, root, 0x8000, 0.0, num_beats, meter_den, meter_num, bpm
ACID_SIZE = struct.calcsize(ACID_STRUCT)  # 24

NORMALIZE_PEAK = 10 ** (-0.3 / 20)   # -0.3 dBFS
TRIM_TOP_DB = 60.0
MIDI_PPQ = 480
MIDI_BASE_NOTE = 36                  # C1 (General MIDI / FL / Ableton convention)
MIDI_VELOCITY = 100
MAX_MIDI_SLICES = 128 - MIDI_BASE_NOTE  # 92


def acid_chunk(bpm: float, num_beats: int, loop: bool) -> bytes:
    body = struct.pack(ACID_STRUCT, ACID_LOOP if loop else ACID_ONESHOT, ACID_ROOT_NOTE,
                       0x8000, 0.0, max(0, int(num_beats)), 4, 4, float(bpm))
    return b"acid" + struct.pack("<I", len(body)) + body


def wav_bytes(data: np.ndarray, sr: int, bpm: float, num_beats: int, loop: bool) -> bytes:
    """data (channels, samples) float -> 24-bit PCM WAV bytes with an ACID chunk appended
    after the data chunk and the RIFF size at byte offset 4 fixed up."""
    buf = io.BytesIO()
    sf.write(buf, np.clip(data, -1.0, 1.0).T, sr, format="WAV", subtype="PCM_24")
    raw = bytearray(buf.getvalue())
    if len(raw) % 2:
        raw += b"\x00"
    raw += acid_chunk(bpm, num_beats, loop)
    struct.pack_into("<I", raw, 4, len(raw) - 8)
    return bytes(raw)


def read_acid(raw: bytes) -> dict | None:
    """Parse the ACID chunk out of WAV bytes (used by tests and the desktop shell)."""
    pos = 12
    while pos + 8 <= len(raw):
        cid, size = raw[pos:pos + 4], struct.unpack_from("<I", raw, pos + 4)[0]
        if cid == b"acid":
            f = struct.unpack_from(ACID_STRUCT, raw, pos + 8)
            return {"flags": f[0], "root_note": f[1], "num_beats": f[4], "meter_den": f[5],
                    "meter_num": f[6], "bpm": f[7], "loop": not (f[0] & 0x01)}
        pos += 8 + size + (size & 1)
    return None


# --- filenames -----------------------------------------------------------------------------
def sanitize(text: str, fallback: str = "track", max_len: int = 40) -> str:
    s = re.sub(r"[^A-Za-z0-9#]+", "-", text or "").strip("-")
    s = s[:max_len].strip("-")
    return s or fallback


def format_bpm(bpm: float) -> str:
    """One decimal, round-half-up (NOT Python's banker's round) so JS matches exactly."""
    r = math.floor(float(bpm) * 10 + 0.5) / 10
    return str(int(r)) if r == int(r) else f"{r:.1f}"


def base_name(track: str, bpm: float, key: str | None) -> str:
    parts = [sanitize(track), f"{format_bpm(bpm)}bpm"]
    if key:
        parts.append(sanitize(key, "key", 4))
    return "_".join(parts)


def build_filename(track: str, bpm: float, key: str | None, part: str, ext: str = "wav") -> str:
    """{track}_{bpm}bpm_{key}_{slice##|stemname}.wav — mirrored in ui/src/lib/filenames.js."""
    return f"{base_name(track, bpm, key)}_{sanitize(part, 'part')}.{ext}"


# --- slice rendering --------------------------------------------------------------------------
@dataclass
class ExportOptions:
    mode: str = "oneshot"         # 'oneshot' | 'loop'
    sr: int = 44100               # 44100 | 48000
    normalize: bool = False
    trim_silence: bool = False


@dataclass
class Slice:
    start: float
    end: float
    name: str = "slice"
    reverse: bool = False
    gain: float = 0.0             # dB
    fade_in: float = 0.0          # seconds
    fade_out: float = 0.0         # seconds
    source: str = "mix"           # 'mix' or a stem name
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict, index: int) -> "Slice":
        start, end = float(d["start"]), float(d["end"])
        if not (math.isfinite(start) and math.isfinite(end)) or end <= start or start < 0:
            raise ValueError(f"slice {index + 1}: invalid start/end")
        return cls(start=start, end=end,
                   name=str(d.get("name") or f"slice{index + 1:02d}"),
                   reverse=bool(d.get("reverse", False)),
                   gain=float(d.get("gain", 0.0) or 0.0),
                   fade_in=max(0.0, float(d.get("fade_in", 0.0) or 0.0)),
                   fade_out=max(0.0, float(d.get("fade_out", 0.0) or 0.0)),
                   source=str(d.get("source") or "mix"))


def beats_in(seconds: float, bpm: float) -> int:
    return int(round(seconds * bpm / 60.0))


def render_slice(audio: np.ndarray, sr: int, sl: Slice, opts: ExportOptions, bpm: float
                 ) -> tuple[np.ndarray, int, int]:
    """Returns (data at opts.sr, num_beats, out_sr). Processing order (docs/formats.md):
    cut -> [loop: tempo-lock length | one-shot: trim] -> reverse -> gain -> fades
    -> resample -> normalize -> clip."""
    n = audio.shape[1]
    a = int(round(sl.start * sr))
    if opts.mode == "loop":
        num_beats = max(1, beats_in(sl.end - sl.start, bpm))
        length = int(round(num_beats * 60.0 / bpm * sr))
    else:
        length = int(round((sl.end - sl.start) * sr))
        num_beats = beats_in(sl.end - sl.start, bpm)
    a = min(max(a, 0), n)
    seg = audio[:, a:a + length].astype(np.float32, copy=True)
    if seg.shape[1] < length:  # loop past the end of the track: pad with silence
        seg = np.pad(seg, ((0, 0), (0, length - seg.shape[1])))
    if opts.mode != "loop" and opts.trim_silence and seg.shape[1] > 0:
        import librosa
        _, (i0, i1) = librosa.effects.trim(seg.mean(axis=0), top_db=TRIM_TOP_DB)
        if i1 > i0:
            seg = seg[:, i0:i1]
    if sl.reverse:
        seg = seg[:, ::-1]
    if sl.gain:
        seg = seg * (10 ** (sl.gain / 20.0))
    seg = np.ascontiguousarray(seg)
    apply_fades(seg, sr, sl.fade_in, sl.fade_out)
    out_sr = int(opts.sr)
    if out_sr != sr:
        import librosa
        seg = librosa.resample(seg, orig_sr=sr, target_sr=out_sr)
    if opts.mode == "loop":  # tempo-locked: exactly num_beats * 60/bpm * out_sr samples
        exact = int(round(num_beats * 60.0 / bpm * out_sr))
        seg = seg[:, :exact] if seg.shape[1] >= exact else np.pad(seg, ((0, 0), (0, exact - seg.shape[1])))
    if opts.normalize:
        peak = float(np.max(np.abs(seg))) if seg.size else 0.0
        if peak > 1e-9:
            seg = seg * (NORMALIZE_PEAK / peak)
    return np.clip(seg, -1.0, 1.0).astype(np.float32), num_beats, out_sr


def apply_fades(seg: np.ndarray, sr: int, fade_in: float, fade_out: float) -> None:
    """Linear amplitude ramps, in place. Fade lengths are clamped to the slice length."""
    n = seg.shape[1]
    fi = min(n, int(round(fade_in * sr)))
    fo = min(n, int(round(fade_out * sr)))
    if fi > 0:
        seg[:, :fi] *= np.linspace(0.0, 1.0, fi, endpoint=False, dtype=np.float32)
    if fo > 0:
        seg[:, n - fo:] *= np.linspace(1.0, 0.0, fo, endpoint=True, dtype=np.float32)


def render_stem(audio: np.ndarray, sr: int, opts: ExportOptions, bpm: float
                ) -> tuple[np.ndarray, int, int]:
    out_sr = int(opts.sr)
    import librosa
    data = audio if out_sr == sr else librosa.resample(audio, orig_sr=sr, target_sr=out_sr)
    return np.clip(data, -1, 1).astype(np.float32), beats_in(audio.shape[1] / sr, bpm), out_sr


# --- MIDI --------------------------------------------------------------------------------------
def midi_origin(slices: list[Slice], bpm: float, downbeat: float | None) -> float:
    """Time that maps to MIDI tick 0: the grid beat nearest the first slice's start, so
    grid-chopped slices land exactly on the DAW's bar lines. Without a grid, the first start."""
    first = min(s.start for s in slices)
    if downbeat is None:
        return first
    beat = 60.0 / bpm
    return downbeat + round((first - downbeat) / beat) * beat


def build_midi(slices: list[Slice], bpm: float, name: str = "The Ripper slices",
               downbeat: float | None = None) -> bytes:
    """Type-1 MIDI, 480 PPQ: one note per slice (C1=36 upward) at its original position
    relative to midi_origin(), lasting the slice's length. Negative ticks clamp to 0."""
    mid = mido.MidiFile(type=1, ticks_per_beat=MIDI_PPQ)
    meta = mido.MidiTrack()
    meta.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))
    meta.append(mido.MetaMessage("time_signature", numerator=4, denominator=4, time=0))
    meta.append(mido.MetaMessage("track_name", name=name[:60], time=0))
    meta.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(meta)

    notes = mido.MidiTrack()
    notes.append(mido.MetaMessage("track_name", name="Slices", time=0))
    if slices:
        origin = midi_origin(slices, bpm, downbeat)
        ticks_per_sec = MIDI_PPQ * bpm / 60.0
        events = []  # (abs_tick, order, msg) — note_off sorts before note_on at equal ticks
        for i, sl in enumerate(slices[:MAX_MIDI_SLICES]):
            note = MIDI_BASE_NOTE + i
            on = max(0, int(round((sl.start - origin) * ticks_per_sec)))
            off = max(on + 1, int(round((sl.end - origin) * ticks_per_sec)))
            events.append((on, 1, mido.Message("note_on", note=note, velocity=MIDI_VELOCITY)))
            events.append((off, 0, mido.Message("note_off", note=note, velocity=0)))
        events.sort(key=lambda e: (e[0], e[1]))
        last = 0
        for tick, _, msg in events:
            notes.append(msg.copy(time=tick - last))
            last = tick
    notes.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(notes)
    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


# --- kit assembly ------------------------------------------------------------------------------
@dataclass
class KitFile:
    arcname: str      # path inside the zip / export folder
    data: bytes


def build_kit(*, title: str, bpm: float, key: str | None, sources: dict[str, tuple[np.ndarray, int]],
              slices: list[Slice], opts: ExportOptions, stems: dict[str, tuple[np.ndarray, int]] | None,
              include_midi: bool, folders: bool = True, downbeat: float | None = None
              ) -> list[KitFile]:
    """Render everything into memory. `sources` maps 'mix'/stem name -> (audio, sr)."""
    files: list[KitFile] = []
    loop = opts.mode == "loop"
    s_dir, st_dir, m_dir = ("Slices/", "Stems/", "MIDI/") if folders else ("", "", "")
    for sl in slices:
        if sl.source not in sources:
            raise ValueError(f"unknown source '{sl.source}'")
        audio, sr = sources[sl.source]
        data, beats, out_sr = render_slice(audio, sr, sl, opts, bpm)
        files.append(KitFile(s_dir + build_filename(title, bpm, key, sl.name),
                             wav_bytes(data, out_sr, bpm, beats, loop)))
    for name, (audio, sr) in (stems or {}).items():
        data, beats, out_sr = render_stem(audio, sr, opts, bpm)
        files.append(KitFile(st_dir + build_filename(title, bpm, key, name),
                             wav_bytes(data, out_sr, bpm, beats, True)))
    if include_midi and slices:
        files.append(KitFile(m_dir + build_filename(title, bpm, key, "slices", "mid"),
                             build_midi(slices, bpm, title, downbeat)))
    _dedupe(files)
    return files


def _dedupe(files: list[KitFile]) -> None:
    seen: dict[str, int] = {}
    for f in files:
        if f.arcname in seen:
            seen[f.arcname] += 1
            stem, dot, ext = f.arcname.rpartition(".")
            f.arcname = f"{stem}-{seen[f.arcname]}.{ext}"
        else:
            seen[f.arcname] = 1


def zip_bytes(files: list[KitFile]) -> bytes:
    buf = io.BytesIO()
    # WAV doesn't compress well; STORED keeps export fast.
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for f in files:
            z.writestr(f.arcname, f.data)
    return buf.getvalue()


def write_files(files: list[KitFile], dest: Path) -> list[str]:
    out = []
    for f in files:
        p = dest / f.arcname
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".part")
        tmp.write_bytes(f.data)
        tmp.replace(p)
        out.append(str(p))
    return out
