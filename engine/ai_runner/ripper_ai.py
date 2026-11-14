"""HQ (AI) stem separation runner (Demucs 4.1). Runs in the AI add-on's own Python, never in
the engine: the engine starts it as a subprocess and reads JSON lines from stdout.

Standalone on purpose (numpy, soundfile, PyYAML, torch, demucs; nothing from the engine), so
the add-on pack ships this one file next to its Python.

    python ripper_ai.py probe
        -> {"ok": true, "device": "cuda|mps|cpu", "torch": "...", "demucs": "...", "gpu": "..."}
    python ripper_ai.py separate --input in.wav --output DIR --model htdemucs --models-dir DIR
        -> {"progress": 0.4, "message": "..."} ... {"done": true, "device": "cpu", "stems": [...]}
    errors -> {"error": "..."} and exit code 1

Model weights are read from --models-dir only (<model>.yaml + <sig>.safetensors, the layout
of the author's Hugging Face repos); this script never downloads anything.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

RUNNER_VERSION = 1
# UI model id -> (checkpoint, stems the UI gets)
MODELS = {
    "htdemucs": "htdemucs",
    "htdemucs_6s": "htdemucs_6s",
    "two_stem": "htdemucs",
}


def emit(**obj) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def pick_device(torch) -> str:
    forced = os.environ.get("RIPPER_TORCH_DEVICE")
    if forced:
        return forced
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def probe() -> dict:
    import demucs
    import torch
    device = pick_device(torch)
    gpu = None
    if device == "cuda":
        try:
            gpu = torch.cuda.get_device_name(0)
        except Exception:  # pragma: no cover
            gpu = None
    elif device == "mps":
        gpu = "Apple Silicon GPU (Metal)"
    return {"ok": True, "device": device, "torch": torch.__version__,
            "demucs": getattr(demucs, "__version__", "?"), "gpu": gpu,
            "cuda_build": getattr(torch.version, "cuda", None), "runner": RUNNER_VERSION}


def load_model(name: str, models_dir: Path):
    """The author's HF layout, from a local folder: <name>.yaml lists the bag's model
    signatures, each in <sig>.safetensors (see demucs/hf.py)."""
    import yaml
    from demucs.apply import BagOfModels
    from demucs.hf import load_safetensors_model

    spec = models_dir / f"{name}.yaml"
    if not spec.exists():
        raise FileNotFoundError(f"model {name} is not installed ({spec.name} missing)")
    bag = yaml.safe_load(spec.read_text(encoding="utf-8"))
    models = []
    for sig in bag["models"]:
        f = models_dir / f"{sig}.safetensors"
        if not f.exists():
            raise FileNotFoundError(f"model {name} is not installed ({f.name} missing)")
        models.append(load_safetensors_model(f))
    model = BagOfModels(models, bag.get("weights"), bag.get("segment"))
    model.eval()
    return model


def separate(inp: Path, out: Path, model_id: str, models_dir: Path) -> dict:
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model

    t0 = time.time()
    ckpt = MODELS.get(model_id)
    if not ckpt:
        raise ValueError(f"unknown model {model_id}")
    device = pick_device(torch)
    emit(progress=0.01, message=f"Loading {ckpt} on {device}")
    model = load_model(ckpt, models_dir)
    audio, sr = sf.read(str(inp), dtype="float32", always_2d=True)
    audio = audio.T  # (channels, samples)
    if audio.shape[0] == 1:
        audio = np.concatenate([audio, audio])
    audio = audio[:2]
    if sr != model.samplerate:
        raise ValueError(f"expected {model.samplerate} Hz audio, got {sr} Hz")
    n = audio.shape[1]
    wav = torch.from_numpy(np.ascontiguousarray(audio))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std
    load_s = time.time() - t0

    seg = float(getattr(model, "segment", 7.8) or 7.8)
    chunks = max(1, int(np.ceil(n / (seg * model.samplerate * 0.75))))
    done = {"n": 0}

    def cb(info: dict) -> None:
        # once per chunk per sub-model
        done["n"] += 1
        models = int(info.get("models", 1)) or 1
        emit(progress=round(0.05 + 0.9 * min(1.0, done["n"] / (chunks * models)), 4),
             message=f"Separating on {device}")

    def run(dev: str):
        return apply_model(model, wav[None], device=dev, split=True, overlap=0.25,
                           progress=False, callback=cb)[0]

    emit(progress=0.05, message=f"Separating on {device}")
    with torch.no_grad():
        try:
            res = run(device)
        except RuntimeError as exc:
            if device == "cpu":
                raise
            emit(progress=0.05, message=f"{device} failed ({str(exc)[:80]}), using the CPU")
            device = "cpu"  # e.g. MPS op unsupported / CUDA out of memory
            done["n"] = 0
            res = run("cpu")
    res = (res * std + mean).cpu().numpy().astype(np.float32)
    stems = {name: res[i] for i, name in enumerate(model.sources)}
    if model_id == "two_stem":
        vocals = stems.pop("vocals")
        stems = {"vocals": vocals, "instrumental": sum(stems.values())}
    out.mkdir(parents=True, exist_ok=True)
    names = []
    for name, data in stems.items():
        data = data[:, :n] if data.shape[1] >= n else np.pad(data, ((0, 0), (0, n - data.shape[1])))
        sf.write(str(out / f"{name}.wav"), data.T, sr, subtype="FLOAT")
        names.append(name)
    return {"done": True, "device": device, "stems": names, "seconds": round(time.time() - t0, 2),
            "load_seconds": round(load_s, 2), "audio_seconds": round(n / sr, 3)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ripper_ai")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe")
    sp = sub.add_parser("separate")
    sp.add_argument("--input", required=True, type=Path)
    sp.add_argument("--output", required=True, type=Path)
    sp.add_argument("--model", default="htdemucs")
    sp.add_argument("--models-dir", required=True, type=Path)
    args = ap.parse_args(argv)
    try:
        if args.cmd == "probe":
            emit(**probe())
        else:
            emit(**separate(args.input, args.output, args.model, args.models_dir))
        return 0
    except Exception as exc:  # reported to the engine as a user-facing job error
        emit(error=f"{type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
