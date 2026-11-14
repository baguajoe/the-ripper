import importlib.util

import numpy as np
import pytest

from engine.services import addon, media, separator_ai, separator_dsp
from engine.tests.conftest import wait_job


def test_fast_stems_are_exactly_drums_bass_music(converted):
    audio, sr = media.read_stereo(converted["wav120"])
    stems = separator_dsp.separate(audio, sr)
    assert list(stems) == ["drums", "bass", "music"]
    for name, s in stems.items():
        assert s.shape == audio.shape, name
        assert np.isfinite(s).all(), name
    rms = float(np.sqrt(np.mean(stems["drums"] ** 2)))
    assert rms > 0.01, rms
    # the three stems sum back to the mix
    assert np.max(np.abs(sum(stems.values()) - audio)) < 1e-3
    # bass stem carries the A1 sine: most of its energy is below 150 Hz
    spec = np.abs(np.fft.rfft(stems["bass"][0]))
    freqs = np.fft.rfftfreq(stems["bass"].shape[1], 1 / sr)
    assert spec[freqs < 150].sum() / spec.sum() > 0.8


def _band(x: np.ndarray, sr: int, f: float) -> float:
    spec = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    return float(spec[(freqs > f - 5) & (freqs < f + 5)].sum())


def test_center_cancel_removes_the_centre_keeps_sides_and_low_end():
    sr = 44100
    t = np.arange(4 * sr) / sr
    vocal = 0.3 * np.sin(2 * np.pi * 440 * t)         # dead centre (a "lead vocal")
    guitar = 0.3 * np.sin(2 * np.pi * 660 * t)        # panned hard left
    bass = 0.3 * np.sin(2 * np.pi * 55 * t)           # centre, low: must be kept
    mix = np.stack([vocal + guitar + bass, vocal + bass]).astype(np.float32)
    out = separator_dsp.separate(mix, sr, mode="center_cancel")
    assert list(out) == ["instrumental"]
    inst = out["instrumental"]
    assert inst.shape == mix.shape and np.isfinite(inst).all()
    left = inst[0]
    assert _band(left, sr, 440) < 0.01 * _band(mix[0], sr, 440)   # vocal gone (> 40 dB down)
    assert _band(left, sr, 660) > 0.4 * _band(mix[0], sr, 660)    # side content kept
    assert _band(left, sr, 55) > 0.8 * _band(mix[0], sr, 55)      # low end kept


def test_stems_api_fast(ready_track):
    client, tid = ready_track
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "dsp"})
    assert r.status_code == 202
    job = wait_job(client, r.get_json()["job_id"])
    assert job["status"] == "done", job
    assert job["result"]["names"] == ["drums", "bass", "music"]
    assert job["result"]["label"] == "Fast (no AI) — for vocals use HQ (AI)"
    r = client.get(f"/api/v1/tracks/{tid}/stems/drums")
    assert r.status_code == 200 and r.data[:4] == b"RIFF"
    assert client.get(f"/api/v1/tracks/{tid}/stems/nope").status_code == 404

    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "dsp", "model": "center_cancel"})
    job = wait_job(client, r.get_json()["job_id"])
    assert job["status"] == "done", job
    assert job["result"]["names"] == ["instrumental"]
    assert "center cancel" in job["result"]["label"]
    h = client.get("/api/v1/health").get_json()
    assert set(h["fast_models"]) == {"dsp", "center_cancel"}
    assert set(h["models"]) == {"htdemucs", "htdemucs_6s", "two_stem"}


def test_stems_bad_engine_or_model(ready_track):
    client, tid = ready_track
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "magic"})
    assert r.status_code == 400 and r.get_json()["error"] == "invalid_engine"
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "dsp", "model": "vocals"})
    assert r.status_code == 400 and r.get_json()["error"] == "invalid_model"
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "ai", "model": "htdemucs_ft"})
    assert r.status_code == 400 and r.get_json()["error"] == "invalid_model"


def test_estimate(ready_track):
    client, tid = ready_track
    for model in ("htdemucs", "htdemucs_6s", "two_stem"):
        e = client.get(f"/api/v1/tracks/{tid}/stems/estimate?engine=ai&model={model}").get_json()
        assert e["seconds"] > 0 and e["device"] in ("cpu", "cuda", "mps")
    six = client.get(f"/api/v1/tracks/{tid}/stems/estimate?engine=ai&model=htdemucs_6s").get_json()
    four = client.get(f"/api/v1/tracks/{tid}/stems/estimate?engine=ai&model=htdemucs").get_json()
    assert six["seconds"] >= four["seconds"]
    assert client.get(f"/api/v1/tracks/{tid}/stems/estimate?engine=dsp").get_json()["seconds"] > 0


def test_estimate_learns_from_a_run(tmp_path, monkeypatch):
    monkeypatch.setattr(addon, "addon_dir", lambda: tmp_path)
    first = addon.estimate_seconds(60, "htdemucs", "cpu", 8)
    assert not first["learned"]
    addon.record_timing("htdemucs", "cpu", audio_seconds=10, seconds=25, load_seconds=5, wall_seconds=28)
    e = addon.estimate_seconds(60, "htdemucs", "cpu", 8)
    assert e["learned"] and e["seconds"] == pytest.approx(8 + 2.0 * 60, rel=1e-3)
    # two_stem runs the same network as htdemucs but is its own entry
    assert not addon.estimate_seconds(60, "two_stem", "cpu", 8)["learned"]


HAS_DEMUCS = importlib.util.find_spec("demucs") is not None and importlib.util.find_spec("torch") is not None
needs_demucs = pytest.mark.skipif(not HAS_DEMUCS, reason="torch/demucs not installed in this Python "
                                                         "(the app gets them from the HQ (AI) add-on)")


def _run_or_skip(fn):
    try:
        return fn()
    except Exception as exc:  # model weights need a one-time download
        msg = str(exc).lower()
        if any(s in msg for s in ("urlopen", "connection", "resolve", "network", "http error",
                                  "timed out", "interrupted", "download server")):
            pytest.skip(f"Demucs weights could not be downloaded: {exc}")
        raise


@needs_demucs
@pytest.mark.parametrize("model,names", [
    ("htdemucs", {"drums", "bass", "other", "vocals"}),
    ("htdemucs_6s", {"drums", "bass", "other", "vocals", "guitar", "piano"}),
    ("two_stem", {"vocals", "instrumental"}),
])
def test_demucs_models(converted, model, names):
    audio, sr = media.read_stereo(converted["wav120"])
    clip = audio[:, : 5 * sr]
    stems, device = _run_or_skip(lambda: separator_ai.separate(clip, sr, model))
    assert set(stems) == names
    assert device in {"cpu", "cuda", "mps"}
    for s in stems.values():
        assert s.shape == clip.shape
        assert np.isfinite(s).all()
    if model == "two_stem":  # no vocals in the fixture
        inst = float(np.sqrt(np.mean(stems["instrumental"] ** 2)))
        voc = float(np.sqrt(np.mean(stems["vocals"] ** 2)))
        assert inst > voc


def test_ai_unavailable_is_graceful(ready_track, monkeypatch):
    client, tid = ready_track
    monkeypatch.setattr(separator_ai, "_probe", {"available": False, "device": None, "gpu": None,
                                                 "reason": separator_ai.NOT_INSTALLED})
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "ai", "model": "htdemucs"})
    assert r.status_code == 409 and r.get_json()["error"] == "ai_unavailable"
    h = client.get("/api/v1/health").get_json()
    assert h["demucs_available"] is False and h["demucs_reason"] == separator_ai.NOT_INSTALLED
    assert "pip" not in h["demucs_reason"]  # customers can't run pip


def test_no_runtime_means_not_installed(monkeypatch):
    monkeypatch.setattr(separator_ai, "runtime", lambda: None)
    p = separator_ai.probe()
    assert p["available"] is False and p["reason"] == separator_ai.NOT_INSTALLED
