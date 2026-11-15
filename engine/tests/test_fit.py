"""v1.2: fit the sample to the project tempo / key (Signalsmith Stretch), re-analyzed."""
import pytest
import soundfile as sf

from engine.services import stretch
from engine.tests.conftest import wait_job


def test_key_math():
    assert stretch.key_shift("Am", "C") == 0          # relative major = same key
    assert stretch.key_shift("Am", "Bm") == 2
    assert stretch.key_shift("C", "F#") == 6 or stretch.key_shift("C", "F#") == -6
    assert stretch.key_shift("G", "C") == 5
    assert stretch.key_shift("C", "Bb") == -2
    assert stretch.shifted_key("Am", 2) == "Bm"
    assert stretch.shifted_key("A#", -1) == "A"
    with pytest.raises(ValueError):
        stretch.parse_key("H#")


def _fit(client, tid, **body):
    r = client.post(f"/api/v1/tracks/{tid}/fit", json=body)
    assert r.status_code == 202, r.get_json()
    out = r.get_json()
    job = wait_job(client, out["job_id"], timeout=300)
    assert job["status"] == "done", job
    return out, client.get(f"/api/v1/tracks/{out['track_id']}").get_json()


def test_fit_tempo_keeps_pitch_and_redetects_bpm(ready_track):
    client, tid = ready_track
    parent = client.get(f"/api/v1/tracks/{tid}").get_json()
    pa = parent["analysis"]
    out, t = _fit(client, tid, bpm=100)
    a = t["analysis"]
    assert out["ratio"] == pytest.approx(pa["bpm"] / 100)
    assert t["duration"] == pytest.approx(parent["duration"] * pa["bpm"] / 100, abs=0.01)  # length x ratio
    assert a["bpm"] == 100 and abs(a["fit"]["detected_bpm"] - 100) <= 1          # re-detects within +-1
    assert a["fit"]["detected_key"] == pa["key"] == a["key"]                      # pitch unchanged
    assert a["downbeat"] == pytest.approx(pa["downbeat"] * pa["bpm"] / 100, abs=1e-3)
    assert t["title"].endswith("(100 BPM)")


def test_fit_key_shift_keeps_tempo(ready_track):
    client, tid = ready_track
    parent = client.get(f"/api/v1/tracks/{tid}").get_json()
    pa = parent["analysis"]
    target = stretch.shifted_key(pa["key"], 2)
    out, t = _fit(client, tid, key=target)
    a = t["analysis"]
    assert out["semitones"] == 2
    assert a["fit"]["detected_key"] == target == a["key"]                        # the new key re-detects
    assert t["duration"] == pytest.approx(parent["duration"], abs=0.01)           # tempo kept
    assert abs(a["fit"]["detected_bpm"] - pa["bpm"]) <= 1


def test_fit_validation(ready_track):
    client, tid = ready_track
    for body in [{}, {"bpm": 10}, {"bpm": "x"}, {"key": "H"}]:
        assert client.post(f"/api/v1/tracks/{tid}/fit", json=body).status_code == 400
