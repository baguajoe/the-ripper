"""v1.2: rendered clips (shaped pads) packaged by the exporter, keep-length pitch shifting,
and the Signalsmith stretch wrapper."""
import io

import numpy as np
import pytest
import soundfile as sf

from engine.services import clips, stretch

SR = 44100


def _freq(x: np.ndarray, sr: int) -> float:
    """Frequency of the strongest FFT bin (parabolic interpolation)."""
    w = np.hanning(len(x))
    mag = np.abs(np.fft.rfft(x * w))
    k = int(np.argmax(mag[1:])) + 1
    a, b, c = np.log(mag[k - 1:k + 2] + 1e-12)
    k += 0.5 * (a - c) / (a - 2 * b + c)
    return k * sr / len(x)


def _sine(f, seconds, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    x = (0.5 * np.sin(2 * np.pi * f * t)).astype(np.float32)
    return np.vstack([x, x])


def _upload_clip(client, data: np.ndarray, sr=SR) -> str:
    raw = np.ascontiguousarray(data, dtype="<f4").tobytes()
    r = client.post("/api/v1/clips", data=raw, headers={"X-Ripper-SR": str(sr), "X-Ripper-Channels": str(data.shape[0]),
                                                         "Content-Type": "application/octet-stream"})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["clip"]


def test_stretch_keeps_length_and_transposes():
    x = _sine(440, 2.0)
    y = stretch.pitch_shift(x, SR, 12)
    assert y.shape == x.shape
    assert _freq(y[0, SR // 2: SR + SR // 2], SR) == pytest.approx(880, rel=0.01)
    z = stretch.process(x, SR, time_ratio=1.5)
    assert z.shape[1] == round(x.shape[1] * 1.5)
    assert _freq(z[0, SR // 2: SR + SR // 2], SR) == pytest.approx(440, rel=0.01)  # pitch unchanged
    assert stretch.process(x, SR).shape == x.shape


def test_clip_store_roundtrip(tmp_path):
    x = _sine(300, 0.5)
    cid = clips.store(tmp_path, np.ascontiguousarray(x, dtype="<f4").tobytes(), SR, 2)
    assert clips.valid_id(cid) and clips.exists(tmp_path, cid)
    y, sr = clips.load(tmp_path, cid)
    assert sr == SR and np.array_equal(x, y)
    assert clips.store(tmp_path, np.ascontiguousarray(x, dtype="<f4").tobytes(), SR, 2) == cid  # content-addressed
    for bad in [(b"\x00" * 7, SR, 2), (b"\x00" * 8, 10, 2), (np.float32([np.nan, 0]).tobytes(), SR, 1)]:
        with pytest.raises(ValueError):
            clips.store(tmp_path, *bad)
    assert not clips.exists(tmp_path, "../../etc/passwd")


def test_export_packages_a_rendered_clip(ready_track):
    client, tid = ready_track
    clip = _sine(500, 0.75)
    cid = _upload_clip(client, clip)
    body = {"slices": [{"start": 1.0, "end": 1.5, "name": "shaped", "clip": cid}], "format": "wav",
            "mode": "oneshot", "sr": 44100}
    r = client.post(f"/api/v1/tracks/{tid}/export", json=body)
    assert r.status_code == 200, r.get_json()
    data, sr = sf.read(io.BytesIO(r.data), always_2d=True)
    assert sr == 44100 and data.shape[0] == clip.shape[1]  # the clip's length, not the slice's
    assert np.max(np.abs(data[:, 0] - clip[0])) < 1e-4    # 24-bit
    # loop mode: tempo-locked to whole beats at the track's BPM; 48 kHz resampled
    bpm = client.get(f"/api/v1/tracks/{tid}").get_json()["analysis"]["bpm"]
    r = client.post(f"/api/v1/tracks/{tid}/export", json={**body, "mode": "loop", "sr": 48000})
    data, sr = sf.read(io.BytesIO(r.data), always_2d=True)
    beats = max(1, round(0.75 * bpm / 60))
    assert sr == 48000 and data.shape[0] == round(beats * 60 / bpm * 48000)


def test_unknown_clip_is_a_clear_error(ready_track):
    client, tid = ready_track
    r = client.post(f"/api/v1/tracks/{tid}/export", json={"slices": [{"start": 0, "end": 1, "clip": "0" * 40}], "format": "wav"})
    assert r.status_code == 404 and r.get_json()["error"] == "clip_not_found"
    r = client.post("/api/v1/clips", data=b"abc", headers={"X-Ripper-SR": "44100", "X-Ripper-Channels": "2"})
    assert r.status_code == 400


def test_pitch_route_keeps_length(ready_track):
    client, tid = ready_track
    r = client.post(f"/api/v1/tracks/{tid}/pitch", json={"start": 0.5, "end": 1.5, "semitones": 7})
    assert r.status_code == 200, r.get_json()
    sr = int(r.headers["X-Ripper-SR"])
    ch = int(r.headers["X-Ripper-Channels"])
    data = np.frombuffer(r.data, dtype="<f4").reshape(ch, -1)
    assert ch == 2 and sr == SR and data.shape[1] == SR  # exactly 1 s
    assert np.isfinite(data).all() and np.max(np.abs(data)) > 0.01
    for bad in [{"start": 1, "end": 0.5, "semitones": 1}, {"start": 0, "end": 1}, {"start": 0, "end": 1, "semitones": 99}]:
        assert client.post(f"/api/v1/tracks/{tid}/pitch", json=bad).status_code == 400
