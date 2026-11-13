"""Link import via yt-dlp. Only import content you own or have rights to."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from ..jobs import JobError
from . import media, tools

NO_JS_RUNTIME_HINT = (
    "This site needs a JavaScript runtime (Deno) to import links, and none was found. "
    "The Ripper normally ships one - reinstalling should fix it. You can still drop "
    "WAV/MP3 files in, or install Deno (deno.com) and restart."
)
# yt-dlp messages that mean "a JS runtime would have helped".
_JS_ERRORS = ("javascript runtime", "js runtime", "jsc", "n challenge", "signature",
              "player response", "deno", "ejs")

URL_RE = re.compile(r"^https?://", re.I)


def validate_url(url: str) -> bool:
    if not isinstance(url, str) or len(url) > 2048 or not URL_RE.match(url):
        return False
    host = urlparse(url).hostname or ""
    # Never let a link import poke at the local machine / LAN.
    if host in ("localhost",) or host.startswith("127.") or host == "0.0.0.0" or host == "::1":
        return False
    return bool(host)


def download(url: str, out_dir: Path, progress: Callable[[float, str], None]) -> tuple[Path, str]:
    """Download best audio for url into out_dir. Returns (file, title). Progress is 0..1."""
    try:
        import yt_dlp
    except ImportError as exc:  # pragma: no cover
        raise JobError("yt-dlp is not installed") from exc

    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total:
                progress(done / total, f"Downloading {done / 1e6:.1f} / {total / 1e6:.1f} MB")
            else:
                progress(0.0, f"Downloading {done / 1e6:.1f} MB")
        elif d.get("status") == "finished":
            progress(1.0, "Download finished")

    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "download.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "max_filesize": 1024 * 1024 * 1024,
        "socket_timeout": 30,
        "retries": 2,
    }
    # YouTube (and a few others) need a JS runtime for signature solving: the bundled Deno,
    # else a system Deno/Node. Without one, sites that don't need JS still work.
    js = tools.js_runtime()
    opts["js_runtimes"] = js.ytdlp_option() if js else {}
    location = media.ffmpeg_location()
    if location:
        opts["ffmpeg_location"] = location
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as exc:  # yt-dlp raises many types; give the user its message
        msg = str(exc).replace("ERROR: ", "").strip().splitlines()[0][:300] if str(exc) else "Download failed"
        if js is None and any(s in str(exc).lower() for s in _JS_ERRORS):
            raise JobError(f"Download failed: {NO_JS_RUNTIME_HINT}") from exc
        raise JobError(f"Download failed: {msg}") from exc
    if info is None:
        raise JobError("Download failed: no media found")
    if "entries" in info:  # playlists are disabled but some extractors still wrap
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise JobError("Download failed: no media found")
        info = entries[0]
    files = sorted(p for p in out_dir.glob("download.*") if not p.name.endswith(".part"))
    if not files:
        raise JobError("Download failed: no file produced")
    return files[0], (info.get("title") or "Untitled")[:200]
