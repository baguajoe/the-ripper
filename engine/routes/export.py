from __future__ import annotations

import os
from pathlib import Path

from flask import Blueprint, Response, current_app, jsonify

from .. import config
from ..app import ApiError
from ..services import exporter, media, pipeline, separator_ai
from ..services.exporter import ExportOptions, Slice
from .common import body, require_feature, require_track, state

bp = Blueprint("export", __name__)


@bp.get("/health")
def health():
    st = state()
    ai = separator_ai.probe_nowait() or {"available": None, "device": None,
                                         "reason": "Checking for torch/demucs…"}
    return jsonify(
        ok=True,
        version=config.ENGINE_VERSION,
        api=config.API_VERSION,
        ffmpeg=media.check_ffmpeg(),
        demucs_available=ai["available"],
        demucs_reason=ai["reason"],
        device=ai["device"],
        pro=st.pro_enabled,
        features={k: config.is_allowed(k, st.pro_enabled) for k in config.FEATURES},
        models={k: v["label"] for k, v in config.DEMUCS_MODELS.items()},
        max_upload_mb=config.MAX_UPLOAD_BYTES // (1024 * 1024),
    )


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
        sl.end = min(sl.end, duration)
        out.append(sl)
    return out


def _stem_names(track: dict, data: dict) -> list[str]:
    want = data.get("stems")
    if want is None and data.get("include_stems"):
        want = "all"
    if not want:
        return []
    if want == "all":
        if not track.get("stems"):  # no stems yet: run the fast DSP split inline
            pipeline.run_stems(lambda *_: None, state().library, track["id"], "dsp", "dsp")
            track.update(require_track(track["id"]))
        return list(track["stems"]["names"])
    if not isinstance(want, list):
        raise ApiError(400, "invalid_stems", "stems must be a list of names or 'all'")
    have = (track.get("stems") or {}).get("names", [])
    missing = [n for n in want if n not in have]
    if missing:
        raise ApiError(404, "not_found", f"No stem(s) {missing} — run stem separation first")
    return want


def _gate(n_slices: int, n_stems: int, midi: bool) -> None:
    if n_slices > 1:
        require_feature("batch_export")
    if midi or (n_stems and n_slices) or n_stems > 1:
        require_feature("export_kit")
    if n_slices + n_stems == 1 and not midi:
        require_feature("single_export")


def _build(track: dict, data: dict, kind: str | None = None, folders: bool = True):
    opts = _options(data)
    slices = _slices(data, track["duration"])
    midi = bool(data.get("include_midi", False))
    if kind == "midi":
        midi = True
    stem_names = _stem_names(track, data)
    if kind == "midi":
        _gate(0, 0, True)
    else:
        _gate(len(slices), len(stem_names), midi)
    if not slices and not stem_names:
        raise ApiError(400, "nothing_to_export", "Add at least one slice or stem")

    lib = state().library
    d = lib.track_dir(track["id"])
    sources: dict = {}
    needed = {s.source for s in slices} if kind != "midi" else set()
    for src in needed:
        if src == "mix":
            sources[src] = media.read_stereo(d / "source.wav")
        else:
            p = d / "stems" / f"{src}.wav"
            if not p.exists():
                raise ApiError(404, "not_found", f"No stem '{src}'")
            sources[src] = media.read_stereo(p)
    stems = {n: media.read_stereo(d / "stems" / f"{n}.wav") for n in stem_names}
    a = track["analysis"]
    if kind == "midi":
        return [exporter.KitFile(
            exporter.build_filename(track["title"], a["bpm"], a.get("key"), "slices", "mid"),
            exporter.build_midi(slices, a["bpm"], track["title"], a.get("downbeat")))]
    return exporter.build_kit(title=track["title"], bpm=a["bpm"], key=a.get("key"),
                              sources=sources, slices=slices, opts=opts, stems=stems,
                              include_midi=midi, folders=folders, downbeat=a.get("downbeat"))


@bp.post("/tracks/<track_id>/export")
def export(track_id: str):
    """Returns a zip (or a single WAV when `format: 'wav'` and exactly one file results)."""
    track = require_track(track_id, ready=True)
    data = body()
    files = _build(track, data)
    a = track["analysis"]
    if data.get("format") == "wav" and len(files) == 1:
        f = files[0]
        name = Path(f.arcname).name
        mime = "audio/midi" if name.endswith(".mid") else "audio/wav"
        return _attachment(f.data, name, mime)
    name = f"{exporter.base_name(track['title'], a['bpm'], a.get('key'))}_Kit.zip"
    return _attachment(exporter.zip_bytes(files), name, "application/zip")


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
    if kind not in ("slice", "slices", "stem", "kit", "midi"):
        raise ApiError(400, "invalid_kind", "kind must be slice, slices, stem, kit or midi")
    dest = data.get("dest_dir")
    if not isinstance(dest, str) or not os.path.isabs(dest) or not Path(dest).is_dir():
        raise ApiError(400, "invalid_dest", "dest_dir must be an existing absolute folder")
    if kind == "slice" and len(data.get("slices") or []) != 1:
        raise ApiError(400, "invalid_slices", "kind 'slice' needs exactly one slice")
    if kind == "stem":
        if not isinstance(data.get("stems"), list) or len(data["stems"]) != 1:
            raise ApiError(400, "invalid_stems", "kind 'stem' needs exactly one stem name")
        data = {**data, "slices": []}
    if kind == "kit":
        data = {**data, "include_midi": data.get("include_midi", True),
                "stems": data.get("stems", "all") if data.get("stems") is not None else "all"}
    files = _build(track, data, kind=kind, folders=bool(data.get("folders", False)))
    target = Path(dest)
    sub = data.get("subfolder")
    if isinstance(sub, str) and sub.strip():
        target = target / exporter.sanitize(sub, "Export", 80)
    return jsonify(files=exporter.write_files(files, target))
