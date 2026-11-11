"""HQ (AI) stem separation with Demucs 4.1.0. Optional: requires requirements-ai.txt.

Never imported at module import time — `available()` probes lazily so the engine runs fine
without torch.
"""
from __future__ import annotations

import os
import threading
from typing import Callable

import numpy as np

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

_models: dict[str, object] = {}
_model_lock = threading.Lock()
_run_lock = threading.Lock()   # one separation at a time; Demucs saturates the device
_probe: dict | None = None

MODEL_FOR = {  # UI model id -> demucs checkpoint
    "htdemucs": "htdemucs",
    "htdemucs_6s": "htdemucs_6s",
    "htdemucs_ft": "htdemucs_ft",
    "two_stem": "htdemucs",
}


def probe() -> dict:
    """{available, device, reason}. Cached after the first call."""
    global _probe
    if _probe is not None:
        return _probe
    try:
        import torch  # noqa: F401
        import demucs.apply  # noqa: F401
        import demucs.pretrained  # noqa: F401
    except Exception as exc:  # ImportError, or a broken torch install
        _probe = {"available": False, "device": None,
                  "reason": f"torch/demucs not installed ({type(exc).__name__}). "
                            "Run: pip install -r engine/requirements-ai.txt"}
        return _probe
    _probe = {"available": True, "device": pick_device(), "reason": None}
    return _probe


_probe_thread: threading.Thread | None = None


def probe_nowait() -> dict | None:
    """Like probe(), but never blocks: importing torch takes seconds, so the first call
    starts the probe in the background and returns None ("checking")."""
    global _probe_thread
    if _probe is not None:
        return _probe
    with _model_lock:
        if _probe_thread is None:
            _probe_thread = threading.Thread(target=probe, daemon=True, name="ripper-ai-probe")
            _probe_thread.start()
    return None


def pick_device() -> str:
    import torch
    forced = os.environ.get("RIPPER_TORCH_DEVICE")
    if forced:
        return forced
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def get_model(name: str):
    from demucs.pretrained import get_model as _get
    with _model_lock:
        if name not in _models:
            model = _get(name)
            model.eval()
            _models[name] = model
        return _models[name]


def separate(audio: np.ndarray, sr: int, model_id: str,
             progress: Callable[[float, str], None] | None = None) -> tuple[dict[str, np.ndarray], str]:
    """audio: float32 (2, samples) at the model rate (44.1 kHz). Returns (stems, device)."""
    import torch
    from demucs.apply import apply_model

    def step(p: float, msg: str) -> None:
        if progress:
            progress(p, msg)

    ckpt = MODEL_FOR.get(model_id)
    if not ckpt:
        raise ValueError(f"unknown model {model_id}")
    device = probe()["device"] or "cpu"
    step(0.02, f"Loading {ckpt} on {device}")
    model = get_model(ckpt)
    if sr != model.samplerate:
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=model.samplerate)
    wav = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    total = {"n": 0}

    def cb(info: dict) -> None:
        # Called once per chunk per sub-model; approximate overall progress.
        total["n"] += 1
        models = int(info.get("models", 1)) or 1
        length = audio.shape[1]
        seg = getattr(model, "segment", 7.8) or 7.8
        chunks = max(1, int(np.ceil(length / (float(seg) * model.samplerate * 0.75))))
        step(0.05 + 0.9 * min(1.0, total["n"] / (chunks * models)), f"Separating on {device}")

    with _run_lock, torch.no_grad():
        try:
            out = apply_model(model, wav[None], device=device, split=True, overlap=0.25,
                              progress=False, callback=cb)[0]
        except RuntimeError:
            if device == "cpu":
                raise
            device = "cpu"  # e.g. MPS op unsupported / CUDA OOM -> retry on CPU
            out = apply_model(model, wav[None], device="cpu", split=True, overlap=0.25,
                              progress=False, callback=cb)[0]
    out = (out * std + mean).cpu().numpy().astype(np.float32)
    stems = {name: out[i] for i, name in enumerate(model.sources)}
    if sr != model.samplerate:
        import librosa
        stems = {k: librosa.resample(v, orig_sr=model.samplerate, target_sr=sr) for k, v in stems.items()}
    if model_id == "two_stem":
        vocals = stems.pop("vocals")
        stems = {"vocals": vocals, "instrumental": sum(stems.values())}
    n = audio.shape[1]
    stems = {k: _fit(v, n) for k, v in stems.items()}
    step(1.0, "Done")
    return stems, device


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    if x.shape[1] >= n:
        return x[:, :n]
    return np.pad(x, ((0, 0), (0, n - x.shape[1])))
