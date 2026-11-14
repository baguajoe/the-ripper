"""Fast (no AI) stem separation: seconds, no model. It only promises what DSP can do.

* "dsp" -> drums / bass / music
    drums  = percussive part of a harmonic/percussive split (HPSS)
    bass   = the harmonic part below 150 Hz (8th-order zero-phase low-pass)
    music  = everything else (harmonic part above 150 Hz + what HPSS left unassigned)
  The three stems sum back to the mix. Vocals stay inside "music": separating vocals needs
  HQ (AI).
* "center_cancel" -> instrumental
    Mid/side vocal removal: lead vocals are usually mixed dead centre, so the side signal
    (L-R) has little vocal. The low end (also centred: kick, bass) is kept from the mid.

Masks are computed on the mono mix and applied to each channel's STFT so stereo is kept.
Exact parameters: docs/formats.md#fast-dsp-stems.
"""
from __future__ import annotations

from typing import Callable

import librosa
import numpy as np
from scipy.signal import butter, sosfiltfilt

from .. import config

N_FFT = 4096
HOP = 1024
HPSS_MARGIN = 2.0
BASS_CUTOFF_HZ = 150.0
BASS_ORDER = 8
CENTER_KEEP_LOW_HZ = 120.0   # center cancel: keep the mid below this (kick + bass)
STEMS = ("drums", "bass", "music")
MODES = config.FAST_MODES
EPS = 1e-10


def _lowpass(x: np.ndarray, sr: int, hz: float) -> np.ndarray:
    sos = butter(BASS_ORDER, hz, btype="lowpass", fs=sr, output="sos")
    return sosfiltfilt(sos, x, axis=-1).astype(np.float32)


def separate(audio: np.ndarray, sr: int, progress: Callable[[float, str], None] | None = None,
             mode: str = "dsp") -> dict[str, np.ndarray]:
    """audio: float32 (channels, samples). Returns {stem: (channels, samples)}."""
    def step(p: float, msg: str) -> None:
        if progress:
            progress(p, msg)

    if mode == "center_cancel":
        return center_cancel(audio, sr, step)
    if mode != "dsp":
        raise ValueError(f"unknown fast mode {mode}")

    n = audio.shape[1]
    step(0.05, "STFT")
    D = np.stack([librosa.stft(ch, n_fft=N_FFT, hop_length=HOP) for ch in audio])  # (C,F,T)
    D_mono = librosa.stft(audio.mean(axis=0), n_fft=N_FFT, hop_length=HOP)
    mag = np.abs(D_mono) + EPS

    step(0.3, "Harmonic / percussive split")
    H, P = librosa.decompose.hpss(D_mono, margin=HPSS_MARGIN)
    mask_h = np.abs(H) / mag
    mask_p = np.abs(P) / mag
    mask_res = np.clip(1.0 - mask_h - mask_p, 0.0, 1.0)  # what margin>1 leaves unassigned

    def inv(mask: np.ndarray) -> np.ndarray:
        return np.stack([librosa.istft(mask * d, hop_length=HOP, n_fft=N_FFT, length=n)
                         for d in D]).astype(np.float32)

    step(0.65, "Rendering stems")
    drums = inv(mask_p)
    harmonic = inv(mask_h)
    residual = inv(mask_res)

    step(0.85, "Bass filter")
    bass = _lowpass(harmonic, sr, BASS_CUTOFF_HZ)
    music = (harmonic - bass + residual).astype(np.float32)
    step(1.0, "Done")
    return {"drums": drums, "bass": bass, "music": music}


def center_cancel(audio: np.ndarray, sr: int, step: Callable[[float, str], None] = lambda p, m: None
                  ) -> dict[str, np.ndarray]:
    step(0.1, "Mid / side")
    if audio.shape[0] < 2:  # mono: nothing to cancel against
        step(1.0, "Done")
        return {"instrumental": np.asarray(audio, dtype=np.float32).copy()}
    left, right = audio[0].astype(np.float32), audio[1].astype(np.float32)
    mid = 0.5 * (left + right)
    side = 0.5 * (left - right)
    step(0.5, "Keeping the low end")
    low = _lowpass(mid, sr, CENTER_KEEP_LOW_HZ)
    inst = np.stack([low + side, low - side]).astype(np.float32)
    step(1.0, "Done")
    return {"instrumental": inst}
