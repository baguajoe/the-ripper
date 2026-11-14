"""Track library: one folder per track under storage/, named by UUID.

storage/<track_id>/
    meta.json         metadata + analysis (source of truth)
    source.wav        44.1 kHz stereo float WAV (converted by ffmpeg)
    stems/<name>.wav  current stem set
"""
from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger("ripper.library")

PUBLIC_FIELDS = (
    "id", "title", "source", "url", "created", "status", "error", "job_id",
    "duration", "sr", "analysis", "stems", "crashed", "from_video",
)


class Library:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._tracks: dict[str, dict[str, Any]] = {}
        self._load()

    # --- persistence -----------------------------------------------------------------
    def _load(self) -> None:
        for d in self.root.iterdir():
            meta = d / "meta.json"
            if d.is_dir() and meta.exists():
                try:
                    data = json.loads(meta.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                # Jobs don't survive a restart: anything mid-flight is now an error.
                if data.get("status") not in ("ready", "error"):
                    data["status"] = "error"
                    data["error"] = "Interrupted (engine restarted)"
                self._tracks[data["id"]] = data

    def _write(self, track: dict) -> None:
        d = self.track_dir(track["id"])
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "meta.json.tmp"
        tmp.write_text(json.dumps(track), encoding="utf-8")
        tmp.replace(d / "meta.json")

    # --- API -------------------------------------------------------------------------
    def track_dir(self, track_id: str) -> Path:
        return self.root / track_id

    def create(self, title: str, source: str, status: str, url: str | None = None) -> dict:
        track = {
            "id": uuid.uuid4().hex,
            "title": title,
            "source": source,
            "url": url,
            "created": time.time(),
            "status": status,
            "error": None,
            "job_id": None,
            "duration": None,
            "sr": None,
            "analysis": None,
            "stems": None,
        }
        with self._lock:
            self._tracks[track["id"]] = track
            self._write(track)
        return dict(track)

    def get(self, track_id: str) -> dict | None:
        with self._lock:
            t = self._tracks.get(track_id)
            return json.loads(json.dumps(t)) if t else None

    def update(self, track_id: str, **fields: Any) -> dict | None:
        with self._lock:
            t = self._tracks.get(track_id)
            if not t:
                return None
            t.update(fields)
            self._write(t)
            return dict(t)

    def list(self) -> list[dict]:
        with self._lock:
            tracks = sorted(self._tracks.values(), key=lambda t: t["created"], reverse=True)
            return [json.loads(json.dumps(t)) for t in tracks]

    def delete(self, track_id: str) -> bool:
        with self._lock:
            if track_id not in self._tracks:
                return False
            del self._tracks[track_id]
        shutil.rmtree(self.track_dir(track_id), ignore_errors=True)
        return True

    def purge(self, max_age: float) -> int:
        """Delete track folders (and stray files) older than max_age seconds."""
        now = time.time()
        removed = 0
        for p in list(self.root.iterdir()):
            if p.name.startswith("."):
                continue
            try:
                age = now - p.stat().st_mtime
            except OSError:
                continue
            track = self._tracks.get(p.name)
            if track:
                age = now - track.get("created", now)
            if age > max_age:
                with self._lock:
                    self._tracks.pop(p.name, None)
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink(missing_ok=True)
                removed += 1
        if removed:
            log.info("purged %d old item(s) from storage", removed)
        return removed


def public_track(track: dict) -> dict:
    out = {k: track.get(k) for k in PUBLIC_FIELDS}
    return out
