"""Job bodies. Everything here runs in a crash-isolated WORKER process (engine/workers.py),
never in the HTTP process: each function is called as fn(ctx, *args) with plain arguments
(paths as str, dicts) and returns plain data. The engine process stores the results in the
library (routes/*.py), so a native crash in here can only fail the one job.

    ctx.progress(p, message)   0..1 progress for the UI
    ctx.update(**fields)       store fields on the job's track right away (e.g. a title)
"""
from __future__ import annotations

import shutil
from pathlib import Path

from .. import config
from ..jobs import JobError

# Files a track folder may hold before conversion, newest import first.
UPLOAD_GLOB = "upload.*"


def _analyze(ctx, d: Path, src: Path | None, base: float, video: bool = False) -> dict:
    """[src ->] source.wav -> analysis. Returns the track fields to store."""
    import soundfile as sf

    from . import analyzer, media

    wav = d / "source.wav"
    if src is not None and src != wav:
        if video:
            ctx.progress(base, "Extracting audio from video")
            media.extract_audio(src, wav, config.TARGET_SR)
        else:
            ctx.progress(base, "Converting to 44.1 kHz WAV")
            media.convert_to_wav(src, wav, config.TARGET_SR)
        src.unlink(missing_ok=True)  # never keep the original (videos especially)
    if not wav.exists():
        raise JobError("The imported audio is missing - import the file again")
    info = sf.info(str(wav))
    duration = info.frames / info.samplerate
    if duration < 0.5:
        raise JobError("Audio is too short (min 0.5 s)")

    def sub(p, msg):
        ctx.progress(base + (1 - base) * 0.1 + (1 - base) * 0.9 * p, msg)

    analysis = analyzer.analyze(wav, sub)
    analysis["duration"] = round(duration, 4)
    return {"duration": round(duration, 4), "sr": info.samplerate, "analysis": analysis}


def pending_source(track_dir: str) -> Path | None:
    """The not-yet-converted upload in a track folder, if any."""
    found = sorted(Path(track_dir).glob(UPLOAD_GLOB))
    return found[0] if found else None


def import_file(ctx, track_dir: str) -> dict:
    """Upload / retry: convert (or extract from video) whatever is in the folder, analyze."""
    d = Path(track_dir)
    src = pending_source(track_dir)
    video = bool(src and src.suffix.lower() in config.VIDEO_EXTENSIONS)
    return _analyze(ctx, d, src, 0.05, video=video)


def import_link(ctx, track_dir: str, url: str) -> dict:
    from . import downloader, media

    d = Path(track_dir)
    dl = d / "dl"
    f, title = downloader.download(url, dl, lambda p, m: ctx.progress(p * 0.6, m))
    ctx.update(title=title, status="analyzing")
    if not media.probe(f):
        raise JobError("Downloaded file contains no audio")
    out = _analyze(ctx, d, f, 0.6)
    shutil.rmtree(dl, ignore_errors=True)
    out["title"] = title
    return out


def run_stems(ctx, track_dir: str, engine: str, model: str) -> dict:
    import numpy as np
    import soundfile as sf

    from . import media, separator_ai, separator_dsp

    d = Path(track_dir)
    ctx.progress(0.02, "Loading audio")
    audio, sr = media.read_stereo(d / "source.wav")
    if engine == "ai":
        stems, device = separator_ai.separate(audio, sr, model, ctx.progress)
        label = config.DEMUCS_MODELS[model]["label"]
    else:
        stems = separator_dsp.separate(audio, sr, ctx.progress)
        device, label = "cpu", "Fast mode — expect bleed"
    out = d / "stems"
    tmp = d / "stems.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    for name, data in stems.items():
        sf.write(str(tmp / f"{name}.wav"), np.asarray(data, dtype=np.float32).T, sr,
                 subtype="FLOAT")
    shutil.rmtree(out, ignore_errors=True)
    tmp.replace(out)
    return {"engine": engine, "model": model if engine == "ai" else "dsp", "device": device,
            "label": label, "names": list(stems.keys())}


def probe_ai(ctx) -> dict:
    """torch/demucs availability, probed in a worker so torch never loads in the HTTP process."""
    from . import separator_ai
    return separator_ai.probe()


# --- interactive tasks (the 'quick' pool) ----------------------------------------------------
def onsets(ctx, wav: str, sensitivity: float) -> list[float]:
    from . import analyzer
    return analyzer.detect_onsets(analyzer.load_mono(Path(wav)), sensitivity)


def build_files(ctx, track_dir: str, spec: dict) -> dict:
    """Render an export. spec (validated by routes/export.py):
        title, bpm, key, downbeat, options{mode,sr,normalize,trim_silence}, slices[dict],
        stems[names], make_dsp_stems, include_midi, folders, midi_only,
        out: {"kind": "dir", "dir": str} | {"kind": "zip", "path": str} | {"kind": "single", "dir": str}
    Returns {"files": [paths], "stems": stems-meta-if-made}."""
    from . import exporter, media
    from .exporter import ExportOptions, Slice

    d = Path(track_dir)
    made_stems = None
    stem_names = list(spec.get("stems") or [])
    if spec.get("make_dsp_stems"):  # "all stems" requested before any were made: fast DSP split
        made_stems = run_stems(ctx, track_dir, "dsp", "dsp")
        ctx.update(stems=made_stems)
        stem_names = list(made_stems["names"])
    opts = ExportOptions(**spec["options"])
    slices = [Slice(**s) for s in spec.get("slices") or []]
    title, bpm, key = spec["title"], spec["bpm"], spec.get("key")
    if spec.get("midi_only"):
        files = [exporter.KitFile(exporter.build_filename(title, bpm, key, "slices", "mid"),
                                  exporter.build_midi(slices, bpm, title, spec.get("downbeat")))]
    else:
        sources = {}
        for src in {s.source for s in slices}:
            p = d / "source.wav" if src == "mix" else d / "stems" / f"{src}.wav"
            if not p.exists():
                raise JobError(f"No stem '{src}'")
            sources[src] = media.read_stereo(p)
        stems = {n: media.read_stereo(d / "stems" / f"{n}.wav") for n in stem_names}
        files = exporter.build_kit(title=title, bpm=bpm, key=key, sources=sources, slices=slices,
                                   opts=opts, stems=stems, include_midi=bool(spec.get("include_midi")),
                                   folders=bool(spec.get("folders", True)),
                                   downbeat=spec.get("downbeat"))
    out = spec["out"]
    if out["kind"] == "zip":
        p = Path(out["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(exporter.zip_bytes(files))
        paths = [str(p)]
    else:
        paths = exporter.write_files(files, Path(out["dir"]))
    return {"files": paths, "stems": made_stems}


def analyze_path(ctx, path: str) -> dict:
    """Diagnostics (python -m engine --analyze FILE): decode + analyze one file, keep nothing."""
    import tempfile

    from . import analyzer, media
    with tempfile.TemporaryDirectory(prefix="ripper-analyze-") as tmp:
        wav = Path(tmp) / "source.wav"
        media.convert_to_wav(Path(path), wav, config.TARGET_SR)
        a = analyzer.analyze(wav, ctx.progress)
    return {"bpm": a["bpm"], "key": a["key"], "duration": a["duration"]}
