"""The HQ (AI) add-on: a one-click download that adds Demucs stem separation.

What gets installed, under <app-data>/TheRipper/addons/ai/:

    runtime/        Python + torch + Demucs 4.1 + ripper_ai.py (built per platform in CI and
                    attached to the GitHub release; see scripts/build_ai_pack.py)
    models/         Demucs weights, fetched from the author's Hugging Face repos at pinned
                    commits (config.DEMUCS_WEIGHTS). We never redistribute them.
    download/       partial downloads (resumed on the next attempt), removed once installed
    installed.json  variant, version, sizes and the self-test result
    timings.json    measured separation speed, for the time estimate

The release carries a manifest (config.AI_MANIFEST_NAME) listing, per variant, the files of
the runtime zip (split into parts below GitHub's 2 GiB asset limit) with sizes and SHA-256.

Variants: win-cuda (Windows + NVIDIA GPU), win-cpu, mac-arm64 (Apple Silicon, uses Metal).
"""
from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

from .. import config
from ..jobs import JobError

IS_WIN = sys.platform.startswith("win")
_NO_WINDOW = 0x08000000 if IS_WIN else 0
CHUNK = 1 << 20
RETRIES = 5
USER_AGENT = f"TheRipper/{config.ENGINE_VERSION}"

MAC_MIN_MAJOR = 14  # torch's Apple Silicon wheels need macOS 14+

VARIANT_LABELS = {
    "win-cuda": "NVIDIA GPU (CUDA)",
    "win-cpu": "CPU",
    "mac-arm64": "Apple Silicon (Metal)",
    "linux-cpu": "CPU",
}


# --- locations --------------------------------------------------------------------------------
def addon_dir() -> Path:
    return config.app_data_dir() / "addons" / "ai"


def runtime_dir() -> Path:
    return addon_dir() / "runtime"


def models_dir() -> Path:
    override = os.environ.get("RIPPER_AI_MODELS_DIR")
    return Path(override) if override else addon_dir() / "models"


def download_dir() -> Path:
    return addon_dir() / "download"


def _read_json(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(p: Path, data: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(p)


def pack_python(root: Path) -> Path:
    info = _read_json(root / "pack.json") or {}
    rel = info.get("python") or ("python/python.exe" if IS_WIN else "python/bin/python3")
    return root / rel


def installed() -> dict | None:
    """installed.json, if the runtime it describes is really there."""
    info = _read_json(addon_dir() / "installed.json")
    if not info or not pack_python(runtime_dir()).exists() or not (runtime_dir() / "ripper_ai.py").exists():
        return None
    return info


# --- platform ---------------------------------------------------------------------------------
def has_nvidia_gpu() -> bool:
    """Windows: the NVIDIA driver is installed (nvcuda.dll) and nvidia-smi lists a GPU."""
    if not IS_WIN:
        return False
    sysroot = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    smi = shutil.which("nvidia-smi") or str(sysroot / "System32" / "nvidia-smi.exe")
    try:
        r = subprocess.run([smi, "-L"], capture_output=True, text=True, timeout=10, creationflags=_NO_WINDOW)
        if r.returncode == 0 and "GPU" in (r.stdout or ""):
            return True
    except (OSError, subprocess.SubprocessError):
        pass
    return False


def detect_variant() -> tuple[str | None, str | None]:
    """(variant, reason-if-unsupported). RIPPER_AI_VARIANT overrides (tests, support)."""
    forced = os.environ.get("RIPPER_AI_VARIANT")
    if forced:
        return forced, None
    if IS_WIN:
        if platform.machine().lower() not in ("amd64", "x86_64"):
            return None, "HQ (AI) stems need 64-bit Windows on an x64 PC"
        return ("win-cuda" if has_nvidia_gpu() else "win-cpu"), None
    if sys.platform == "darwin":
        if platform.machine() != "arm64":
            return None, "HQ (AI) stems need a Mac with Apple Silicon"
        major = int((platform.mac_ver()[0] or "0").split(".")[0] or 0)
        if 0 < major < MAC_MIN_MAJOR:  # the add-on's torch wheels are built for macOS 14+
            return None, "HQ (AI) stems need macOS 14 (Sonoma) or later"
        return "mac-arm64", None
    return None, "The HQ (AI) add-on is available for Windows and macOS"


# --- manifest ---------------------------------------------------------------------------------
_manifest_cache: dict = {}
_manifest_lock = threading.Lock()


def _open(url: str, headers: dict | None = None, timeout: float = 60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 - http(s)/file URLs we chose


def fetch_manifest(url: str | None = None, timeout: float = 15, max_age: float = 600) -> dict:
    url = url or config.ai_manifest_url()
    with _manifest_lock:
        hit = _manifest_cache.get(url)
        if hit and time.time() - hit[0] < max_age:
            return hit[1]
    try:
        with _open(url, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise JobError("The HQ (AI) add-on isn't published for this version yet") from exc
        raise JobError(f"Could not reach the download server (HTTP {exc.code})") from exc
    except (OSError, ValueError) as exc:
        raise JobError(f"Could not reach the download server ({_why(exc)}). Check your internet connection.") from exc
    if data.get("format") != config.AI_PACK_FORMAT:
        raise JobError("This add-on version doesn't match the app - update The Ripper")
    data["_url"] = url
    with _manifest_lock:
        _manifest_cache[url] = (time.time(), data)
    return data


def _why(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    return str(reason or exc)[:120] or type(exc).__name__


def _resolve(manifest: dict, name: str) -> str:
    return urllib.parse.urljoin(manifest["_url"], urllib.parse.quote(name))


def weights_needed(models: list[str] | None = None) -> list[tuple[str, str, int, str]]:
    """[(url, filename, size, sha256)] of weights files not yet in models_dir()."""
    out = []
    d = models_dir()
    for key in models or list(config.DEMUCS_WEIGHTS):
        w = config.DEMUCS_WEIGHTS[key]
        for fname, (size, sha) in w["files"].items():
            p = d / fname
            if p.exists() and p.stat().st_size == size:
                continue
            url = f"{config.HF_BASE_URL}/{w['repo']}/resolve/{w['revision']}/{fname}"
            out.append((url, fname, size, sha))
    return out


def weights_bytes(models: list[str] | None = None) -> int:
    return sum(size for key in (models or config.DEMUCS_WEIGHTS)
               for size, _ in config.DEMUCS_WEIGHTS[key]["files"].values())


def status(include_manifest: bool = True) -> dict:
    variant, reason = detect_variant()
    info = installed()
    out = {
        "variant": variant,
        "variant_label": VARIANT_LABELS.get(variant or "", variant),
        "supported": variant is not None,
        "reason": reason,
        "installed": info is not None,
        "info": info,
        "download_bytes": None,
        "disk_bytes": None,
        "manifest_error": None,
    }
    if include_manifest and variant and not info:
        try:
            m = fetch_manifest(timeout=8)
            v = m["variants"].get(variant)
            if not v:
                out["manifest_error"] = f"No add-on for {VARIANT_LABELS.get(variant, variant)} in this release"
            else:
                out["download_bytes"] = sum(f["size"] for f in v["files"]) + sum(s for _, _, s, _ in weights_needed())
                out["disk_bytes"] = int(v.get("unpacked_bytes", 0)) + weights_bytes()
        except JobError as exc:
            out["manifest_error"] = str(exc)
    return out


# --- downloading ------------------------------------------------------------------------------
def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, size: int, sha256: str, on_bytes: Callable[[int], None]) -> Path:
    """Download url -> dest, resuming a previous partial download (HTTP Range), verifying the
    size and SHA-256. Network errors are retried (resuming) a few times; a checksum mismatch
    deletes the file so the next attempt starts clean."""
    if dest.exists() and dest.stat().st_size == size and sha256_file(dest) == sha256:
        on_bytes(size)
        return dest
    part = dest.with_name(dest.name + ".partial")
    dest.parent.mkdir(parents=True, exist_ok=True)
    last: BaseException | None = None
    for attempt in range(RETRIES):
        have = part.stat().st_size if part.exists() else 0
        if have > size:
            part.unlink()
            have = 0
        on_bytes(have)
        if have < size:
            try:
                headers = {"Range": f"bytes={have}-"} if have else {}
                with _open(url, headers, timeout=60) as r:
                    if have and getattr(r, "status", 200) != 206:
                        have = 0  # server ignored the range: start over
                    with open(part, "ab" if have else "wb") as f:
                        while True:
                            chunk = r.read(CHUNK)
                            if not chunk:
                                break
                            f.write(chunk)
                            have += len(chunk)
                            on_bytes(have)
            except (OSError, http.client.HTTPException) as exc:  # timeouts, resets, short reads
                last = exc
                time.sleep(min(30, 2 ** attempt))
                continue
        if have != size:
            last = OSError(f"got {have} of {size} bytes")
            if have > size:
                part.unlink(missing_ok=True)
            time.sleep(min(30, 2 ** attempt))
            continue
        if sha256_file(part) != sha256:
            part.unlink(missing_ok=True)
            raise JobError(f"The download of {dest.name} was damaged (checksum mismatch). "
                           "Click Get HQ (AI) stems to download it again.")
        part.replace(dest)
        return dest
    raise JobError(f"The download was interrupted ({_why(last) if last else 'network error'}). "
                   "Click Get HQ (AI) stems again to resume where it stopped.")


def ensure_weights(models: list[str] | None, progress: Callable[[float, str], None] | None = None) -> None:
    """Fetch any missing Demucs weights from the author's Hugging Face repos (pinned + checked)."""
    need = weights_needed(models)
    if not need:
        return
    total = sum(s for _, _, s, _ in need)
    done = 0
    d = models_dir()
    d.mkdir(parents=True, exist_ok=True)
    for url, fname, size, sha in need:
        def on_bytes(n: int, base=done) -> None:
            if progress:
                progress((base + n) / total, f"Downloading model weights ({_mb(base + n)} of {_mb(total)})")
        download(url, d / fname, size, sha, on_bytes)
        done += size


def _mb(n: int) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


class _Concat(io.RawIOBase):
    """Read-only, seekable view of several files as one (the parts of a split zip)."""

    def __init__(self, paths: list[Path]):
        super().__init__()
        self.files = [open(p, "rb") for p in paths]  # noqa: SIM115 - closed in close()
        self.sizes = [p.stat().st_size for p in paths]
        self.starts = [sum(self.sizes[:i]) for i in range(len(paths))]
        self.total = sum(self.sizes)
        self.pos = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        self.pos = {0: offset, 1: self.pos + offset, 2: self.total + offset}[whence]
        return self.pos

    def readinto(self, b) -> int:
        if self.pos >= self.total:
            return 0
        i = max(k for k, s in enumerate(self.starts) if s <= self.pos)
        f = self.files[i]
        f.seek(self.pos - self.starts[i])
        n = f.readinto(memoryview(b)[: min(len(b), self.sizes[i] - (self.pos - self.starts[i]))])
        self.pos += n
        return n

    def close(self) -> None:
        for f in self.files:
            f.close()
        super().close()


def long_path(p: Path | str) -> str:
    r"""Windows: an extended-length path (\\?\C:\...), so files deeper than 260 characters
    (torch's licence tree, under a long user name) can be written and deleted."""
    s = os.path.abspath(str(p))
    if IS_WIN and not s.startswith("\\\\?\\"):
        s = "\\\\?\\" + s
    return s


def rmtree(p: Path) -> None:
    shutil.rmtree(long_path(p))


def _rm_quiet(p: Path) -> None:
    try:
        rmtree(p)
    except OSError:
        pass


def extract(zip_parts: list[Path], dest: Path, progress: Callable[[float], None]) -> int:
    """Unzip (keeping executable bits), refusing paths outside dest. Returns bytes written."""
    if dest.exists():
        rmtree(dest)
    dest.mkdir(parents=True)
    root = os.path.normpath(os.path.abspath(dest))
    written = 0
    src = io.BufferedReader(_Concat(zip_parts), buffer_size=CHUNK)
    try:
        with zipfile.ZipFile(src) as z:
            infos = z.infolist()
            total = sum(i.file_size for i in infos) or 1
            for info in infos:
                target = os.path.normpath(os.path.join(root, info.filename))
                if not target.startswith(root + os.sep):
                    raise JobError("The add-on archive is invalid (unsafe path)")
                if info.is_dir():
                    os.makedirs(long_path(target), exist_ok=True)
                    continue
                os.makedirs(long_path(os.path.dirname(target)), exist_ok=True)
                with z.open(info) as fi, open(long_path(target), "wb") as fo:
                    shutil.copyfileobj(fi, fo, CHUNK)
                mode = (info.external_attr >> 16) & 0o777
                if mode and not IS_WIN:
                    os.chmod(target, mode | 0o600)
                written += info.file_size
                progress(written / total)
    finally:
        src.close()
    return written


def run_runner(root: Path, args: list[str], timeout: float | None = None) -> dict:
    """Run ripper_ai.py from an installed runtime and return its last JSON line."""
    cmd = [str(pack_python(root)), "-I", str(root / "ripper_ai.py"), *args]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=runner_env(),
                           creationflags=_NO_WINDOW, cwd=str(root))
    except OSError as exc:  # missing / not executable / wrong architecture
        raise JobError(f"The AI engine did not start ({exc.strerror or exc})") from exc
    lines = [ln for ln in (r.stdout or "").splitlines() if ln.startswith("{")]
    if not lines:
        tail = (r.stderr or "").strip().splitlines()[-3:]
        raise JobError(f"The AI engine did not start (exit {r.returncode}): {' | '.join(tail)[:300]}")
    out = json.loads(lines[-1])
    if "error" in out:
        raise JobError(f"The AI engine failed its self-test: {out['error'][:300]}")
    return out


def runner_env() -> dict:
    """Environment for the add-on's Python: nothing from the engine's own (frozen) Python."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("PYTHON", "_MEI", "_PYI")) and k not in ("TCL_LIBRARY", "TK_LIBRARY")}
    env.update(PYTHONNOUSERSITE="1", PYTHONIOENCODING="utf-8", HF_HUB_OFFLINE="1",
               PYTORCH_ENABLE_MPS_FALLBACK="1")
    return env


# --- install / remove (install runs in a worker process) ---------------------------------------
def install(ctx, manifest_url: str | None = None) -> dict:
    """Worker task: download + verify + unpack the runtime, fetch the weights, self-test."""
    variant, reason = detect_variant()
    if not variant:
        raise JobError(reason or "HQ (AI) stems aren't available on this computer")
    ctx.progress(0.0, "Checking the latest add-on")
    manifest = fetch_manifest(manifest_url, max_age=0)
    v = manifest["variants"].get(variant)
    if not v:
        raise JobError(f"No HQ (AI) add-on for {VARIANT_LABELS.get(variant, variant)} in this release")
    files = v["files"]
    pack_bytes = sum(f["size"] for f in files)
    wneed = weights_needed()
    total_dl = pack_bytes + sum(s for _, _, s, _ in wneed)
    need_disk = total_dl + int(v.get("unpacked_bytes", 0)) + 200_000_000
    base = addon_dir()
    base.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(base).free
    if free < need_disk:
        raise JobError(f"Not enough free disk space: the add-on needs {_mb(need_disk)}, "
                       f"{_mb(free)} is free on that drive")

    dl = download_dir()
    dl.mkdir(parents=True, exist_ok=True)
    t0, done = time.time(), 0
    parts: list[Path] = []
    for f in files:
        def on_bytes(n: int, base_done=done) -> None:
            got = base_done + n
            rate = got / max(0.5, time.time() - t0)
            ctx.progress(0.8 * got / total_dl,
                         f"Downloading {_mb(got)} of {_mb(total_dl)} ({rate / 1e6:.1f} MB/s)")
        parts.append(download(_resolve(manifest, f["name"]), dl / f["name"], f["size"], f["sha256"], on_bytes))
        done += f["size"]
    whole = v.get("zip_sha256")
    if whole and len(parts) > 1:
        ctx.progress(0.8 * done / total_dl, "Checking the download")
        h = hashlib.sha256()
        for p in parts:
            with open(p, "rb") as fh:
                while chunk := fh.read(CHUNK):
                    h.update(chunk)
        if h.hexdigest() != whole:
            for p in parts:
                p.unlink(missing_ok=True)
            raise JobError("The add-on download was damaged (checksum mismatch). Click Get HQ (AI) stems to try again.")

    def on_w(p: float, msg: str) -> None:
        ctx.progress(0.8 * (pack_bytes + p * (total_dl - pack_bytes)) / total_dl, msg)
    ensure_weights(None, on_w)

    new = base / "runtime.new"
    ctx.progress(0.8, "Unpacking")
    written = extract(parts, new, lambda p: ctx.progress(0.8 + 0.15 * p, "Unpacking"))
    pack = _read_json(new / "pack.json")
    if not pack or pack.get("format") != config.AI_PACK_FORMAT:
        _rm_quiet(new)
        raise JobError("The add-on archive is invalid (no pack.json)")
    ctx.progress(0.96, "Testing the AI engine")
    try:
        probe = run_runner(new, ["probe"], timeout=600)
    except subprocess.TimeoutExpired:
        _rm_quiet(new)
        raise JobError("The AI engine did not start within 10 minutes") from None
    except JobError:
        _rm_quiet(new)
        raise
    old = base / "runtime.old"
    _rm_quiet(old)
    if runtime_dir().exists():
        runtime_dir().replace(old)
    new.replace(runtime_dir())
    _rm_quiet(old)
    _rm_quiet(dl)
    info = {"variant": variant, "version": manifest.get("app_version"), "pack": pack,
            "device": probe.get("device"), "gpu": probe.get("gpu"), "torch": probe.get("torch"),
            "disk_bytes": written + weights_bytes(), "installed_at": time.time()}
    _write_json(base / "installed.json", info)
    ctx.progress(1.0, "Installed")
    return info


def remove() -> None:
    """Delete the runtime, the weights and any partial download (keeps nothing behind)."""
    base = addon_dir()
    (base / "installed.json").unlink(missing_ok=True)
    errors = []
    for d in (runtime_dir(), base / "runtime.new", base / "runtime.old", models_dir(), download_dir()):
        try:
            rmtree(d)
        except FileNotFoundError:
            pass
        except OSError as exc:
            errors.append(f"{d.name}: {exc}")
    if errors:
        raise JobError("Some add-on files are in use; close any running separation and try again "
                       f"({'; '.join(errors)[:200]})")
    try:
        if base.exists() and not any(p for p in base.iterdir() if p.name != "timings.json"):
            shutil.rmtree(base)
    except OSError:
        pass


# --- speed estimate ---------------------------------------------------------------------------
STARTUP_S = {"cuda": 12.0, "mps": 8.0, "cpu": 6.0}
DEFAULT_RTF = {"cuda": 0.06, "mps": 0.25}   # seconds of work per second of audio


def _default_rtf(device: str, model: str, cpus: int) -> float:
    if device in DEFAULT_RTF:
        rtf = DEFAULT_RTF[device]
    else:  # measured: ~1.6 s/s on a 2-core CI VM; scales sub-linearly with cores
        rtf = 1.6 * (2.0 / max(2, min(cpus, 16))) ** 0.75
    return rtf * (1.15 if model == "htdemucs_6s" else 1.0)


def estimate_seconds(duration: float, model: str, device: str, cpus: int) -> dict:
    timings = _read_json(addon_dir() / "timings.json") or {}
    learned = timings.get(f"{config.DEMUCS_MODELS.get(model, {}).get('weights', model)}:{model}:{device}")
    rtf = learned["rtf"] if learned else _default_rtf(device, model, cpus)
    start = learned["startup"] if learned else STARTUP_S.get(device, 6.0)
    return {"seconds": round(start + rtf * duration, 1), "device": device, "learned": bool(learned)}


def record_timing(model: str, device: str, audio_seconds: float, seconds: float, load_seconds: float,
                  wall_seconds: float) -> None:
    """Remember how fast this machine separates (moving average), for the next estimate."""
    if audio_seconds <= 1:
        return
    p = addon_dir() / "timings.json"
    t = _read_json(p) or {}
    key = f"{config.DEMUCS_MODELS.get(model, {}).get('weights', model)}:{model}:{device}"
    rtf = max(0.001, (seconds - load_seconds) / audio_seconds)
    startup = max(0.0, wall_seconds - (seconds - load_seconds))
    old = t.get(key)
    if old:
        rtf = 0.5 * old["rtf"] + 0.5 * rtf
        startup = 0.5 * old["startup"] + 0.5 * startup
    t[key] = {"rtf": round(rtf, 4), "startup": round(startup, 2)}
    try:
        _write_json(p, t)
    except OSError:
        pass

