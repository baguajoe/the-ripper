"""v1.2 session files (.ripper)."""
import json
import time
import zipfile

import numpy as np
import soundfile as sf

from engine.services import sessions

STATE = {"version": 2, "program": {"banks": [{"slices": [{"start": 1, "end": 2, "tune": 3, "fx": {"reverb": {"on": True}}}]}],
                                   "seq": {"swing": 61}}, "editor": {"bank": 0}}


def test_save_open_roundtrip(ready_track, tmp_path):
    client, tid = ready_track
    path = str(tmp_path / "My beat.ripper")
    r = client.post("/api/v1/sessions/save", json={"track_id": tid, "state": STATE, "path": path})
    assert r.status_code == 200, r.get_json()
    assert client.get(f"/api/v1/tracks/{tid}").get_json()["pinned"] is True   # saved = never expires
    with zipfile.ZipFile(path) as z:
        doc = json.loads(z.read("session.json"))
        assert doc["format"] == "the-ripper-session" and doc["version"] == sessions.VERSION
        assert "audio/source.flac" in z.namelist()
    r = client.post("/api/v1/sessions/open", json={"path": path})
    assert r.status_code == 200, r.get_json()
    out = r.get_json()
    assert out["state"] == STATE
    t = out["track"]
    orig = client.get(f"/api/v1/tracks/{tid}").get_json()
    assert t["id"] != tid and t["status"] == "ready" and t["pinned"] is True
    assert t["analysis"]["bpm"] == orig["analysis"]["bpm"] and t["duration"] == orig["duration"]
    lib = client.application.extensions["ripper"].library
    a, _ = sf.read(str(lib.track_dir(tid) / "source.wav"), always_2d=True)
    b, _ = sf.read(str(lib.track_dir(t["id"]) / "source.wav"), always_2d=True)
    assert a.shape == b.shape and np.max(np.abs(a - b)) < 2 ** -22               # lossless (24-bit)
    # opening the same file again reuses that track
    assert client.post("/api/v1/sessions/open", json={"path": path}).get_json()["track"]["id"] == t["id"]


def test_older_version_opens_newer_is_refused(ready_track, tmp_path):
    client, tid = ready_track
    path = str(tmp_path / "x.ripper")
    client.post("/api/v1/sessions/save", json={"track_id": tid, "state": {}, "path": path})
    with zipfile.ZipFile(path) as z:
        audio = z.read("audio/source.flac")
        doc = json.loads(z.read("session.json"))
    for version, ok in [(1, True), (sessions.VERSION + 1, False)]:
        p = str(tmp_path / f"v{version}.ripper")
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("session.json", json.dumps({**doc, "version": version, "saved": time.time()}))
            z.writestr("audio/source.flac", audio)
        r = client.post("/api/v1/sessions/open", json={"path": p})
        assert (r.status_code == 200) is ok, r.get_json()
        if not ok:
            assert "newer version" in r.get_json()["detail"]
    for bad in [{"path": "relative.ripper"}, {"path": str(tmp_path / "nope.ripper")}, {"path": str(tmp_path / "a.wav")}]:
        assert client.post("/api/v1/sessions/open", json=bad).status_code in (400, 404)
    junk = tmp_path / "junk.ripper"
    junk.write_bytes(b"not a zip")
    assert client.post("/api/v1/sessions/open", json={"path": str(junk)}).status_code == 400


def test_pinned_tracks_survive_the_cleanup(ready_track, tmp_path):
    client, tid = ready_track
    lib = client.application.extensions["ripper"].library
    scratch = lib.create(title="scratch", source="upload", status="ready")
    lib.update(scratch["id"], created=time.time() - 3 * 86400)
    lib.update(tid, pinned=True, created=time.time() - 3 * 86400)  # old too, but saved
    lib.track_dir(scratch["id"]).mkdir(parents=True, exist_ok=True)
    lib.purge(24 * 3600)
    assert lib.get(scratch["id"]) is None
    assert lib.get(tid) is not None
