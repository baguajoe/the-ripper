"""v1.2 beat exports: rendered items (beat / pad stems), sequencer MIDI, chops in original position."""
import base64
import io
import os
import zipfile

import numpy as np
import soundfile as sf

from engine.services import exporter, media
from engine.tests.conftest import make_client

SR = 44100


def _clip(client, data):
    raw = np.ascontiguousarray(data, dtype="<f4").tobytes()
    r = client.post("/api/v1/clips", data=raw, headers={"X-Ripper-SR": str(SR), "X-Ripper-Channels": "2"})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["clip"]


MIDI = bytes.fromhex("4d546864000000060001000203c0") + b"MTrk\x00\x00\x00\x04\x00\xff\x2f\x00" * 2


def test_items_and_midi_render_numbered_files(ready_track, tmp_path):
    client, tid = ready_track
    t = client.get(f"/api/v1/tracks/{tid}").get_json()
    rng = np.random.default_rng(1)
    a = rng.uniform(-0.45, 0.45, (2, SR)).astype(np.float32)
    b = rng.uniform(-0.45, 0.45, (2, SR)).astype(np.float32)
    items = [{"clip": _clip(client, a), "prefix": "pad01", "name": "Kick", "folder": "Beat/Pad stems"},
             {"clip": _clip(client, b), "prefix": "pad02", "name": "Snare hit", "folder": "Beat/Pad stems"}]
    midi = [{"data_b64": base64.b64encode(MIDI).decode(), "prefix": "pattern", "name": "A", "folder": "MIDI"}]
    r = client.post(f"/api/v1/tracks/{tid}/render", json={"kind": "beat", "dest_dir": str(tmp_path), "items": items, "midi_items": midi})
    assert r.status_code == 200, r.get_json()
    names = sorted(os.path.basename(f) for f in r.get_json()["files"])
    base = exporter.base_name(t["title"], t["analysis"]["bpm"], t["analysis"]["key"])
    assert names == [f"{base}_pad01_Kick.wav", f"{base}_pad02_Snare-hit.wav", f"{base}_pattern_A.mid"]
    ka = sf.read(str(tmp_path / f"{base}_pad01_Kick.wav"), always_2d=True)[0].T
    kb = sf.read(str(tmp_path / f"{base}_pad02_Snare-hit.wav"), always_2d=True)[0].T
    assert ka.shape == kb.shape == a.shape                                      # same length, from sample 0
    assert np.max(np.abs(ka + kb - (a + b))) < 1e-5                              # stems sum exactly (24-bit)
    assert (tmp_path / f"{base}_pattern_A.mid").read_bytes() == MIDI
    # in a kit zip they go in subfolders
    r = client.post(f"/api/v1/tracks/{tid}/export", json={"items": items, "midi_items": midi})
    z = zipfile.ZipFile(io.BytesIO(r.data))
    assert sorted(z.namelist()) == [f"Beat/Pad stems/{base}_pad01_Kick.wav", f"Beat/Pad stems/{base}_pad02_Snare-hit.wav", f"MIDI/{base}_pattern_A.mid"]


def test_chops_in_original_position_sum_to_the_original(ready_track, tmp_path):
    client, tid = ready_track
    t = client.get(f"/api/v1/tracks/{tid}").get_json()
    start, end = 2.0, 6.0
    cuts = [2.0, 2.5, 3.1, 4.0, 5.25, 6.0]
    slices = [{"start": a, "end": b, "name": f"chop {i + 1}"} for i, (a, b) in enumerate(zip(cuts[:-1], cuts[1:]))]
    r = client.post(f"/api/v1/tracks/{tid}/render", json={"kind": "beat", "dest_dir": str(tmp_path),
                    "positioned": {"start": start, "end": end, "slices": slices, "folder": "Chops in place"}})
    assert r.status_code == 200, r.get_json()
    files = sorted(r.get_json()["files"])
    assert [os.path.basename(f).split("_")[-2] for f in files] == ["slice01", "slice02", "slice03", "slice04", "slice05"]
    data = [sf.read(f, always_2d=True)[0] for f in files]
    n = int(round((end - start) * SR))
    assert all(d.shape == (n, 2) for d in data)                                  # identical length
    audio, sr = media.read_stereo(client.application.extensions["ripper"].library.track_dir(tid) / "source.wav")
    total = np.sum(data, axis=0)
    ref = audio[:, int(start * sr):int(start * sr) + n].T
    assert np.max(np.abs(total - ref)) < 1e-5                                    # sums back to the original range
    # each file has only its chop: silence before it
    a1 = int(round((cuts[1] - start) * SR))
    assert np.max(np.abs(data[1][:a1])) == 0 and np.max(np.abs(data[1][a1:a1 + 100])) > 0
    # whole-song range default (end clamps to the duration)
    r = client.post(f"/api/v1/tracks/{tid}/export", json={"positioned": {"start": 0, "end": 1e9, "slices": slices[:1]}, "format": "wav"})
    assert r.status_code == 200
    assert sf.info(io.BytesIO(r.data)).frames == int(round(t["duration"] * SR))


def test_beat_parts_validation_and_pro_gate(ready_track, tmp_path):
    client, tid = ready_track
    bad = [{"items": [{"clip": "0" * 40, "prefix": "pad01", "name": "x"}]},
           {"midi_items": [{"data_b64": base64.b64encode(b"nope").decode(), "prefix": "p", "name": "A"}]},
           {"positioned": {"start": 5, "end": 1, "slices": [{"start": 0, "end": 1}]}}]
    for body in bad:
        r = client.post(f"/api/v1/tracks/{tid}/render", json={"kind": "beat", "dest_dir": str(tmp_path), **body})
        assert r.status_code in (400, 404), r.get_json()
    # free plan: two stems = a batch export (Pro); one beat WAV is fine
    app, c = make_client(tmp_path / "free", pro_enabled=False)
    with open(client.application.extensions["ripper"].library.track_dir(tid) / "source.wav", "rb") as fh:
        up = c.post("/api/v1/tracks/upload", data={"file": (fh, "beat.wav")}, content_type="multipart/form-data")
    from engine.tests.conftest import wait_job
    assert wait_job(c, up.get_json()["job_id"])["status"] == "done"
    ftid = up.get_json()["track_id"]
    one = {"clip": _clip(c, np.zeros((2, 100), np.float32)), "prefix": "beat", "name": "A"}
    two = [one, {**one, "prefix": "pad01"}]
    assert c.post(f"/api/v1/tracks/{ftid}/export", json={"items": [one], "format": "wav"}).status_code == 200
    assert c.post(f"/api/v1/tracks/{ftid}/export", json={"items": two}).status_code == 403
