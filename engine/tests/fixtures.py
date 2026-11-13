"""Generate test audio in code (no downloads).

    python -m engine.tests.fixtures [out_dir]

Produces:
    beat_120.wav / beat_120.mp3   12 s, 120 BPM kick on every beat + A-minor pad + A1 bass
    beat_90.wav                   same at 90 BPM
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from engine.services import media

SR = 44100
DURATION = 12.0
DEFAULT_DIR = Path(__file__).resolve().parent / "fixtures" / "generated"


def _kick(sr: int = SR) -> np.ndarray:
    n = int(0.25 * sr)
    t = np.arange(n) / sr
    freq = 50 + 100 * np.exp(-t * 30)           # 150 Hz -> 50 Hz pitch drop
    phase = 2 * np.pi * np.cumsum(freq) / sr
    env = np.exp(-t * 14)
    click = np.exp(-t * 400) * 0.6               # beater click for a sharp transient
    noise = np.random.default_rng(0).standard_normal(n) * click * 0.3
    return (np.sin(phase) * env + noise).astype(np.float32)


def make_beat(bpm: float, duration: float = DURATION, sr: int = SR) -> np.ndarray:
    n = int(duration * sr)
    t = np.arange(n) / sr
    pad = 0.06 * (np.sin(2 * np.pi * 220.00 * t)      # A3
                  + np.sin(2 * np.pi * 261.63 * t)    # C4
                  + np.sin(2 * np.pi * 329.63 * t))   # E4
    bass = 0.12 * np.sin(2 * np.pi * 55.0 * t)        # A1
    mono = (pad + bass).astype(np.float32)
    kick = _kick(sr) * 0.8
    period = 60.0 / bpm
    k = 0
    while k * period < duration:
        start = int(round(k * period * sr))
        end = min(n, start + len(kick))
        mono[start:end] += kick[: end - start]
        k += 1
    mono /= max(1.0, float(np.max(np.abs(mono))) / 0.9)
    return np.stack([mono, mono * 0.98])


def generate(out_dir: Path = DEFAULT_DIR) -> dict[str, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for bpm in (120, 90):
        p = out_dir / f"beat_{bpm}.wav"
        if not p.exists():
            sf.write(str(p), make_beat(bpm).T, SR, subtype="PCM_16")
        paths[f"wav{bpm}"] = p
    mp3 = out_dir / "beat_120.mp3"
    ffmpeg = media.ffmpeg_bin()
    if not mp3.exists() and ffmpeg:
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(paths["wav120"]),
                        "-codec:a", "libmp3lame", "-b:a", "192k", str(mp3)], check=True)
    paths["mp3"] = mp3
    bad = out_dir / "not_audio.wav"
    if not bad.exists():
        bad.write_bytes(b"this is definitely not a wav file" * 10)
    paths["bad"] = bad
    txt = out_dir / "notes.txt"
    if not txt.exists():
        txt.write_text("hello")
    paths["txt"] = txt
    return paths


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DIR
    for name, path in generate(out).items():
        print(f"{name}: {path}")
