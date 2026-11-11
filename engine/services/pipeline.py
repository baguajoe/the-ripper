"""Job bodies: import (upload / link) -> convert -> analyze, and stem separation."""
from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import soundfile as sf

from .. import config
from ..jobs import JobError
from . import analyzer, downloader, media, separator_ai, separator_dsp
from .library import Library


def _analyze_into(lib: Library, track_id: str, src: Path, progress, base: float) -> dict:
    d = lib.track_dir(track_id)
    wav = d / "source.wav"
    lib.update(track_id, status="analyzing")
    progress(base, "Converting to 44.1 kHz WAV")
    media.convert_to_wav(src, wav, config.TARGET_SR)
    if src != wav:
        src.unlink(missing_ok=True)
    info = sf.info(str(wav))
    duration = info.frames / info.samplerate
    if duration < 0.5:
        raise JobError("Audio is too short (min 0.5 s)")

    def sub(p, msg):
        progress(base + (1 - base) * 0.1 + (1 - base) * 0.9 * p, msg)

    analysis = analyzer.analyze(wav, sub)
    analysis["duration"] = round(duration, 4)
    lib.update(track_id, status="ready", duration=round(duration, 4), sr=info.samplerate,
               analysis=analysis, error=None)
    return {"track_id": track_id}


def process_upload(progress, lib: Library, track_id: str, src: Path) -> dict:
    try:
        return _analyze_into(lib, track_id, src, progress, 0.05)
    except Exception as exc:
        lib.update(track_id, status="error",
                   error=str(exc) if isinstance(exc, JobError) else "Analysis failed")
        raise


def process_link(progress, lib: Library, track_id: str, url: str) -> dict:
    try:
        lib.update(track_id, status="downloading")
        d = lib.track_dir(track_id) / "dl"
        f, title = downloader.download(url, d, lambda p, m: progress(p * 0.6, m))
        lib.update(track_id, title=title)
        if not media.probe(f):
            raise JobError("Downloaded file contains no audio")
        out = _analyze_into(lib, track_id, f, progress, 0.6)
        shutil.rmtree(d, ignore_errors=True)
        return out
    except Exception as exc:
        lib.update(track_id, status="error",
                   error=str(exc) if isinstance(exc, JobError) else "Import failed")
        raise


def run_stems(progress, lib: Library, track_id: str, engine: str, model: str) -> dict:
    track = lib.get(track_id)
    if not track:
        raise JobError("Track was deleted")
    d = lib.track_dir(track_id)
    progress(0.02, "Loading audio")
    audio, sr = media.read_stereo(d / "source.wav")
    if engine == "ai":
        stems, device = separator_ai.separate(audio, sr, model, progress)
        label = config.DEMUCS_MODELS[model]["label"]
    else:
        stems = separator_dsp.separate(audio, sr, progress)
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
    meta = {"engine": engine, "model": model if engine == "ai" else "dsp", "device": device,
            "label": label, "names": list(stems.keys())}
    lib.update(track_id, stems=meta)
    return meta
