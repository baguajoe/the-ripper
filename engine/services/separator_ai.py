"""HQ (AI) stem separation with Demucs 4.1, run as a separate program.

torch is never imported by the engine (neither the HTTP process nor its workers): separation
runs engine/ai_runner/ripper_ai.py in a Python that has torch + Demucs:

1. the HQ (AI) add-on, once installed (services/addon.py): <app-data>/TheRipper/addons/ai/runtime
2. from a source checkout only: the engine's own Python, if torch + Demucs are pip-installed

The runner prints JSON lines (progress, then a result) that are relayed to the job.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np

from .. import config
from ..jobs import JobError
from . import addon

DEV_RUNNER = Path(__file__).resolve().parents[1] / "ai_runner" / "ripper_ai.py"
NOT_INSTALLED = "HQ (AI) stems need the free HQ (AI) add-on"

_probe: dict | None = None
_probe_lock = threading.Lock()
_probe_thread: threading.Thread | None = None


def runtime() -> dict | None:
    """{kind, python, runner, cwd} of the Python that can run Demucs, or None."""
    if addon.installed():
        root = addon.runtime_dir()
        return {"kind": "addon", "python": str(addon.pack_python(root)), "runner": str(root / "ripper_ai.py"),
                "cwd": str(root)}
    if os.environ.get("RIPPER_AI_NO_DEV_RUNTIME") == "1":  # tests: only the add-on counts
        return None
    if not getattr(sys, "frozen", False) and DEV_RUNNER.exists() \
            and importlib.util.find_spec("torch") and importlib.util.find_spec("demucs"):
        return {"kind": "dev", "python": sys.executable, "runner": str(DEV_RUNNER), "cwd": str(DEV_RUNNER.parent)}
    return None


def _cmd(rt: dict, *args: str) -> list[str]:
    return [rt["python"], "-I", rt["runner"], *args]


def probe() -> dict:
    """{available, device, reason, gpu, kind}. Blocking (starts the runner once)."""
    rt = runtime()
    if rt is None:
        return {"available": False, "device": None, "gpu": None, "kind": None, "reason": NOT_INSTALLED}
    try:
        r = subprocess.run(_cmd(rt, "probe"), capture_output=True, text=True, timeout=600,
                           env=addon.runner_env(), creationflags=addon._NO_WINDOW, cwd=rt["cwd"])
        line = next((ln for ln in reversed((r.stdout or "").splitlines()) if ln.startswith("{")), None)
        out = json.loads(line) if line else {"error": (r.stderr or "no output").strip()[-300:]}
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        out = {"error": f"{type(exc).__name__}: {exc}"}
    if out.get("error"):
        return {"available": False, "device": None, "gpu": None, "kind": rt["kind"],
                "reason": f"The HQ (AI) engine could not start ({out['error'][:200]}). Remove the add-on and get it again."}
    return {"available": True, "device": out.get("device"), "gpu": out.get("gpu"), "kind": rt["kind"],
            "reason": None, "torch": out.get("torch")}


def _probe_bg() -> None:
    global _probe, _probe_thread
    result = probe()
    with _probe_lock:
        _probe = result
        _probe_thread = None


def probe_nowait() -> dict | None:
    """Cached probe; the first call starts it in the background and returns None ("checking")."""
    global _probe_thread
    with _probe_lock:
        if _probe is not None:
            return _probe
        if _probe_thread is None:
            _probe_thread = threading.Thread(target=_probe_bg, daemon=True, name="ripper-ai-probe")
            _probe_thread.start()
    return None


def probe_remote(timeout: float = 600) -> dict:
    """Cached probe, waiting for it if it is still running."""
    if probe_nowait() is None:
        t = _probe_thread
        if t is not None:
            t.join(timeout)
    return _probe or {"available": False, "device": None, "gpu": None, "kind": None,
                      "reason": "Still checking for the HQ (AI) engine"}


def reset_probe() -> None:
    """Forget the cached probe (after the add-on was installed or removed)."""
    global _probe
    with _probe_lock:
        _probe = None


def separate_file(source: Path, out_dir: Path, model_id: str,
                  progress: Callable[[float, str], None] | None = None) -> dict:
    """Separate source (44.1 kHz WAV) into out_dir/<stem>.wav. Returns the runner's result."""
    if model_id not in config.DEMUCS_MODELS:
        raise JobError(f"Unknown model {model_id}")
    rt = runtime()
    if rt is None:
        raise JobError(NOT_INSTALLED)

    def step(p: float, msg: str) -> None:
        if progress:
            progress(max(0.0, min(1.0, p)), msg)

    weights = config.DEMUCS_MODELS[model_id]["weights"]
    if addon.weights_needed([weights]):
        addon.ensure_weights([weights], lambda p, m: step(0.02 + 0.08 * p, m))
    step(0.1, "Starting the AI engine")
    t0 = time.time()
    proc = subprocess.Popen(_cmd(rt, "separate", "--input", str(source), "--output", str(out_dir),
                                 "--model", model_id, "--models-dir", str(addon.models_dir())),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            env=addon.runner_env(), creationflags=addon._NO_WINDOW, cwd=rt["cwd"])
    err_tail: list[str] = []

    def drain() -> None:
        for line in proc.stderr:
            err_tail.append(line.rstrip())
            del err_tail[:-20]
    threading.Thread(target=drain, daemon=True).start()
    result = None
    for line in proc.stdout:
        if not line.startswith("{"):
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if "progress" in msg:
            step(0.1 + 0.88 * float(msg["progress"]), msg.get("message") or "Separating")
        elif msg.get("done") or "error" in msg:
            result = msg
    code = proc.wait()
    if result is None or "error" in (result or {}):
        detail = (result or {}).get("error") or " | ".join(err_tail[-3:]) or f"exit code {code}"
        raise JobError(f"HQ (AI) separation failed: {detail[:300]}")
    wall = time.time() - t0
    addon.record_timing(model_id, result.get("device", "cpu"), float(result.get("audio_seconds", 0)),
                        float(result.get("seconds", wall)), float(result.get("load_seconds", 0)), wall)
    step(1.0, "Done")
    return result


def separate(audio: np.ndarray, sr: int, model_id: str,
             progress: Callable[[float, str], None] | None = None) -> tuple[dict[str, np.ndarray], str]:
    """In-memory convenience wrapper (tests): audio (channels, samples) at 44.1 kHz."""
    import soundfile as sf
    with tempfile.TemporaryDirectory(prefix="ripper-ai-") as tmp:
        src = Path(tmp) / "in.wav"
        sf.write(str(src), np.asarray(audio, dtype=np.float32).T, sr, subtype="FLOAT")
        res = separate_file(src, Path(tmp) / "out", model_id, progress)
        stems = {n: sf.read(str(Path(tmp) / "out" / f"{n}.wav"), dtype="float32", always_2d=True)[0].T
                 for n in res["stems"]}
    return stems, res["device"]
