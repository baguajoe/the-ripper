"""Beat-grid math with no audio libraries, so the engine's HTTP process can re-grid a track
without importing librosa/numba. Documented in docs/formats.md#grid."""
from __future__ import annotations

import math


def grid_beats(bpm: float, downbeat: float, duration: float) -> list[float]:
    """Grid beat times in [0, duration). Beat k = downbeat + k*60/bpm (k may be negative)."""
    period = 60.0 / bpm
    k0 = math.ceil((0.0 - downbeat) / period - 1e-9)
    out = []
    k = k0
    while True:
        t = downbeat + k * period
        if t >= duration - 1e-6:
            break
        if t >= -1e-9:
            out.append(math.floor(max(t, 0.0) * 1e6 + 0.5) / 1e6)  # == JS Math.round(x*1e6)/1e6
        k += 1
    return out


def regrid(analysis: dict, duration: float, bpm: float | None = None,
           downbeat: float | None = None) -> dict:
    out = dict(analysis)
    if bpm is not None:
        out["bpm"] = round(float(bpm), 3)
        out["bpm_flag"] = None
        out["bpm_alternatives"] = [round(out["bpm"] / 2, 3), round(out["bpm"] * 2, 3)]
    if downbeat is not None:
        out["downbeat"] = round(float(downbeat), 4)
    out["beats"] = grid_beats(out["bpm"], out["downbeat"], duration)
    return out
