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
