"""Fast (DSP) stem separation — seconds, no AI. "Fast mode — expect bleed".

Masks are computed on the mono mix and applied to each channel's STFT so stereo is kept.
Exact parameters: docs/formats.md#fast-dsp-stems.
"""
from __future__ import annotations

from typing import Callable

import librosa
import numpy as np
from scipy.signal import butter, sosfiltfilt

N_FFT = 4096
HOP = 1024
HPSS_MARGIN = 2.0
REPET_WIDTH_SECONDS = 2.0
VOCAL_MARGIN = 10.0
MASK_POWER = 2
BASS_CUTOFF_HZ = 150.0
BASS_ORDER = 8
NN_K = 20            # neighbours per frame for the REPET-SIM median
NN_MELS = 128        # neighbour search runs on a log-mel projection (same frames)
NN_CHUNK = 256
STEMS = ("drums", "bass", "vocals", "other")
EPS = 1e-10


def nn_median_filter(S: np.ndarray, sr: int, width: int, k: int = NN_K) -> np.ndarray:
    """Vectorised equivalent of
        librosa.decompose.nn_filter(S, aggregate=np.median, metric='cosine', width=width)
    restricted to the k most cosine-similar frames (|i-j| >= width), found on a log-mel
    projection. ~6x faster than nn_filter on a 3-minute song; same REPET-SIM idea.
    """
    T = S.shape[1]
    mel = librosa.feature.melspectrogram(S=S ** 2, sr=sr, n_fft=N_FFT, n_mels=NN_MELS)
    feats = np.log1p(mel).astype(np.float32)
    feats /= np.linalg.norm(feats, axis=0, keepdims=True) + EPS
    idx = np.empty((T, k), dtype=np.int64)
    cols = np.arange(T)
    for c in range(0, T, NN_CHUNK):
        rows = cols[c:c + NN_CHUNK]
        sim = feats[:, rows].T @ feats                       # (chunk, T) cosine similarity
        sim[np.abs(rows[:, None] - cols[None, :]) < width] = -np.inf
        idx[rows] = np.argpartition(-sim, k - 1, axis=1)[:, :k]
    out = np.empty_like(S)
    for c in range(0, T, NN_CHUNK):
        out[:, c:c + NN_CHUNK] = np.median(S[:, idx[c:c + NN_CHUNK]], axis=-1)
    return out


def separate(audio: np.ndarray, sr: int, progress: Callable[[float, str], None] | None = None
             ) -> dict[str, np.ndarray]:
    """audio: float32 (channels, samples). Returns {stem: (channels, samples)}."""
    def step(p: float, msg: str) -> None:
        if progress:
            progress(p, msg)

    n = audio.shape[1]
    step(0.05, "STFT")
    D = np.stack([librosa.stft(ch, n_fft=N_FFT, hop_length=HOP) for ch in audio])  # (C,F,T)
    D_mono = librosa.stft(audio.mean(axis=0), n_fft=N_FFT, hop_length=HOP)
    mag = np.abs(D_mono) + EPS

    step(0.2, "Harmonic / percussive split")
    H, P = librosa.decompose.hpss(D_mono, margin=HPSS_MARGIN)
    mask_h = np.abs(H) / mag
    mask_p = np.abs(P) / mag
    mask_res = np.clip(1.0 - mask_h - mask_p, 0.0, 1.0)  # what margin>1 leaves unassigned

    step(0.45, "Vocal extraction (REPET-SIM)")
    S = np.abs(H)
    width = int(librosa.time_to_frames(REPET_WIDTH_SECONDS, sr=sr, hop_length=HOP))
    width = max(1, min(width, (S.shape[1] - 1) // 2))
    if S.shape[1] > 2 * width + NN_K + 2:
        S_f = np.minimum(S, nn_median_filter(S, sr, width))
    else:  # too short for a similarity filter: treat everything as background
        S_f = S
    mask_v = librosa.util.softmask(S - S_f, VOCAL_MARGIN * S_f, power=MASK_POWER)

    def inv(mask: np.ndarray) -> np.ndarray:
        return np.stack([librosa.istft(mask * d, hop_length=HOP, n_fft=N_FFT, length=n)
                         for d in D]).astype(np.float32)

    step(0.7, "Rendering stems")
    drums = inv(mask_p)
    vocals = inv(mask_h * mask_v)
    background = inv(mask_h * (1.0 - mask_v))
    residual = inv(mask_res)

    step(0.85, "Bass filter")
    sos = butter(BASS_ORDER, BASS_CUTOFF_HZ, btype="lowpass", fs=sr, output="sos")
    bass = sosfiltfilt(sos, background, axis=-1).astype(np.float32)
    other = (background - bass + residual).astype(np.float32)
    step(1.0, "Done")
    return {"drums": drums, "bass": bass, "vocals": vocals, "other": other}
