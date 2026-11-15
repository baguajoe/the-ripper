"""Time-stretch and pitch-shift with Signalsmith Stretch (MIT) through python-stretch (MIT).

Used for keep-length pad tuning (pitch without changing length) and for fitting a whole sample
to a target tempo / key (v1.2). See LICENSES.md for why this library and not Rubber Band.
"""
from __future__ import annotations

import numpy as np


def _stretcher(channels: int, sr: int):
    import python_stretch as ps
    st = ps.Signalsmith.Stretch(1)  # fixed seed: the same input always gives the same output
    st.preset(int(channels), float(sr))
    return st


def _fit(out: np.ndarray, length: int) -> np.ndarray:
    if out.shape[1] >= length:
        return np.ascontiguousarray(out[:, :length])
    return np.pad(out, ((0, 0), (0, length - out.shape[1])))


def process(audio: np.ndarray, sr: int, *, time_ratio: float = 1.0, semitones: float = 0.0) -> np.ndarray:
    """audio (channels, n) float32 -> (channels, round(n * time_ratio)).

    time_ratio > 1 makes it longer (slower); semitones transposes without changing tempo."""
    if time_ratio <= 0 or not np.isfinite(time_ratio):
        raise ValueError("time ratio must be positive")
    audio = np.ascontiguousarray(audio, dtype=np.float32)
    n = audio.shape[1]
    length = max(1, int(round(n * time_ratio)))
    if abs(time_ratio - 1.0) < 1e-9 and abs(semitones) < 1e-9:
        return audio.copy()
    st = _stretcher(audio.shape[0], sr)
    st.setTimeFactor(1.0 / time_ratio)
    st.setTransposeSemitones(float(semitones))
    out = np.asarray(st.process(audio), dtype=np.float32)
    return _fit(out, length)


def pitch_shift(audio: np.ndarray, sr: int, semitones: float) -> np.ndarray:
    """Transpose by `semitones` keeping the exact length."""
    return process(audio, sr, semitones=semitones)


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLATS = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


def parse_key(label: str) -> tuple[int, str]:
    """'F#m' / 'Bb' / 'A minor' -> (root 0..11, 'major' | 'minor')."""
    s = (label or "").strip().replace(" minor", "m").replace(" major", "").replace("min", "m")
    minor = s.endswith("m")
    root = s[:-1] if minor else s
    root = _FLATS.get(root, root)
    if root not in NOTE_NAMES:
        raise ValueError(f"unknown key '{label}'")
    return NOTE_NAMES.index(root), "minor" if minor else "major"


def key_shift(from_key: str, to_key: str) -> int:
    """Semitones (-6..+5, the shortest way) that move from_key's tonic to to_key's. A minor key and
    its relative major count as the same key (Am -> C = 0)."""
    def major_root(k):
        r, m = parse_key(k)
        return (r + 3) % 12 if m == "minor" else r
    d = (major_root(to_key) - major_root(from_key)) % 12
    return d - 12 if d > 5 else d


def shifted_key(key: str, semitones: int) -> str:
    r, m = parse_key(key)
    return NOTE_NAMES[(r + semitones) % 12] + ("m" if m == "minor" else "")
