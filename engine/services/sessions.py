"""Session files (.ripper): a zip with session.json (the editor's whole state + the track's
analysis) and the audio (FLAC, 24-bit: the source and any stems). See docs/formats.md#sessions.

The engine only checks the envelope ({format, version}); the UI migrates the state inside it
(ui/src/lib/session.js), so older sessions always open.
"""
from __future__ import annotations

import json
import time
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf

FORMAT = "the-ripper-session"
VERSION = 2            # bump with a migration in ui/src/lib/session.js
MAX_JSON = 32 * 1024 * 1024


class SessionError(Exception):
    pass


def _flac(wav: Path) -> bytes:
    import io
    data, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    buf = io.BytesIO()
    sf.write(buf, np.clip(data, -1, 1), sr, format="FLAC", subtype="PCM_24")
    return buf.getvalue()


def save(path: str, track_dir: str, track: dict, state: dict, app_version: str) -> dict:
    """Write the session atomically. Returns {path, bytes}."""
    d = Path(track_dir)
    doc = {
        "format": FORMAT, "version": VERSION, "app_version": app_version, "saved": time.time(),
        "track": {k: track.get(k) for k in ("id", "title", "duration", "sr", "analysis")},
        "stems": list((track.get("stems") or {}).get("names", [])),
        "stems_meta": track.get("stems"),
        "state": state,
    }
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".part")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("session.json", json.dumps(doc))
        z.writestr("audio/source.flac", _flac(d / "source.wav"), compress_type=zipfile.ZIP_STORED)
        for n in doc["stems"]:
            s = d / "stems" / f"{n}.wav"
            if s.exists():
                z.writestr(f"audio/stems/{n}.flac", _flac(s), compress_type=zipfile.ZIP_STORED)
    tmp.replace(p)
    return {"path": str(p), "bytes": p.stat().st_size}


def read_doc(path: str) -> dict:
    """session.json of a session file (validated envelope)."""
    try:
        with zipfile.ZipFile(path) as z:
            info = z.getinfo("session.json")
            if info.file_size > MAX_JSON:
                raise SessionError("session.json is too big")
            doc = json.loads(z.read("session.json"))
            if "audio/source.flac" not in z.namelist():
                raise SessionError("The session has no audio")
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, OSError) as exc:
        raise SessionError(f"Not a The Ripper session ({exc.__class__.__name__})")
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        raise SessionError("Not a The Ripper session")
    v = doc.get("version")
    if not isinstance(v, int) or v < 1:
        raise SessionError("Unknown session version")
    if v > VERSION:
        raise SessionError(f"This session was saved by a newer version of The Ripper (format {v}) - update the app to open it")
    return doc


def extract(path: str, track_dir: str) -> dict:
    """Write the session's audio into a track folder (source.wav + stems). Returns the doc."""
    doc = read_doc(path)
    d = Path(track_dir)
    d.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.startswith("audio/") or not name.endswith(".flac") or ".." in name:
                continue
            rel = name[len("audio/"):-len(".flac")]
            if rel != "source" and not (rel.startswith("stems/") and "/" not in rel[6:]):
                continue
            import io
            data, sr = sf.read(io.BytesIO(z.read(name)), dtype="float32", always_2d=True)
            out = d / f"{rel}.wav"
            out.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(out), data, sr, subtype="FLOAT")
    return doc
