"""Engine configuration.

Everything a client (desktop app or the future JUCE plugin) may need to know about the
engine's behaviour lives here, so it can be overridden with environment variables.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ENGINE_VERSION = "1.2.0"
API_VERSION = "v1"
API_PREFIX = f"/api/{API_VERSION}"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def app_data_dir() -> Path:
    """<user app-data>/TheRipper, per OS."""
    override = os.environ.get("RIPPER_APP_DATA")
    if override:
        base = Path(override)
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "TheRipper"
    elif sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "TheRipper"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "TheRipper"
    base.mkdir(parents=True, exist_ok=True)
    return base


def log_dir() -> Path:
    """Engine crash traces (engine-crash.log). The desktop app passes its own log folder."""
    from .runtime import log_dir as _log_dir
    d = _log_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def default_storage_dir() -> Path:
    override = os.environ.get("RIPPER_STORAGE")
    if override:
        return Path(override)
    if getattr(sys, "frozen", False):  # PyInstaller build: engine dir is read-only
        return app_data_dir() / "storage"
    return Path(__file__).resolve().parent / "storage"


# --- Free vs Pro ----------------------------------------------------------------------
# Wire payments later by flipping PRO_ENABLED at runtime (e.g. after licence check).
PRO_ENABLED = _env_bool("RIPPER_PRO", True)

# Feature -> requires Pro?
FEATURES = {
    "stems_dsp": False,
    "stems_ai": False,       # HQ (AI) stems are free for now (the add-on is a free download)
    "stems_6": False,        # htdemucs_6s, free with the rest of HQ (AI)
    "banks_beyond_b": True,  # chopping into pad banks C-H
    "batch_export": True,    # more than one slice in one export / folder export
    "export_kit": True,      # zip/drag with stems and/or MIDI
    "single_export": False,  # one slice or one stem
    "patterns_beyond_b": True,  # sequencer patterns C-H
    "vintage": True,         # vintage 12-bit / 16-bit bank character
    "effects": True,         # pad + master effects
    "resample": True,        # record pads / sequencer into a new sample
    "fit": True,             # time-stretch / key-shift the sample to the project
}

MAX_UPLOAD_BYTES = 200 * 1024 * 1024          # audio files
MAX_VIDEO_BYTES = 500 * 1024 * 1024           # video files (only their audio is kept)
AUDIO_EXTENSIONS = {".wav", ".mp3"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
ALLOWED_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS


def max_bytes_for(ext: str) -> int:
    return MAX_VIDEO_BYTES if ext.lower() in VIDEO_EXTENSIONS else MAX_UPLOAD_BYTES


TARGET_SR = 44100
PURGE_AGE_SECONDS = 24 * 3600
PURGE_INTERVAL_SECONDS = 3600
JOB_WORKERS = int(os.environ.get("RIPPER_JOB_WORKERS", "2"))

# CORS: the desktop renderer runs on a custom scheme; the Vite dev server only in dev.
DEV_MODE = _env_bool("RIPPER_DEV", False)
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
APP_ORIGINS = ["ripper://app"]

# HQ (AI) models. "weights" = the checkpoint whose files are fetched from the author's
# Hugging Face repo (DEMUCS_WEIGHTS); two_stem runs htdemucs and sums all but vocals.
DEMUCS_MODELS = {
    "htdemucs": {"label": "4 stems (drums, bass, vocals, other)", "weights": "htdemucs",
                 "stems": ["drums", "bass", "other", "vocals"], "pro_feature": "stems_ai"},
    "htdemucs_6s": {"label": "6 stems (+ guitar, piano)", "weights": "htdemucs_6s",
                    "stems": ["drums", "bass", "other", "vocals", "guitar", "piano"], "pro_feature": "stems_6"},
    "two_stem": {"label": "2 stems (vocals / instrumental)", "weights": "htdemucs",
                 "stems": ["vocals", "instrumental"], "pro_feature": "stems_ai"},
}

# Fast (no AI) modes: what DSP can honestly do (services/separator_dsp.py).
FAST_MODES = {
    "dsp": {"stems": ["drums", "bass", "music"], "label": "Fast (no AI) — for vocals use HQ (AI)"},
    "center_cancel": {"stems": ["instrumental"], "label": "Fast (no AI) — Instrumental (center cancel)"},
}

# Demucs weights are NOT redistributed by us: the add-on downloads them on the user's machine
# from the author's Hugging Face repos, pinned to these commits and checked against these
# SHA-256 sums (see LICENSES.md for what the author states about their licence).
DEMUCS_WEIGHTS = {
    "htdemucs": {
        "repo": "adefossez/HTDemucs", "revision": "cbc8a9b1a87023b7fd74e7b3412e6321c0eab003",
        "files": {
            "htdemucs.yaml": (21, "239c445d0b14454d541ad8bd9bb271c9e536d267e8a4625208744cbb2e7bb66c"),
            "955717e8.safetensors": (84025440, "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd"),
        },
    },
    "htdemucs_6s": {
        "repo": "adefossez/HTDemucs-6s", "revision": "3c5ee475be622df764938de97e4281a7b07ffa58",
        "files": {
            "htdemucs_6s.yaml": (21, "207405151270af8fd81c2373c25d27950916682ac91dca7884a11ce13dad6f58"),
            "5c90dfd2.safetensors": (54885744, "d2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411"),
        },
    },
}
HF_BASE_URL = os.environ.get("RIPPER_HF_BASE_URL", "https://huggingface.co")

# The HQ (AI) add-on runtime (Python + torch + Demucs, no weights) is built per platform in CI
# and attached to a release of the same app version in a separate public, download-only repo
# (the app's own repo is private, so its release files need a login).
AI_RELEASES_REPO = "baguajoe/the-ripper-addons"
AI_PACK_FORMAT = 1
AI_MANIFEST_NAME = "ripper-ai-manifest.json"


def ai_manifest_url() -> str:
    return os.environ.get("RIPPER_AI_MANIFEST_URL") or (
        f"https://github.com/{AI_RELEASES_REPO}/releases/download/v{ENGINE_VERSION}/{AI_MANIFEST_NAME}")


def is_allowed(feature: str, pro_enabled: bool) -> bool:
    return pro_enabled or not FEATURES.get(feature, False)
