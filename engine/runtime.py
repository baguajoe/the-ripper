"""Process-wide runtime set-up that must happen BEFORE numpy / scipy / numba / librosa load.

Imported (and applied) by engine/__init__.py, so every engine process - the Flask server and
each job worker - gets it, whether started as ``python -m engine`` or as the frozen
PyInstaller executable.

* Thread caps. OpenBLAS, OpenMP, MKL and numba size their thread pools from the CPU count.
  On a 24-core PC that is 24+ threads per library, per process; we cap every pool at
  min(cpu_count, 8). Values already set lower in the environment are kept.
* Numba cache. Numba writes compiled code next to the library sources by default, which
  is read-only (or shared between users) in an installed app. NUMBA_CACHE_DIR points it
  at a per-user, writable folder.
* Crash traces. faulthandler writes a Python stack trace to <log dir>/engine-crash.log on a
  native crash (access violation, segfault, abort), so a crash is never silent again.
"""
from __future__ import annotations

import datetime
import faulthandler
import os
import sys
from pathlib import Path

MAX_THREADS = 8
THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
               "NUMBA_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_MAX_THREADS")
CRASH_LOG_NAME = "engine-crash.log"

_crash_file = None  # kept open for the life of the process (faulthandler needs the fd)


def cpu_count() -> int:
    """Logical CPUs. RIPPER_TEST_CPU_COUNT simulates a bigger machine in tests."""
    fake = os.environ.get("RIPPER_TEST_CPU_COUNT")
    if fake and fake.isdigit() and int(fake) > 0:
        return int(fake)
    return os.cpu_count() or 1


def thread_cap(cpus: int | None = None) -> int:
    return max(1, min(cpu_count() if cpus is None else cpus, MAX_THREADS))


def cap_threads(env: dict | None = None, cpus: int | None = None) -> dict[str, str]:
    """Set every thread-pool variable to min(cpus, 8) (or a lower value already present)."""
    env = os.environ if env is None else env
    cap = thread_cap(cpus)
    out = {}
    for var in THREAD_VARS:
        cur = env.get(var, "")
        value = cap
        if cur.strip().isdigit() and 0 < int(cur) < cap:
            value = int(cur)
        env[var] = str(value)
        out[var] = str(value)
    return out


def default_app_data_dir() -> Path:
    """Same rule as engine.config.app_data_dir(), without importing config (no side effects)."""
    override = os.environ.get("RIPPER_APP_DATA")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "TheRipper"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "TheRipper"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "TheRipper"


def log_dir() -> Path:
    """Where crash traces go: the desktop app passes its log folder in RIPPER_LOG_DIR."""
    d = Path(os.environ.get("RIPPER_LOG_DIR") or default_app_data_dir() / "logs")
    return d


def set_numba_cache_dir() -> str | None:
    if os.environ.get("NUMBA_CACHE_DIR"):
        return os.environ["NUMBA_CACHE_DIR"]
    d = default_app_data_dir() / "numba-cache"
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError:
        return None  # numba falls back to its own locations (or no cache) - still works
    os.environ["NUMBA_CACHE_DIR"] = str(d)
    return str(d)


def enable_crash_log(role: str) -> Path | None:
    """faulthandler -> <log dir>/engine-crash.log (appended; one header per process)."""
    global _crash_file
    if _crash_file is not None:
        return Path(_crash_file.name)
    try:
        d = log_dir()
        d.mkdir(parents=True, exist_ok=True)
        path = d / CRASH_LOG_NAME
        f = open(path, "a", encoding="utf-8")  # noqa: SIM115 - must stay open
        f.write(f"\n=== {role} pid {os.getpid()} started "
                f"{datetime.datetime.now().isoformat(timespec='seconds')} ===\n")
        f.flush()
        faulthandler.enable(file=f, all_threads=True)
        _crash_file = f
        return path
    except OSError:
        faulthandler.enable()  # stderr at least
        return None


def crash_trace_for(pid: int, max_lines: int = 40) -> str:
    """The faulthandler output written by process `pid` (empty if none)."""
    path = log_dir() / CRASH_LOG_NAME
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    marker = f" pid {pid} started "
    start = text.rfind(marker)
    if start < 0:
        return ""
    block = text[start:].split("\n=== ", 1)[0]
    lines = [ln for ln in block.splitlines()[1:] if ln.strip()]
    return "\n".join(lines[-max_lines:])


_applied = False


def configure() -> None:
    """Idempotent; called from engine/__init__.py before anything heavy is imported."""
    global _applied
    if _applied:
        return
    _applied = True
    cap_threads()
    set_numba_cache_dir()
