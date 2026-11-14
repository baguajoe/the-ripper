"""BPM / beat grid / key / onsets / peaks. All numbers documented in docs/formats.md."""
from __future__ import annotations

import math
import threading
from collections import OrderedDict
from pathlib import Path

import librosa
import numpy as np

from .grid import grid_beats, regrid  # noqa: F401 - re-exported (pure math, no librosa)

ANALYSIS_SR = 22050
HOP = 512
PEAK_COUNT = 160

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Krumhansl-Schmuckler key profiles (Krumhansl & Kessler 1982), index 0 = tonic.
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
# Camelot wheel numbers indexed by pitch class.
CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

_cache_lock = threading.Lock()
_y_cache: "OrderedDict[str, tuple[float, np.ndarray]]" = OrderedDict()


def load_mono(path: Path) -> np.ndarray:
    """Mono 22.05 kHz signal, LRU-cached by (path, mtime)."""
    key = str(path)
    mtime = Path(path).stat().st_mtime
    with _cache_lock:
        hit = _y_cache.get(key)
        if hit and hit[0] == mtime:
            _y_cache.move_to_end(key)
            return hit[1]
    y, _ = librosa.load(str(path), sr=ANALYSIS_SR, mono=True)
    with _cache_lock:
        _y_cache[key] = (mtime, y)
        while len(_y_cache) > 4:
            _y_cache.popitem(last=False)
    return y


# --- tempo + grid -----------------------------------------------------------------------
def estimate_tempo(y: np.ndarray, sr: int = ANALYSIS_SR) -> dict:
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=HOP,
                                           units="time")
    bpm_raw = float(np.atleast_1d(tempo)[0])
    beats = np.asarray(beats, dtype=float)
    bpm = bpm_raw
    if len(beats) >= 4:
        # Least-squares fit of beat index -> time removes the tempogram's bin quantisation.
        slope, _ = np.polyfit(np.arange(len(beats)), beats, 1)
        if slope > 0:
            fitted = 60.0 / slope
            if bpm_raw > 0 and abs(fitted - bpm_raw) / bpm_raw < 0.08:
                bpm = fitted
    if bpm <= 0:
        bpm = 120.0
    if abs(bpm - round(bpm)) < 0.15:
        bpm = float(round(bpm))
    bpm = round(bpm, 2)

    flag = None
    if bpm < 80:
        flag = "maybe_double"
    elif bpm > 160:
        flag = "maybe_half"
    return {
        "bpm": bpm,
        "bpm_raw": round(bpm_raw, 3),
        "bpm_flag": flag,
        "bpm_alternatives": [round(bpm / 2, 2), round(bpm * 2, 2)],
        "detected_beats": [round(float(b), 4) for b in beats],
        "_onset_env": onset_env,
    }


FINE_HOP = 64


def fine_onset_env(y: np.ndarray, sr: int = ANALYSIS_SR) -> np.ndarray:
    """High time-resolution onset envelope (2.9 ms frames) for grid placement."""
    return librosa.onset.onset_strength(y=y, sr=sr, hop_length=FINE_HOP, n_fft=512, n_mels=64)


def refine_beats(beats: np.ndarray, env: np.ndarray, sr: int = ANALYSIS_SR) -> np.ndarray:
    """Move each tracked beat to the strongest fine onset in [-60 ms, +30 ms]."""
    out = []
    for b in beats:
        a = max(0, int((b - 0.060) * sr / FINE_HOP))
        z = min(len(env), int((b + 0.030) * sr / FINE_HOP) + 1)
        if z - a < 2:
            out.append(b)
            continue
        out.append((a + int(np.argmax(env[a:z]))) * FINE_HOP / sr)
    return np.asarray(out, dtype=float)


def grid_anchor(beats: np.ndarray, bpm: float, env: np.ndarray | None = None,
                sr: int = ANALYSIS_SR) -> float:
    """Grid anchor (first downbeat) in [0, beat period) -- see docs/formats.md#grid.

    Each tracked beat is refined against the fine onset envelope `env` (hop FINE_HOP), then
    the anchor is the circular mean phase of the refined beats modulo the beat period."""
    period = 60.0 / bpm
    if len(beats) == 0:
        return 0.0
    if env is not None and len(env):
        beats = refine_beats(np.asarray(beats), env, sr)
    ang = 2 * np.pi * np.asarray(beats) / period
    phase = math.atan2(float(np.mean(np.sin(ang))), float(np.mean(np.cos(ang))))
    offset = (phase / (2 * np.pi) * period) % period
    if period - offset < 0.005:
        offset = 0.0
    # Downbeat = first grid beat. Energy-based downbeat guessing proved unreliable (it is
    # biased by frame alignment even on a uniform kick pattern), so the user shifts it.
    return round(offset, 4)


# --- key ----------------------------------------------------------------------------------
KEY_SR = 11025      # key detection runs on mono audio downsampled to 11.025 kHz
KEY_NFFT = 4096     # 2.7 Hz bins: enough to separate semitones down to ~E2
KEY_HOP = 2048      # 0.19 s frames


def key_chroma_profile(y: np.ndarray, sr: int = ANALYSIS_SR) -> np.ndarray:
    """Mean 12-bin chroma of the harmonic part of y, computed cheaply.

    v1.1.0 ran HPSS + a constant-Q transform on the full 22 kHz signal: ~13 s and several
    hundred MB of native buffers for a 4-minute song (the step that crashed in the field).
    This does the same on 11 kHz mono with 0.19 s frames - ~2 s and ~20x less memory."""
    y_k = librosa.resample(y, orig_sr=sr, target_sr=KEY_SR, res_type="soxr_hq") if sr != KEY_SR else y
    S = np.abs(librosa.stft(y_k, n_fft=KEY_NFFT, hop_length=KEY_HOP))
    harmonic = librosa.decompose.hpss(S, kernel_size=(17, 31), margin=4.0)[0]
    chroma = librosa.feature.chroma_stft(S=harmonic ** 2, sr=KEY_SR, n_fft=KEY_NFFT, tuning=0.0)
    return chroma.mean(axis=1)


def estimate_key(y: np.ndarray, sr: int = ANALYSIS_SR) -> dict:
    profile = key_chroma_profile(y, sr) if len(y) else np.zeros(12)
    if not np.any(profile > 0):
        return {"key": None, "key_root": None, "key_mode": None, "key_confidence": 0.0,
                "camelot": None}
    best = (-2.0, 0, "major")
    for root in range(12):
        for mode, tmpl in (("major", KS_MAJOR), ("minor", KS_MINOR)):
            r = float(np.corrcoef(profile, np.roll(tmpl, root))[0, 1])
            if r > best[0]:
                best = (r, root, mode)
    r, root, mode = best
    return {
        "key": key_label(root, mode),
        "key_root": NOTE_NAMES[root],
        "key_mode": mode,
        "key_confidence": round(r, 3),
        "camelot": f"{(CAMELOT_MINOR if mode == 'minor' else CAMELOT_MAJOR)[root]}"
                   f"{'A' if mode == 'minor' else 'B'}",
    }


def key_label(root: int, mode: str) -> str:
    return NOTE_NAMES[root] + ("m" if mode == "minor" else "")


# --- onsets + peaks -------------------------------------------------------------------------
def onset_params(sensitivity: float) -> dict:
    s = min(1.0, max(0.0, float(sensitivity)))
    return {"delta": round(0.02 + (1.0 - s) * 0.28, 4), "wait": int(round((1.0 - s) * 8)) + 1}


def detect_onsets(y: np.ndarray, sensitivity: float = 0.5, sr: int = ANALYSIS_SR) -> list[float]:
    p = onset_params(sensitivity)
    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=HOP, units="time",
                                        backtrack=True, delta=p["delta"], wait=p["wait"],
                                        pre_max=1, post_max=1, pre_avg=3, post_avg=3)
    return [round(float(t), 4) for t in onsets]


def peaks(y: np.ndarray, count: int = PEAK_COUNT) -> list[float]:
    if len(y) == 0:
        return [0.0] * count
    edges = np.linspace(0, len(y), count + 1).astype(int)
    out = [float(np.max(np.abs(y[a:b]))) if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])]
    top = max(out) or 1.0
    return [round(v / top, 3) for v in out]


# --- entry point ----------------------------------------------------------------------------
def analyze(path: Path, progress=None) -> dict:
    def step(p: float, msg: str) -> None:
        if progress:
            progress(p, msg)

    step(0.05, "Loading audio")
    y = load_mono(path)
    duration = len(y) / ANALYSIS_SR
    step(0.25, "Detecting tempo")
    tempo = estimate_tempo(y)
    tempo.pop("_onset_env")
    downbeat = grid_anchor(np.array(tempo["detected_beats"]), tempo["bpm"], fine_onset_env(y))
    step(0.6, "Detecting key")
    key = estimate_key(y)
    step(0.9, "Building waveform")
    return {
        **tempo,
        "downbeat": downbeat,
        "beats": grid_beats(tempo["bpm"], downbeat, duration),
        **key,
        "peaks": peaks(y),
        "duration": round(duration, 4),
    }
