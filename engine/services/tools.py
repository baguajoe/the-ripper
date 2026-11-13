"""Find the external programs the engine runs: ffmpeg, ffprobe and a JavaScript runtime.

Resolution order for every tool:

1. An explicit override: RIPPER_FFMPEG / RIPPER_FFPROBE / RIPPER_DENO (full path).
2. The copy bundled with the app. The installers ship ffmpeg, ffprobe and deno next to
   the frozen engine (<resources>/engine/). RIPPER_BIN_DIR adds another bundled folder,
   and a source checkout also looks in desktop/vendor/{ffmpeg,deno}/<os>/.
3. PATH.

The JS runtime (only needed by yt-dlp for some sites, e.g. YouTube) falls back from
Deno to Node when no Deno is found. If nothing is found, link import still works for
sites that don't need one; the UI explains what's missing.
"""
from __future__ import annotations

import dataclasses
import functools
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

IS_WIN = sys.platform.startswith("win")
EXE_SUFFIX = ".exe" if IS_WIN else ""
_NO_WINDOW = 0x08000000 if IS_WIN else 0  # CREATE_NO_WINDOW

# yt-dlp refuses older runtimes (see yt_dlp.utils._jsruntime).
MIN_NODE = (22, 0, 0)
MIN_DENO = (2, 3, 0)

ENV_OVERRIDE = {"ffmpeg": "RIPPER_FFMPEG", "ffprobe": "RIPPER_FFPROBE", "deno": "RIPPER_DENO"}
_VENDOR = {"ffmpeg": "ffmpeg", "ffprobe": "ffmpeg", "deno": "deno"}  # desktop/vendor/<dir>
_REPO = Path(__file__).resolve().parents[2]


class ToolMissing(RuntimeError):
    """Raised by require() when a tool is in neither the bundle nor PATH."""


@dataclasses.dataclass(frozen=True)
class Tool:
    name: str
    path: str
    source: str  # "env" | "bundled" | "path"

    def as_dict(self) -> dict:
        return dataclasses.asdict(self)


def _os_key() -> str:
    return "win" if IS_WIN else "mac" if sys.platform == "darwin" else "linux"


def bundled_dirs() -> list[Path]:
    """Folders that hold the app's own copies of the tools, most specific first."""
    dirs: list[Path] = []
    extra = os.environ.get("RIPPER_BIN_DIR")
    if extra:
        dirs.append(Path(extra))
    if getattr(sys, "frozen", False):  # PyInstaller: <resources>/engine/ripper-engine[.exe]
        dirs.append(Path(sys.executable).resolve().parent)
    return dirs


def _vendor_dir(name: str) -> Path:
    return _REPO / "desktop" / "vendor" / _VENDOR[name] / _os_key()


def _usable(p: Path) -> bool:
    return p.is_file() and (IS_WIN or os.access(p, os.X_OK))


def find(name: str, *, bundled: list[Path] | None = None, use_path: bool = True) -> Tool | None:
    """Resolve one tool: env override → bundled copy → PATH. None when missing."""
    override = os.environ.get(ENV_OVERRIDE.get(name, ""), "")
    if override:
        p = Path(override)
        if _usable(p):
            return Tool(name, str(p), "env")
    candidates = bundled_dirs() if bundled is None else list(bundled)
    if bundled is None and not getattr(sys, "frozen", False):
        candidates.append(_vendor_dir(name))
    for d in candidates:
        p = Path(d) / (name + EXE_SUFFIX)
        if _usable(p):
            return Tool(name, str(p), "bundled")
    if use_path:
        found = shutil.which(name)
        if found:
            return Tool(name, found, "path")
    return None


def require(name: str, **kw) -> Tool:
    tool = find(name, **kw)
    if tool is None:
        raise ToolMissing(f"{name} was not found (looked in the app bundle and on PATH)")
    return tool


def _version(path: str, pattern: str) -> tuple[int, ...] | None:
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=20,
                             creationflags=_NO_WINDOW).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(pattern, out or "", re.M)
    if not m:
        return None
    return tuple(int(x) for x in re.findall(r"\d+", m.group(1))[:3])


@dataclasses.dataclass(frozen=True)
class JsRuntime:
    name: str      # "deno" | "node"
    path: str
    source: str    # "env" | "bundled" | "path"
    version: str

    def ytdlp_option(self) -> dict:
        """Value for yt-dlp's js_runtimes option."""
        return {self.name: {"path": self.path}}


def find_js_runtime(*, bundled: list[Path] | None = None, use_path: bool = True,
                    check_version=_version) -> JsRuntime | None:
    """Bundled Deno → Deno on PATH → Node (>= 22) on PATH. Each candidate must run."""
    candidates: list[tuple[str, Tool | None]] = [("deno", find("deno", bundled=bundled, use_path=use_path))]
    if use_path:
        node = shutil.which("node")
        candidates.append(("node", Tool("node", node, "path") if node else None))
    for kind, tool in candidates:
        if tool is None:
            continue
        pattern, minimum = (r"^deno (\S+)", MIN_DENO) if kind == "deno" else (r"^v(\S+)", MIN_NODE)
        v = check_version(tool.path, pattern)
        if v and v >= minimum:
            return JsRuntime(kind, tool.path, tool.source, ".".join(map(str, v)))
    return None


@functools.lru_cache(maxsize=1)
def js_runtime() -> JsRuntime | None:
    """Cached for the engine's lifetime (runs `deno --version` once)."""
    return find_js_runtime()


def summary() -> dict:
    """{tool: {path, source} | None} for logs and diagnostics."""
    out: dict = {n: (t.as_dict() if (t := find(n)) else None) for n in ("ffmpeg", "ffprobe")}
    js = js_runtime()
    out["js_runtime"] = dataclasses.asdict(js) if js else None
    return out
