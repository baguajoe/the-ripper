import importlib.util

import numpy as np
import pytest

from engine.services import media, separator_ai, separator_dsp
from engine.tests.conftest import wait_job


def test_dsp_stems(converted):
    audio, sr = media.read_stereo(converted["wav120"])
    stems = separator_dsp.separate(audio, sr)
    assert set(stems) == {"drums", "bass", "vocals", "other"}
    for name, s in stems.items():
        assert s.shape == audio.shape, name
        assert np.isfinite(s).all(), name
    rms = float(np.sqrt(np.mean(stems["drums"] ** 2)))
    assert rms > 0.01, rms
    # the four stems sum back to the mix
    assert np.max(np.abs(sum(stems.values()) - audio)) < 1e-3
    # bass stem carries the A1 sine: most of its energy is below 150 Hz
    spec = np.abs(np.fft.rfft(stems["bass"][0]))
    freqs = np.fft.rfftfreq(stems["bass"].shape[1], 1 / sr)
    assert spec[freqs < 150].sum() / spec.sum() > 0.8


def test_stems_api_dsp(ready_track):
    client, tid = ready_track
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "dsp"})
    assert r.status_code == 202
    job = wait_job(client, r.get_json()["job_id"])
    assert job["status"] == "done", job
    assert job["result"]["names"] == ["drums", "bass", "vocals", "other"]
    r = client.get(f"/api/v1/tracks/{tid}/stems/drums")
    assert r.status_code == 200 and r.data[:4] == b"RIFF"
    assert client.get(f"/api/v1/tracks/{tid}/stems/nope").status_code == 404


def test_stems_bad_engine(ready_track):
    client, tid = ready_track
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "magic"})
    assert r.status_code == 400 and r.get_json()["error"] == "invalid_engine"


HAS_DEMUCS = importlib.util.find_spec("demucs") is not None and importlib.util.find_spec("torch") is not None


@pytest.mark.skipif(not HAS_DEMUCS, reason="torch/demucs not installed (optional: pip install -r engine/requirements-ai.txt)")
def test_demucs_two_stem(converted):
    audio, sr = media.read_stereo(converted["wav120"])
    clip = audio[:, : 5 * sr]
    try:
        stems, device = separator_ai.separate(clip, sr, "two_stem")
    except Exception as exc:  # model weights need a one-time download
        msg = str(exc).lower()
        if any(s in msg for s in ("urlopen", "connection", "resolve", "network", "http error", "timed out")):
            pytest.skip(f"Demucs weights could not be downloaded: {exc}")
        raise
    assert set(stems) == {"vocals", "instrumental"}
    assert device in {"cpu", "cuda", "mps"}
    for s in stems.values():
        assert s.shape == clip.shape
        assert np.isfinite(s).all()
    # vocals + instrumental reconstructs the clip reasonably (no vocals in the fixture)
    inst_rms = float(np.sqrt(np.mean(stems["instrumental"] ** 2)))
    voc_rms = float(np.sqrt(np.mean(stems["vocals"] ** 2)))
    assert inst_rms > voc_rms


def test_ai_unavailable_is_graceful(ready_track, monkeypatch):
    client, tid = ready_track
    monkeypatch.setattr(separator_ai, "_probe", {"available": False, "device": None,
                                                 "reason": "not installed"})
    r = client.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "ai", "model": "htdemucs"})
    assert r.status_code == 409 and r.get_json()["error"] == "ai_unavailable"
    h = client.get("/api/v1/health").get_json()
    assert h["demucs_available"] is False and h["demucs_reason"] == "not installed"
