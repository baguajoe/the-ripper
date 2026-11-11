"""Engine configuration.

Everything a client (desktop app or the future JUCE plugin) may need to know about the
engine's behaviour lives here, so it can be overridden with environment variables.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ENGINE_VERSION = "1.0.0"
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
    "stems_ai": True,        # Demucs engine
    "stems_6": True,         # htdemucs_6s
    "batch_export": True,    # more than one slice in one export / folder export
    "export_kit": True,      # zip/drag with stems and/or MIDI
    "single_export": False,  # one slice or one stem
}

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
ALLOWED_EXTENSIONS = {".wav", ".mp3"}
TARGET_SR = 44100
PURGE_AGE_SECONDS = 24 * 3600
PURGE_INTERVAL_SECONDS = 3600
JOB_WORKERS = int(os.environ.get("RIPPER_JOB_WORKERS", "2"))

# CORS: the desktop renderer runs on a custom scheme; the Vite dev server only in dev.
DEV_MODE = _env_bool("RIPPER_DEV", False)
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
APP_ORIGINS = ["ripper://app"]

DEMUCS_MODELS = {
    "htdemucs": {"label": "4 stems (htdemucs)", "pro_feature": "stems_ai"},
    "htdemucs_6s": {"label": "6 stems (+guitar, piano)", "pro_feature": "stems_6"},
    "htdemucs_ft": {"label": "Best quality (htdemucs_ft, slower)", "pro_feature": "stems_ai"},
    "two_stem": {"label": "Vocals / Instrumental", "pro_feature": "stems_ai"},
}


def is_allowed(feature: str, pro_enabled: bool) -> bool:
    return pro_enabled or not FEATURES.get(feature, False)
