"""Session files: save / open (.ripper). The audio travels inside the file."""
from __future__ import annotations

import os
from pathlib import Path

from flask import Blueprint, jsonify

from .. import config
from ..app import ApiError
from ..services import sessions
from ..services.library import public_track
from .common import body, require_track, run_quick, state

bp = Blueprint("sessions", __name__)


def _path(data: dict, key: str = "path") -> str:
    p = data.get(key)
    if not isinstance(p, str) or not os.path.isabs(p) or not p.lower().endswith(".ripper"):
        raise ApiError(400, "invalid_path", "path must be an absolute .ripper file path")
    return p


@bp.post("/sessions/save")
def save():
    """{track_id, state, path} or {track_id, state, autosave: true}. A saved session's track is
    pinned (never cleaned up); autosaves of unsaved work go to <app data>/autosave/."""
    data = body()
    track = require_track(str(data.get("track_id", "")), ready=True)
    st = data.get("state")
    if not isinstance(st, dict):
        raise ApiError(400, "invalid_state", "state must be an object")
    if data.get("autosave") and not data.get("path"):
        path = str(config.app_data_dir() / "autosave" / f"{track['id']}.ripper")
    else:
        path = _path(data)
    lib = state().library
    res = run_quick("engine.services.pipeline:save_session",
                    (path, str(lib.track_dir(track["id"])), track, st, config.ENGINE_VERSION), "Save session")
    if not data.get("autosave"):
        lib.update(track["id"], pinned=True, session_path=path)
    return jsonify(**res)


@bp.post("/sessions/open")
def open_session():
    """{path} -> {track, state, version, saved}. Re-opening the same file reuses its track."""
    data = body()
    path = _path(data)
    if not Path(path).is_file():
        raise ApiError(404, "not_found", "Session file not found")
    try:
        doc = sessions.read_doc(path)
    except sessions.SessionError as exc:
        raise ApiError(400, "invalid_session", str(exc))
    lib = state().library
    saved = doc.get("saved")
    for t in lib.list():
        if t.get("session_path") == path and t.get("session_saved") == saved and t.get("status") == "ready":
            return jsonify(track=public_track(t), state=doc.get("state"), version=doc["version"], saved=saved)
    info = doc.get("track") or {}
    track = lib.create(title=str(info.get("title") or Path(path).stem)[:160], source="session", status="analyzing")
    try:
        run_quick("engine.services.pipeline:open_session", (path, str(lib.track_dir(track["id"]))), "Open session")
    except ApiError:
        lib.delete(track["id"])
        raise
    stems = doc.get("stems_meta") if doc.get("stems") else None
    t = lib.update(track["id"], status="ready", duration=info.get("duration"), sr=info.get("sr"),
                   analysis=info.get("analysis"), stems=stems, pinned=True, session_path=path, session_saved=saved)
    return jsonify(track=public_track(t), state=doc.get("state"), version=doc["version"], saved=saved)
