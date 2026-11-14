"""ffmpeg / ffprobe helpers."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from ..jobs import JobError
from . import tools

FFMPEG_INSTALL_HINT = (
    "ffmpeg was not found. The Ripper ships its own copy of ffmpeg + ffprobe; if you see this,\n"
    "the app's files may be incomplete - reinstalling The Ripper should fix it.\n"
    "Running from source? Install ffmpeg:\n"
    "  macOS:   brew install ffmpeg\n"
    "  Windows: winget install Gyan.FFmpeg   (or choco install ffmpeg), then restart\n"
    "  Linux:   sudo apt install ffmpeg      (or your distro's package)\n"
    "Or set RIPPER_FFMPEG / RIPPER_FFPROBE to the full path of the binaries."
)

_NO_WINDOW = tools._NO_WINDOW


def ffmpeg_bin() -> str | None:
    """ffmpeg to run: override → bundled copy → PATH (see services/tools.py)."""
    t = tools.find("ffmpeg")
    return t.path if t else None


def ffprobe_bin() -> str | None:
    t = tools.find("ffprobe")
    return t.path if t else None


def ffmpeg_location() -> str | None:
    """For yt-dlp's --ffmpeg-location: the folder holding both binaries, else ffmpeg itself."""
    ff, fp = ffmpeg_bin(), ffprobe_bin()
    if not ff:
        return None
    if fp and Path(fp).parent == Path(ff).parent:
        return str(Path(ff).parent)
    return ff


def check_ffmpeg() -> bool:
    return bool(ffmpeg_bin()) and bool(ffprobe_bin())


def _run(cmd: list[str], timeout: float = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=_NO_WINDOW)


def probe(path: Path) -> dict | None:
    """Return {duration, codec, channels, sample_rate} for the first audio stream, or None."""
    probe_bin = ffprobe_bin()
    if not probe_bin:
        raise JobError("ffprobe not available")
    try:
        res = _run([probe_bin, "-v", "error", "-print_format", "json", "-show_streams",
                    "-show_format", str(path)], timeout=60)
    except subprocess.TimeoutExpired:
        return None
    if res.returncode != 0:
        return None
    try:
        info = json.loads(res.stdout or b"{}")
    except json.JSONDecodeError:
        return None
    audio = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio:
        return None
    s = audio[0]
    duration = s.get("duration") or info.get("format", {}).get("duration")
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = None
    return {
        "duration": duration,
        "codec": s.get("codec_name"),
        "channels": s.get("channels"),
        "sample_rate": int(s.get("sample_rate") or 0),
        "format": info.get("format", {}).get("format_name"),
    }


def inspect(path: Path) -> dict:
    """{readable, has_audio, has_video, duration} - tells "not media" from "no audio track"."""
    probe_bin = ffprobe_bin()
    if not probe_bin:
        raise JobError("ffprobe not available")
    out = {"readable": False, "has_audio": False, "has_video": False, "duration": None}
    try:
        res = _run([probe_bin, "-v", "error", "-print_format", "json", "-show_streams",
                    "-show_format", str(path)], timeout=60)
        info = json.loads(res.stdout or b"{}") if res.returncode == 0 else None
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        info = None
    if not info:
        return out
    streams = info.get("streams", [])
    out["readable"] = bool(streams)
    out["has_audio"] = any(s.get("codec_type") == "audio" for s in streams)
    # cover art in an MP3 shows up as a video stream; only count real (non-attached) video
    out["has_video"] = any(s.get("codec_type") == "video"
                           and not (s.get("disposition") or {}).get("attached_pic") for s in streams)
    try:
        out["duration"] = float(info.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        pass
    return out


def _decode(src: Path, dst: Path, sr: int, extra: list[str], what: str) -> None:
    exe = ffmpeg_bin()
    if not exe:
        raise JobError("ffmpeg not available")
    tmp = dst.with_name(dst.stem + ".tmp.wav")
    # Paths go to ffmpeg as separate argv entries (never through a shell), so spaces, periods
    # and non-ASCII characters in user folders are passed through untouched.
    res = _run([exe, "-nostdin", "-y", "-v", "error", "-i", str(src), *extra, "-vn", "-sn", "-dn",
                "-ac", "2", "-ar", str(sr), "-c:a", "pcm_f32le", str(tmp)])
    if res.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        detail = (res.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise JobError(f"Could not {what} (ffmpeg failed{': ' + detail[-1][:200] if detail else ''})")
    tmp.replace(dst)


def convert_to_wav(src: Path, dst: Path, sr: int = 44100) -> None:
    """Decode anything ffmpeg understands to 44.1 kHz stereo 32-bit float WAV."""
    _decode(src, dst, sr, ["-map", "0:a:0"], "decode audio")


def extract_audio(video: Path, dst: Path, sr: int = 44100) -> None:
    """First audio track of a video -> 44.1 kHz stereo WAV (the picture is dropped)."""
    if not inspect(video)["has_audio"]:
        raise JobError("That video has no audio track")
    _decode(video, dst, sr, ["-map", "0:a:0"], "extract the audio from that video")


def read_stereo(path: Path) -> tuple[np.ndarray, int]:
    """Read a WAV as float32 array shaped (channels=2, samples)."""
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    data = data.T
    if data.shape[0] == 1:
        data = np.vstack([data, data])
    return np.ascontiguousarray(data[:2]), sr
