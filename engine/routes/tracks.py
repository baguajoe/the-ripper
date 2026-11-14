from __future__ import annotations

import math
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from .. import config
from ..app import ApiError
from ..services import chopper, grid, media, pipeline, separator_ai
from ..services.library import public_track
from .common import body, require_feature, require_track, run_quick, state

bp = Blueprint("tracks", __name__)


def _with_job(track: dict) -> dict:
    out = public_track(track)
    job = state().jobs.public(track["job_id"]) if track.get("job_id") else None
    out["job"] = job
    return out


def _start_import(track_id: str, target: str, *args, pool_name: str = "jobs") -> str:
    """Run an import job in a worker; store its results on the track in this process."""
    st = state()
    lib = st.library

    def on_done(result: dict) -> dict:
        lib.update(track_id, status="ready", error=None, crashed=False, **result)
        return {"track_id": track_id}

    def on_error(msg: str, crashed: bool) -> None:
        lib.update(track_id, status="error", error=msg, crashed=crashed)

    job_id = st.jobs.submit("import", target, str(lib.track_dir(track_id)), *args,
                            meta={"track_id": track_id},
                            on_update=lambda fields: lib.update(track_id, **fields),
                            on_done=on_done, on_error=on_error, pool_name=pool_name)
    lib.update(track_id, job_id=job_id)
    return job_id


@bp.post("/tracks/link")
def import_link():
    data = body()
    url = (data.get("url") or "").strip()
    from ..services import downloader
    if not downloader.validate_url(url):
        raise ApiError(400, "invalid_url", "Paste a full http(s) link")
    st = state()
    track = st.library.create(title=url[:120], source="link", status="downloading", url=url)
    job_id = _start_import(track["id"], "engine.services.pipeline:import_link", url)
    return jsonify(job_id=job_id, track_id=track["id"]), 202


def _mb(n: int) -> int:
    return n // (1024 * 1024)


@bp.post("/tracks/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        raise ApiError(400, "no_file", "Send the audio as multipart field 'file'")
    ext = Path(f.filename).suffix.lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise ApiError(400, "unsupported_type",
                       "Unsupported file type. Drop a WAV or MP3, or a video (MP4, MOV, M4V, WEBM, MKV)")
    video = ext in config.VIDEO_EXTENSIONS
    limit = config.max_bytes_for(ext)
    if request.content_length and request.content_length > limit + 1024 * 1024:
        raise ApiError(413, "file_too_large",
                       f"Max {'video' if video else 'audio'} file size is {_mb(limit)} MB")
    st = state()
    title = Path(f.filename).stem[:120] or "Untitled"
    track = st.library.create(title=title, source="upload", status="analyzing")
    st.library.update(track["id"], from_video=video)
    d = st.library.track_dir(track["id"])
    src = d / f"upload{ext}"
    try:
        f.save(str(src))
        if src.stat().st_size > limit:
            raise ApiError(413, "file_too_large",
                           f"Max {'video' if video else 'audio'} file size is {_mb(limit)} MB")
        info = media.inspect(src)
        if video and info["readable"] and not info["has_audio"]:
            raise ApiError(400, "no_audio",
                           f"{f.filename} has no audio track - there's nothing to import")
        if not info["readable"] or not info["has_audio"] or not info["duration"]:
            raise ApiError(400, "invalid_audio",
                           "That file isn't a readable video" if video else "That file isn't readable audio")
    except ApiError:
        st.library.delete(track["id"])
        raise
    job_id = _start_import(track["id"], "engine.services.pipeline:import_file")
    return jsonify(job_id=job_id, track_id=track["id"]), 202


@bp.post("/tracks/<track_id>/retry")
def retry(track_id: str):
    """Re-run a failed import. Uses the single-threaded 'safe' worker pool, so a retry after a
    native crash runs with the most conservative settings."""
    track = require_track(track_id)
    if track.get("status") != "error":
        raise ApiError(409, "not_failed", f"Track is {track.get('status')}")
    d = state().library.track_dir(track_id)
    if pipeline.pending_source(str(d)) or (d / "source.wav").exists():
        target, args = "engine.services.pipeline:import_file", ()
        status = "analyzing"
    elif track.get("url"):
        target, args = "engine.services.pipeline:import_link", (track["url"],)
        status = "downloading"
    else:
        raise ApiError(409, "cannot_retry", "The original file is gone - import it again")
    state().library.update(track_id, status=status, error=None, crashed=False)
    job_id = _start_import(track_id, target, *args, pool_name="safe")
    return jsonify(job_id=job_id, track_id=track_id), 202


@bp.get("/tracks")
def list_tracks():
    return jsonify(tracks=[_with_job(t) for t in state().library.list()])


@bp.get("/tracks/<track_id>")
def get_track(track_id: str):
    return jsonify(_with_job(require_track(track_id)))


@bp.get("/tracks/<track_id>/audio")
def track_audio(track_id: str):
    require_track(track_id, ready=True)
    path = state().library.track_dir(track_id) / "source.wav"
    if not path.exists():
        raise ApiError(404, "not_found", "Audio missing")
    return send_file(path, mimetype="audio/wav", conditional=True, max_age=0)


@bp.patch("/tracks/<track_id>")
def regrid(track_id: str):
    track = require_track(track_id, ready=True)
    data = body()
    bpm, downbeat = data.get("bpm"), data.get("downbeat")
    if bpm is not None:
        try:
            bpm = float(bpm)
        except (TypeError, ValueError):
            raise ApiError(400, "invalid_bpm", "bpm must be a number")
        if not (20 <= bpm <= 400) or not math.isfinite(bpm):
            raise ApiError(400, "invalid_bpm", "bpm must be between 20 and 400")
    if downbeat is not None:
        try:
            downbeat = float(downbeat)
        except (TypeError, ValueError):
            raise ApiError(400, "invalid_downbeat", "downbeat must be a number (seconds)")
        if not math.isfinite(downbeat) or abs(downbeat) > track["duration"]:
            raise ApiError(400, "invalid_downbeat", "downbeat out of range")
    title = data.get("title")
    fields = {}
    if bpm is not None or downbeat is not None:
        fields["analysis"] = grid.regrid(track["analysis"], track["duration"], bpm, downbeat)
    if isinstance(title, str) and title.strip():
        fields["title"] = title.strip()[:120]
    updated = state().library.update(track_id, **fields)
    return jsonify(_with_job(updated))


@bp.delete("/tracks/<track_id>")
def delete_track(track_id: str):
    require_track(track_id)
    state().library.delete(track_id)
    return jsonify(ok=True)


def _sensitivity() -> float:
    try:
        return min(1.0, max(0.0, float(request.args.get("sensitivity", 0.5))))
    except ValueError:
        raise ApiError(400, "invalid_sensitivity", "sensitivity must be 0..1")


def _onsets(track_id: str, rel: str, sensitivity: float) -> list[float]:
    wav = state().library.track_dir(track_id) / rel
    return run_quick("engine.services.pipeline:onsets", (str(wav), sensitivity), "Onset detection")


@bp.get("/tracks/<track_id>/onsets")
def onsets(track_id: str):
    require_track(track_id, ready=True)
    s = _sensitivity()
    return jsonify(sensitivity=s, onsets=_onsets(track_id, _source_file(track_id), s))


def _source_file(track_id: str) -> str:
    src = request.args.get("source", "mix")
    if src == "mix":
        return "source.wav"
    track = require_track(track_id)
    if not track.get("stems") or src not in track["stems"]["names"]:
        raise ApiError(404, "not_found", f"No stem '{src}'")
    return f"stems/{src}.wav"


@bp.get("/tracks/<track_id>/slices")
def slices(track_id: str):
    """Server-side slicing (same math as the UI) for scripts, tests and the plugin."""
    track = require_track(track_id, ready=True)
    a = track["analysis"]
    mode = request.args.get("mode", "grid")
    if mode == "grid":
        div = request.args.get("division", "1bar")
        if div not in chopper.GRID_DIVISIONS:
            raise ApiError(400, "invalid_division", f"division must be one of {list(chopper.GRID_DIVISIONS)}")
        out = chopper.grid_slices(a["bpm"], a["downbeat"], track["duration"],
                                  chopper.GRID_DIVISIONS[div])
    elif mode == "transient":
        out = chopper.transient_slices(_onsets(track_id, "source.wav", _sensitivity()), track["duration"])
    else:
        raise ApiError(400, "invalid_mode", "mode must be grid or transient")
    return jsonify(slices=out)


# --- stems ---------------------------------------------------------------------------------
@bp.post("/tracks/<track_id>/stems")
def start_stems(track_id: str):
    require_track(track_id, ready=True)
    data = body()
    engine = data.get("engine", "dsp")
    model = data.get("model") or "htdemucs"
    if engine == "dsp":
        require_feature("stems_dsp")
    elif engine == "ai":
        if model not in config.DEMUCS_MODELS:
            raise ApiError(400, "invalid_model", f"model must be one of {list(config.DEMUCS_MODELS)}")
        require_feature("stems_ai")
        require_feature(config.DEMUCS_MODELS[model]["pro_feature"])
        probe = separator_ai.probe_remote()
        if not probe["available"]:
            raise ApiError(409, "ai_unavailable", probe["reason"])
    else:
        raise ApiError(400, "invalid_engine", "engine must be 'ai' or 'dsp'")
    st = state()
    lib = st.library

    def on_done(meta: dict) -> dict:
        if lib.get(track_id):
            lib.update(track_id, stems=meta)
        return meta

    job_id = st.jobs.submit("stems", "engine.services.pipeline:run_stems", str(lib.track_dir(track_id)),
                            engine, model, meta={"track_id": track_id}, on_done=on_done)
    return jsonify(job_id=job_id), 202


@bp.get("/tracks/<track_id>/stems")
def list_stems(track_id: str):
    track = require_track(track_id)
    return jsonify(stems=track.get("stems"))


@bp.get("/tracks/<track_id>/stems/<name>")
def get_stem(track_id: str, name: str):
    track = require_track(track_id)
    stems = track.get("stems")
    if not stems or name not in stems.get("names", []):
        raise ApiError(404, "not_found", f"No stem '{name}' — run stem separation first")
    path = state().library.track_dir(track_id) / "stems" / f"{name}.wav"
    if not path.exists():
        raise ApiError(404, "not_found", "Stem file missing")
    return send_file(path, mimetype="audio/wav", conditional=True, max_age=0)
