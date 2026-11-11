"""Slice boundary math. Mirrored 1:1 in ui/src/lib/grid.js and docs/formats.md#slicing."""
from __future__ import annotations

import math

MIN_SLICE = 0.05          # seconds; shorter lead-in / tail slices are merged


def round6(x: float) -> float:
    """Round half-up to 1e-6 s — identical to JS Math.round(x * 1e6) / 1e6."""
    return math.floor(x * 1e6 + 0.5) / 1e6


GRID_DIVISIONS = {        # label -> length in beats
    "1/4": 0.25,
    "1/2": 0.5,
    "1": 1.0,
    "1bar": 4.0,
    "2bar": 8.0,
    "4bar": 16.0,
}


def _bounds_to_slices(bounds: list[float], duration: float) -> list[dict]:
    bounds = sorted(b for b in bounds if 0.0 <= b < duration)
    # dedupe boundaries closer than MIN_SLICE
    clean: list[float] = []
    for b in bounds:
        if not clean or b - clean[-1] >= MIN_SLICE:
            clean.append(b)
    if not clean or clean[0] > MIN_SLICE:
        clean.insert(0, 0.0)
    else:
        clean[0] = 0.0
    if duration - clean[-1] < MIN_SLICE and len(clean) > 1:
        clean.pop()
    clean.append(duration)
    return [
        {"start": round6(a), "end": round6(b), "name": f"slice{i + 1:02d}"}
        for i, (a, b) in enumerate(zip(clean[:-1], clean[1:]))
    ]


def grid_slices(bpm: float, downbeat: float, duration: float, division_beats: float) -> list[dict]:
    """Slices every `division_beats` beats, anchored on the downbeat."""
    if bpm <= 0 or division_beats <= 0 or duration <= 0:
        return []
    step = division_beats * 60.0 / bpm
    n0 = math.ceil((0.0 - downbeat) / step - 1e-9)
    bounds = []
    n = n0
    while True:
        t = downbeat + n * step
        if t >= duration:
            break
        bounds.append(t)
        n += 1
    return _bounds_to_slices(bounds, duration)


def transient_slices(onsets: list[float], duration: float) -> list[dict]:
    return _bounds_to_slices(list(onsets), duration)


def snap(t: float, bpm: float, downbeat: float, division_beats: float, duration: float) -> float:
    step = division_beats * 60.0 / bpm
    s = downbeat + round((t - downbeat) / step) * step
    return min(max(s, 0.0), duration)
