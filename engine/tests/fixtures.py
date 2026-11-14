"""Generate test audio in code (no downloads).

    python -m engine.tests.fixtures [out_dir]

Produces:
    beat_120.wav / beat_120.mp3   12 s, 120 BPM kick on every beat + A-minor pad + A1 bass
    beat_90.wav                   same at 90 BPM
    song_126.wav                  4:00 "song", 126 BPM, E minor (i-iv-V-i), kick + chords + bass
    song_126.mp4                  the same song as the audio of an MP4 (needs ffmpeg)
    video_noaudio.mp4             2 s video with no audio track (needs ffmpeg)
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


SONG_BPM = 126.0
SONG_KEY = "Em"
SONG_SECONDS = 240.0


def _midi_hz(note: float) -> float:
    return 440.0 * 2 ** ((note - 69) / 12)


def make_song(bpm: float = SONG_BPM, duration: float = SONG_SECONDS, sr: int = SR) -> np.ndarray:
    """A 4-minute E-minor "song": i-iv-V-i (Em Am B Em), two bars per chord, a bass line on
    the chord roots, a melody on the tonic triad and a kick on every beat."""
    n = int(duration * sr)
    t = np.arange(n, dtype=np.float64) / sr
    bar = 4 * 60.0 / bpm
    chords = [[64, 67, 71], [69, 72, 76], [71, 75, 78], [64, 67, 71]]   # Em, Am, B, Em
    roots = np.array([40, 45, 47, 40], dtype=float)                       # E2 A2 B2 E2
    idx = (t // (2 * bar)).astype(int) % 4
    out = np.zeros(n, dtype=np.float64)
    for ci, chord in enumerate(chords):
        m = idx == ci
        for note in chord:
            out[m] += 0.045 * np.sin(2 * np.pi * _midi_hz(note) * t[m])
    bass_hz = 440.0 * 2 ** ((roots[idx] - 69) / 12)
    out += 0.11 * np.sin(2 * np.pi * np.cumsum(bass_hz) / sr)
    # melody: E5 G5 B5 G5 per beat (tonic arpeggio), soft
    beat = 60.0 / bpm
    mel = np.array([76, 79, 83, 79], dtype=float)[(t // beat).astype(int) % 4]
    out += 0.03 * np.sin(2 * np.pi * np.cumsum(440.0 * 2 ** ((mel - 69) / 12)) / sr)
    out = out.astype(np.float32)
    kick = _kick(sr) * 0.8
    k = 0
    while k * beat < duration:
        start = int(round(k * beat * sr))
        end = min(n, start + len(kick))
        out[start:end] += kick[: end - start]
        k += 1
    out /= max(1.0, float(np.max(np.abs(out))) / 0.9)
    return np.stack([out, out * 0.98])


def make_videos(out_dir: Path, song_wav: Path, ffmpeg: str) -> dict[str, Path]:
    """song_126.mp4 (song as AAC audio + a tiny black video) and video_noaudio.mp4."""
    paths = {}
    mp4 = out_dir / "song_126.mp4"
    if not mp4.exists():
        subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=5",
                        "-i", str(song_wav), "-shortest", "-map", "0:v", "-map", "1:a",
                        "-c:v", "mpeg4", "-q:v", "20", "-c:a", "aac", "-b:a", "160k", str(mp4)],
                       check=True)
    paths["mp4"] = mp4
    silent = out_dir / "video_noaudio.mp4"
    if not silent.exists():
        subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=5",
                        "-t", "2", "-an", "-c:v", "mpeg4", str(silent)], check=True)
    paths["mp4_noaudio"] = silent
    return paths


def generate(out_dir: Path = DEFAULT_DIR, song: bool = True) -> dict[str, Path]:
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
    if song:
        sp = out_dir / "song_126.wav"
        if not sp.exists():
            sf.write(str(sp), make_song().T, SR, subtype="PCM_16")
        paths["song"] = sp
        if ffmpeg:
            paths.update(make_videos(out_dir, sp, ffmpeg))
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
