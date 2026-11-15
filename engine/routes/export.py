from __future__ import annotations

import dataclasses
import io
import os
import shutil
import uuid
from pathlib import Path

from flask import Blueprint, Response, current_app, jsonify, request

from .. import config, runtime, workers
from ..app import ApiError
from ..services import clips, exporter, media, separator_ai, tools
from ..services.exporter import ExportOptions, Slice
from .common import body, require_feature, require_track, run_quick, state

bp = Blueprint("export", __name__)


@bp.get("/health")
def health():
    st = state()
    ai = separator_ai.probe_nowait() or {"available": None, "device": None, "gpu": None,
                                         "reason": "Checking for the HQ (AI) engine…"}
    return jsonify(
        ok=True,
        version=config.ENGINE_VERSION,
        api=config.API_VERSION,
        ffmpeg=media.check_ffmpeg(),
        tools=_tools_status(),
        demucs_available=ai["available"],
        demucs_reason=ai["reason"],
        device=ai["device"],
        gpu=ai.get("gpu"),
        pro=st.pro_enabled,
        features={k: config.is_allowed(k, st.pro_enabled) for k in config.FEATURES},
        models={k: v["label"] for k, v in config.DEMUCS_MODELS.items()},
        fast_models={k: v["label"] for k, v in config.FAST_MODES.items()},
        max_upload_mb=config.MAX_UPLOAD_BYTES // (1024 * 1024),
        max_video_mb=config.MAX_VIDEO_BYTES // (1024 * 1024),
        audio_extensions=sorted(config.AUDIO_EXTENSIONS),
        video_extensions=sorted(config.VIDEO_EXTENSIONS),
        threads={"cpus": runtime.cpu_count(), "cap": runtime.thread_cap(),
                 **{k: os.environ.get(k) for k in runtime.THREAD_VARS}},
        workers={"isolated": True, "crashes": sum(p.crashes for p in workers._pools.values())},
        started=st.started,
    )


def _tools_status() -> dict:
    """Where each tool came from (no paths: /health is unauthenticated)."""
    out = {n: (t.source if (t := tools.find(n)) else None) for n in ("ffmpeg", "ffprobe")}
    js = tools.js_runtime()
    out["js_runtime"] = {"name": js.name, "source": js.source, "version": js.version} if js else None
    return out


@bp.post("/shutdown")
def shutdown():
    fn = current_app.extensions.get("ripper_shutdown")
    if fn:
        fn()
    return jsonify(ok=True)


# --- request parsing -----------------------------------------------------------------------
def _options(data: dict) -> ExportOptions:
    mode = data.get("mode", "oneshot")
    if mode not in ("oneshot", "loop"):
        raise ApiError(400, "invalid_mode", "mode must be 'oneshot' or 'loop'")
    try:
        sr = int(data.get("sr", 44100))
    except (TypeError, ValueError):
        sr = 0
    if sr not in (44100, 48000):
        raise ApiError(400, "invalid_sr", "sr must be 44100 or 48000")
    return ExportOptions(mode=mode, sr=sr, normalize=bool(data.get("normalize", False)),
                         trim_silence=bool(data.get("trim_silence", data.get("trim", False))))


def _slices(data: dict, duration: float) -> list[Slice]:
    raw = data.get("slices") or []
    if not isinstance(raw, list):
        raise ApiError(400, "invalid_slices", "slices must be a list")
    if len(raw) > 512:
        raise ApiError(400, "invalid_slices", "too many slices (max 512)")
    out = []
    for i, d in enumerate(raw):
        if not isinstance(d, dict):
            raise ApiError(400, "invalid_slices", f"slice {i + 1} must be an object")
        try:
            sl = Slice.from_dict(d, i)
        except (KeyError, TypeError, ValueError) as exc:
            raise ApiError(400, "invalid_slices", str(exc) or f"slice {i + 1} is invalid")
        if sl.start >= duration:
            raise ApiError(400, "invalid_slices", f"slice {i + 1} starts after the end of the track")
        if sl.clip and not clips.exists(state().library.root, sl.clip):
            raise ApiError(404, "clip_not_found", f"slice {i + 1}: rendered clip not found - try again")
        sl.end = min(sl.end, duration)
        out.append(sl)
    return out


def _stem_names(track: dict, data: dict) -> tuple[list[str], bool]:
    """(stem names, make_dsp_stems). 'all' before any stems exist = run the fast DSP split."""
    want = data.get("stems")
    if want is None and data.get("include_stems"):
        want = "all"
    if not want:
        return [], False
    if want == "all":
        if not track.get("stems"):
            return list(DSP_STEMS), True
        return list(track["stems"]["names"]), False
    if not isinstance(want, list):
        raise ApiError(400, "invalid_stems", "stems must be a list of names or 'all'")
    have = (track.get("stems") or {}).get("names", [])
    missing = [n for n in want if n not in have]
    if missing:
        raise ApiError(404, "not_found", f"No stem(s) {missing} — run stem separation first")
    return want, False


DSP_STEMS = ("drums", "bass", "vocals", "other")


def _beat_parts(data: dict, duration: float) -> dict:
    """v1.2 beat exports in an export body: items (rendered clips: the beat, pad stems), midi_items
    (sequencer MIDI) and positioned (chops in original position). See docs/formats.md#beat-exports."""
    import base64
    import binascii

    def text(v, what, n=80):
        if not isinstance(v, str) or not v.strip() or len(v) > n:
            raise ApiError(400, "invalid_items", f"{what} must be a short non-empty string")
        return v
    items = data.get("items") or []
    midi = data.get("midi_items") or []
    if not isinstance(items, list) or not isinstance(midi, list) or len(items) + len(midi) > 300:
        raise ApiError(400, "invalid_items", "items / midi_items must be lists (max 300)")
    out_items = []
    for it in items:
        if not isinstance(it, dict):
            raise ApiError(400, "invalid_items", "each item must be an object")
        cid = str(it.get("clip") or "")
        if not clips.exists(state().library.root, cid):
            raise ApiError(404, "clip_not_found", "rendered clip not found - try again")
        out_items.append({"clip": cid, "prefix": text(it.get("prefix"), "prefix", 12), "name": text(it.get("name"), "name"),
                          "folder": str(it.get("folder") or "")[:40], "loop": bool(it.get("loop", False))})
    out_midi = []
    for m in midi:
        try:
            raw = base64.b64decode(str(m.get("data_b64", "")), validate=True)
        except (binascii.Error, ValueError, AttributeError):
            raise ApiError(400, "invalid_items", "midi data must be base64")
        if not raw.startswith(b"MThd") or len(raw) > 4 * 1024 * 1024:
            raise ApiError(400, "invalid_items", "not a MIDI file")
        out_midi.append({"data_b64": base64.b64encode(raw).decode(), "prefix": text(m.get("prefix"), "prefix", 12),
                         "name": text(m.get("name"), "name"), "folder": str(m.get("folder") or "")[:40]})
    pos = data.get("positioned")
    out_pos = None
    if pos:
        if not isinstance(pos, dict):
            raise ApiError(400, "invalid_positioned", "positioned must be an object")
        try:
            start, end = float(pos.get("start", 0)), float(pos.get("end", duration))
        except (TypeError, ValueError):
            raise ApiError(400, "invalid_positioned", "start / end must be numbers")
        end = min(end, duration)
        if not (0 <= start < end):
            raise ApiError(400, "invalid_positioned", "start / end must be a range inside the track")
        sl = _slices({"slices": pos.get("slices") or []}, duration)
        if not sl:
            raise ApiError(400, "invalid_positioned", "positioned needs at least one slice")
        out_pos = {"start": start, "end": end, "folder": str(pos.get("folder") or "")[:40],
                   "slices": [dataclasses.asdict(x) for x in sl]}
    return {"items": out_items, "midi_items": out_midi, "positioned": out_pos}


def _gate(n_slices: int, n_stems: int, midi: bool, n_beat: int = 0) -> None:
    if n_beat > 1 or (n_beat and (n_slices or n_stems)):
        require_feature("batch_export")
    if n_slices > 1:
        require_feature("batch_export")
    if midi or (n_stems and n_slices) or n_stems > 1:
        require_feature("export_kit")
    if n_slices + n_stems + n_beat == 1 and not midi:
        require_feature("single_export")


def _spec(track: dict, data: dict, out: dict, kind: str | None = None, folders: bool = True) -> dict:
    """Validate an export request in the engine process; the worker only renders."""
    opts = _options(data)
    slices = _slices(data, track["duration"])
    midi = bool(data.get("include_midi", False)) or kind == "midi"
    stem_names, make_dsp = _stem_names(track, data)
    beat = _beat_parts(data, track["duration"])
    n_beat = len(beat["items"]) + len(beat["midi_items"]) + (len(beat["positioned"]["slices"]) if beat["positioned"] else 0)
    if kind == "midi":
        _gate(0, 0, True)
    else:
        _gate(len(slices), len(stem_names), midi, n_beat)
    if not slices and not stem_names and not n_beat:
        raise ApiError(400, "nothing_to_export", "Add at least one slice or stem")
    have = set((track.get("stems") or {}).get("names", []))
    for sl in slices:
        if sl.source != "mix" and sl.source not in have:
            raise ApiError(404, "not_found", f"No stem '{sl.source}'")
    a = track["analysis"]
    return {"title": track["title"], "bpm": a["bpm"], "key": a.get("key"),
            "downbeat": a.get("downbeat"), "options": dataclasses.asdict(opts),
            "slices": [dataclasses.asdict(s) for s in slices], "stems": stem_names,
            "make_dsp_stems": make_dsp, "include_midi": midi and bool(slices), "midi_only": kind == "midi", **beat,
            "folders": folders, "out": out}


def _render(track: dict, spec: dict) -> dict:
    lib = state().library
    tid = track["id"]

    def on_update(fields: dict) -> None:
        if lib.get(tid):
            lib.update(tid, **fields)

    return run_quick("engine.services.pipeline:build_files", (str(lib.track_dir(tid)), spec),
                     "Export", on_update=on_update)


@bp.post("/tracks/<track_id>/export")
def export(track_id: str):
    """Returns a zip (or a single WAV when `format: 'wav'` and exactly one file results)."""
    track = require_track(track_id, ready=True)
    data = body()
    a = track["analysis"]
    tmp = Path(current_app.config["RIPPER_STORAGE"]) / ".exports" / uuid.uuid4().hex
    single = data.get("format") == "wav"
    out = {"kind": "dir", "dir": str(tmp)} if single else {"kind": "zip", "path": str(tmp / "kit.zip")}
    spec = _spec(track, data, out)
    try:
        files = _render(track, spec)["files"]
        if single and len(files) == 1:
            p = Path(files[0])
            name = p.name
            mime = "audio/midi" if name.endswith(".mid") else "audio/wav"
            return _attachment(p.read_bytes(), name, mime)
        if single:  # more than one file: zip them like a normal export
            import zipfile
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
                for f in files:
                    z.write(f, os.path.relpath(f, tmp))
            data_bytes = buf.getvalue()
        else:
            data_bytes = Path(files[0]).read_bytes()
        name = f"{exporter.base_name(track['title'], a['bpm'], a.get('key'))}_Kit.zip"
        return _attachment(data_bytes, name, "application/zip")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _attachment(data: bytes, name: str, mime: str) -> Response:
    resp = Response(data, mimetype=mime)
    resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
    resp.headers["X-Ripper-Filename"] = name
    return resp


@bp.post("/tracks/<track_id>/render")
def render(track_id: str):
    """Render WAV/MIDI files straight into a local folder (drag-to-DAW + export-to-folder).

    body: {kind: 'slice'|'slices'|'stem'|'kit'|'midi', dest_dir, slices, stems, subfolder?,
           mode, sr, normalize, trim_silence, include_midi}
    """
    track = require_track(track_id, ready=True)
    data = body()
    kind = data.get("kind", "slices")
    if kind not in ("slice", "slices", "stem", "kit", "midi", "beat"):
        raise ApiError(400, "invalid_kind", "kind must be slice, slices, stem, kit, midi or beat")
    dest = data.get("dest_dir")
    if not isinstance(dest, str) or not os.path.isabs(dest) or not Path(dest).is_dir():
        raise ApiError(400, "invalid_dest", "dest_dir must be an existing absolute folder")
    if kind == "slice" and len(data.get("slices") or []) != 1:
        raise ApiError(400, "invalid_slices", "kind 'slice' needs exactly one slice")
    if kind == "stem":
        if not isinstance(data.get("stems"), list) or len(data["stems"]) != 1:
            raise ApiError(400, "invalid_stems", "kind 'stem' needs exactly one stem name")
        data = {**data, "slices": []}
    if kind == "beat":  # beat WAV / pattern MIDI / pad stems / chops in place only
        data = {**data, "slices": [], "stems": None, "include_midi": False}
    if kind == "kit":
        data = {**data, "include_midi": data.get("include_midi", True),
                "stems": data.get("stems", "all") if data.get("stems") is not None else "all"}
    target = Path(dest)
    sub = data.get("subfolder")
    if isinstance(sub, str) and sub.strip():
        target = target / exporter.sanitize(sub, "Export", 80)
    spec = _spec(track, data, {"kind": "dir", "dir": str(target)}, kind=kind,
                 folders=bool(data.get("folders", False)))
    return jsonify(files=_render(track, spec)["files"])


# --- rendered clips (v1.2): the UI's pad engine renders shaped pads, the exporter packages them ---
@bp.post("/clips")
def upload_clip():
    """Body: planar little-endian float32 (channel 0, then channel 1). Headers X-Ripper-SR and
    X-Ripper-Channels. Returns {clip: id} for use as `clip` on an export slice."""
    try:
        sr = int(request.headers.get("X-Ripper-SR", "0"))
        ch = int(request.headers.get("X-Ripper-Channels", "2"))
        cid = clips.store(state().library.root, request.get_data(cache=False), sr, ch)
    except ValueError as exc:
        raise ApiError(400, "invalid_clip", str(exc))
    return jsonify(clip=cid)


@bp.post("/tracks/<track_id>/pitch")
def pitch(track_id: str):
    """A slice transposed by `semitones` with its length kept (keep-length pad tuning).
    body: {start, end, semitones, source='mix'} -> planar float32 bytes, same headers as /clips."""
    require_feature("fit")  # keep-length tuning is time-stretching
    track = require_track(track_id, ready=True)
    data = body()
    try:
        start, end = float(data["start"]), float(data["end"])
        st = float(data["semitones"])
    except (KeyError, TypeError, ValueError):
        raise ApiError(400, "invalid_request", "start, end and semitones are required numbers")
    if not (0 <= start < end <= track["duration"] + 1e-6) or end - start > 120:
        raise ApiError(400, "invalid_request", "start/end must be inside the track (max 120 s)")
    if not -48 <= st <= 48:
        raise ApiError(400, "invalid_request", "semitones must be within +-48")
    src = str(data.get("source") or "mix")
    if src != "mix" and src not in (track.get("stems") or {}).get("names", []):
        raise ApiError(404, "not_found", f"No stem '{src}'")
    tmp = Path(current_app.config["RIPPER_STORAGE"]) / ".exports" / f"{uuid.uuid4().hex}.f32"
    try:
        res = run_quick("engine.services.pipeline:pitch_slice",
                        (str(state().library.track_dir(track_id)), src, start, end, st, str(tmp)), "Pitch shift")
        raw = tmp.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)
    resp = Response(raw, mimetype="application/octet-stream")
    resp.headers["X-Ripper-SR"] = str(res["sr"])
    resp.headers["X-Ripper-Channels"] = str(res["channels"])
    return resp
