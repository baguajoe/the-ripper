"""Slice boundary math. Mirrored 1:1 in ui/src/lib/grid.js and docs/formats.md#slicing."""
from __future__ import annotations

import math

MIN_SLICE = 0.05          # seconds; no slice is ever shorter than this
MAX_TRANSIENTS = 16       # default cap for transient chops inside a selection
EVEN_COUNTS = (8, 16, 32)


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


def half_beat(bpm: float) -> float:
    return 30.0 / bpm if bpm > 0 else MIN_SLICE


def _name(i: int) -> str:
    return f"slice{i + 1:02d}"


def _bounds_to_slices(bounds: list[float], duration: float, lead_min: float = MIN_SLICE) -> list[dict]:
    """Whole-track slices from boundary times. A lead-in before the first boundary shorter
    than `lead_min` is merged into the first slice; a tail shorter than MIN_SLICE into the last."""
    bounds = sorted(b for b in bounds if 0.0 <= b < duration)
    # dedupe boundaries closer than MIN_SLICE
    clean: list[float] = []
    for b in bounds:
        if not clean or b - clean[-1] >= MIN_SLICE:
            clean.append(b)
    if not clean or clean[0] > lead_min:
        clean.insert(0, 0.0)
    else:
        clean[0] = 0.0
    if duration - clean[-1] < MIN_SLICE and len(clean) > 1:
        clean.pop()
    clean.append(duration)
    return [
        {"start": round6(a), "end": round6(b), "name": _name(i)}
        for i, (a, b) in enumerate(zip(clean[:-1], clean[1:]))
    ]


def _grid_points(bpm: float, downbeat: float, start: float, end: float, division_beats: float) -> list[float]:
    """Grid times downbeat + n*step in [start, end)."""
    step = division_beats * 60.0 / bpm
    out = []
    n = math.ceil((start - downbeat) / step - 1e-9)
    while True:
        t = downbeat + n * step
        if t >= end:
            break
        out.append(t)
        n += 1
    return out


def grid_slices(bpm: float, downbeat: float, duration: float, division_beats: float) -> list[dict]:
    """Whole-track slices every `division_beats` beats, anchored on the downbeat. A lead-in
    before the first grid line shorter than half a beat is merged into slice01."""
    if bpm <= 0 or division_beats <= 0 or duration <= 0:
        return []
    bounds = _grid_points(bpm, downbeat, 0.0, duration, division_beats)
    return _bounds_to_slices(bounds, duration, lead_min=max(MIN_SLICE, half_beat(bpm)))


def transient_slices(onsets: list[float], duration: float) -> list[dict]:
    return _bounds_to_slices(list(onsets), duration)


def snap(t: float, bpm: float, downbeat: float, division_beats: float, duration: float) -> float:
    step = division_beats * 60.0 / bpm
    s = downbeat + round((t - downbeat) / step) * step
    return min(max(s, 0.0), duration)


# --- chopping a selection -------------------------------------------------------------------
def first_downbeat(bpm: float, downbeat: float) -> float:
    """Time of the first bar line at or after 0 s."""
    if bpm <= 0:
        return 0.0
    bar = 240.0 / bpm
    return downbeat - math.floor(downbeat / bar + 1e-9) * bar


def _region_slices(bounds: list[float], start: float, end: float, bpm: float = 0.0,
                   downbeat: float = 0.0) -> list[dict]:
    """Slices of [start, end) from interior boundaries. No slice is shorter than MIN_SLICE, and
    a first slice that lies before the track's first downbeat and is shorter than half a beat
    (a pickup fragment) is merged into the next one."""
    inner = sorted(b for b in bounds if start < b < end)
    clean = [start]
    for b in inner:
        if b - clean[-1] >= MIN_SLICE:
            clean.append(b)
    if len(clean) > 1 and end - clean[-1] < MIN_SLICE:
        clean.pop()
    if bpm > 0 and len(clean) > 1:
        a, b = clean[0], clean[1]
        if b <= first_downbeat(bpm, downbeat) + 1e-6 and b - a < half_beat(bpm):
            del clean[1]
    clean.append(end)
    return [{"start": round6(a), "end": round6(b), "name": _name(i)}
            for i, (a, b) in enumerate(zip(clean[:-1], clean[1:]))]


def even_slices(start: float, end: float, count: int) -> list[dict]:
    """`count` equal slices of [start, end) (fewer if they would be shorter than MIN_SLICE)."""
    length = end - start
    if length <= 0 or count <= 0:
        return []
    count = max(1, min(int(count), int(math.floor(length / MIN_SLICE + 1e-9))))
    step = length / count
    return [{"start": round6(start + i * step), "end": round6(end if i == count - 1 else start + (i + 1) * step),
             "name": _name(i)} for i in range(count)]


def selection_grid_slices(bpm: float, downbeat: float, start: float, end: float, division_beats: float) -> list[dict]:
    if bpm <= 0 or division_beats <= 0 or end - start <= 0:
        return []
    return _region_slices(_grid_points(bpm, downbeat, start, end, division_beats), start, end, bpm, downbeat)


def selection_transient_slices(onsets: list[float], strengths: list[float] | None, start: float, end: float,
                               cap: int = MAX_TRANSIENTS, bpm: float = 0.0, downbeat: float = 0.0) -> list[dict]:
    """Transient slices inside [start, end): at most `cap` slices, keeping the strongest onsets
    (ties: earlier first). The selection start is always a boundary."""
    if end - start <= 0:
        return []
    strengths = list(strengths) if strengths is not None else [1.0] * len(onsets)
    cand = [(t, s) for t, s in zip(onsets, strengths) if start + MIN_SLICE <= t <= end - MIN_SLICE]
    cand.sort(key=lambda x: (-x[1], x[0]))  # strongest first
    kept: list[float] = []
    for t, _s in cand:
        if len(kept) >= max(0, int(cap) - 1):
            break
        if all(abs(t - k) >= MIN_SLICE for k in kept):
            kept.append(t)
    return _region_slices(kept, start, end, bpm, downbeat)


def selection_slices(mode: str, start: float, end: float, *, bpm: float = 0.0, downbeat: float = 0.0,
                     count: int = 16, division_beats: float = 1.0, onsets: list[float] | None = None,
                     strengths: list[float] | None = None, cap: int = MAX_TRANSIENTS) -> list[dict]:
    if mode == "even":
        return even_slices(start, end, count)
    if mode == "grid":
        return selection_grid_slices(bpm, downbeat, start, end, division_beats)
    if mode == "transients":
        return selection_transient_slices(onsets or [], strengths, start, end, cap, bpm, downbeat)
    raise ValueError(f"unknown mode {mode}")
