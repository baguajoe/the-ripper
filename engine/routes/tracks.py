from __future__ import annotations

import math
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from .. import config
from ..app import ApiError
from ..services import analyzer, chopper, downloader, media, pipeline, separator_ai
from ..services.library import public_track
from .common import body, require_feature, require_track, state

bp = Blueprint("tracks", __name__)


def _with_job(track: dict) -> dict:
    out = public_track(track)
    job = state().jobs.public(track["job_id"]) if track.get("job_id") else None
    out["job"] = job
    return out


@bp.post("/tracks/link")
def import_link():
    data = body()
    url = (data.get("url") or "").strip()
    if not downloader.validate_url(url):
        raise ApiError(400, "invalid_url", "Paste a full http(s) link")
    st = state()
    track = st.library.create(title=url[:120], source="link", status="downloading", url=url)
    job_id = st.jobs.submit("import", pipeline.process_link, st.library, track["id"], url,
                            meta={"track_id": track["id"]})
    st.library.update(track["id"], job_id=job_id)
    return jsonify(job_id=job_id, track_id=track["id"]), 202


@bp.post("/tracks/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        raise ApiError(400, "no_file", "Send the audio as multipart field 'file'")
    ext = Path(f.filename).suffix.lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise ApiError(400, "unsupported_type", "Only WAV and MP3 files are supported")
    st = state()
    title = Path(f.filename).stem[:120] or "Untitled"
    track = st.library.create(title=title, source="upload", status="analyzing")
    d = st.library.track_dir(track["id"])
    src = d / f"upload{ext}"
    f.save(str(src))
    if src.stat().st_size > config.MAX_UPLOAD_BYTES:
        st.library.delete(track["id"])
        raise ApiError(413, "file_too_large", "Max upload is 200 MB")
    info = media.probe(src)
    if not info or not info.get("duration"):
        st.library.delete(track["id"])
        raise ApiError(400, "invalid_audio", "That file isn't readable audio")
    job_id = st.jobs.submit("import", pipeline.process_upload, st.library, track["id"], src,
                            meta={"track_id": track["id"]})
    st.library.update(track["id"], job_id=job_id)
    return jsonify(job_id=job_id, track_id=track["id"]), 202


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
        fields["analysis"] = analyzer.regrid(track["analysis"], track["duration"], bpm, downbeat)
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


@bp.get("/tracks/<track_id>/onsets")
def onsets(track_id: str):
    require_track(track_id, ready=True)
    y = analyzer.load_mono(state().library.track_dir(track_id) / _source_file(track_id))
    s = _sensitivity()
    return jsonify(sensitivity=s, onsets=analyzer.detect_onsets(y, s))


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
        y = analyzer.load_mono(state().library.track_dir(track_id) / "source.wav")
        out = chopper.transient_slices(analyzer.detect_onsets(y, _sensitivity()), track["duration"])
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
        probe = separator_ai.probe()
        if not probe["available"]:
            raise ApiError(409, "ai_unavailable", probe["reason"])
    else:
        raise ApiError(400, "invalid_engine", "engine must be 'ai' or 'dsp'")
    st = state()
    job_id = st.jobs.submit("stems", pipeline.run_stems, st.library, track_id, engine, model,
                            meta={"track_id": track_id})
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
