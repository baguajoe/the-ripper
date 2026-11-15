"""Rendered clips: audio the UI's pad engine rendered (tune, envelope, filter, pan, effects,
vintage...) uploaded for the exporter to package as WAVs exactly like a cut slice.

Stored as float32 .npy under <storage>/.clips/<sha1>.<sr>.npy (content-addressed, so re-uploading
the same render is free). Cleaned up after a day like other scratch files.
"""
from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path

import numpy as np

MAX_CLIP_SECONDS = 20 * 60
_ID = re.compile(r"^[0-9a-f]{40}$")


def clip_dir(storage: Path) -> Path:
    return Path(storage) / ".clips"


def valid_id(clip_id: str) -> bool:
    return bool(_ID.match(clip_id or ""))


def store(storage: Path, raw: bytes, sr: int, channels: int) -> str:
    """raw = planar little-endian float32 (all of channel 0, then channel 1...)."""
    if channels not in (1, 2):
        raise ValueError("channels must be 1 or 2")
    if not 8000 <= sr <= 192000:
        raise ValueError("invalid sample rate")
    if len(raw) % (4 * channels):
        raise ValueError("body is not whole float32 frames")
    n = len(raw) // (4 * channels)
    if n < 1 or n > MAX_CLIP_SECONDS * sr:
        raise ValueError("clip is empty or too long")
    data = np.frombuffer(raw, dtype="<f4").reshape(channels, n)
    if not np.all(np.isfinite(data)):
        raise ValueError("clip contains NaN or infinity")
    h = hashlib.sha1()
    h.update(f"{sr}:{channels}:".encode())
    h.update(raw)
    cid = h.hexdigest()
    d = clip_dir(storage)
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{cid}.{sr}.npy"
    if not p.exists():
        tmp = d / f"{cid}.{time.time_ns()}.part"
        with open(tmp, "wb") as f:
            np.save(f, data.astype(np.float32), allow_pickle=False)
        tmp.replace(p)
    else:
        p.touch()
    return cid


def load(storage: Path, clip_id: str) -> tuple[np.ndarray, int]:
    """(audio (2, n) float32, sr)."""
    if not valid_id(clip_id):
        raise ValueError("invalid clip id")
    p = _find(storage, clip_id)
    if p is None:
        raise FileNotFoundError(f"clip {clip_id} not found (render it again)")
    data = np.asarray(np.load(p, allow_pickle=False), dtype=np.float32)
    if data.shape[0] == 1:
        data = np.vstack([data, data])
    return np.ascontiguousarray(data[:2]), int(p.name.split(".")[1])


def _find(storage: Path, clip_id: str) -> Path | None:
    if not valid_id(clip_id):
        return None
    for p in clip_dir(storage).glob(f"{clip_id}.*.npy"):
        return p
    return None


def exists(storage: Path, clip_id: str) -> bool:
    return _find(storage, clip_id) is not None


def purge(storage: Path, max_age: float) -> int:
    d = clip_dir(storage)
    if not d.exists():
        return 0
    now = time.time()
    n = 0
    for p in d.iterdir():
        try:
            if now - p.stat().st_mtime > max_age:
                p.unlink(missing_ok=True)
                n += 1
        except OSError:
            pass
    return n
