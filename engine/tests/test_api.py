import io
import os
import zipfile

import soundfile as sf

from engine.services import exporter
from engine.tests.conftest import make_client, upload, wait_job


def test_health(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    h = r.get_json()
    assert h["ok"] is True and h["ffmpeg"] is True and h["api"] == "v1"
    assert {"demucs_available", "device", "pro", "features"} <= set(h)


def test_full_flow(client, fx, tmp_path):
    ids = upload(client, fx["wav120"])
    # the track is listed immediately, with status
    lst = client.get("/api/v1/tracks").get_json()["tracks"]
    assert lst[0]["id"] == ids["track_id"] and lst[0]["status"] in ("analyzing", "ready")
    job = wait_job(client, ids["job_id"])
    assert job["status"] == "done", job
    t = client.get(f"/api/v1/tracks/{ids['track_id']}").get_json()
    assert t["status"] == "ready" and abs(t["analysis"]["bpm"] - 120) <= 2
    assert t["analysis"]["key"] in ("Am", "C") and len(t["analysis"]["peaks"]) == 160
    assert abs(t["duration"] - 12.0) < 0.05

    # audio stream + Range
    r = client.get(f"/api/v1/tracks/{ids['track_id']}/audio")
    assert r.status_code == 200 and r.data[:4] == b"RIFF"
    r = client.get(f"/api/v1/tracks/{ids['track_id']}/audio", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.data) == 100
    assert r.headers["Content-Range"].startswith("bytes 0-99/")

    # re-grid
    r = client.patch(f"/api/v1/tracks/{ids['track_id']}", json={"bpm": 60, "downbeat": 0.5})
    assert r.status_code == 200
    a = r.get_json()["analysis"]
    assert a["bpm"] == 60 and a["downbeat"] == 0.5 and a["beats"][0] == 0.5 and len(a["beats"]) == 12
    client.patch(f"/api/v1/tracks/{ids['track_id']}", json={"bpm": 120, "downbeat": 0.0})

    # onsets + slices
    r = client.get(f"/api/v1/tracks/{ids['track_id']}/onsets?sensitivity=0.5")
    assert len(r.get_json()["onsets"]) >= 18
    sl = client.get(f"/api/v1/tracks/{ids['track_id']}/slices?mode=grid&division=1bar").get_json()["slices"]
    assert len(sl) == 6

    # export (no stems -> DSP runs inline)
    r = client.post(f"/api/v1/tracks/{ids['track_id']}/export",
                    json={"slices": sl, "include_midi": True, "include_stems": True})
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.data))
    assert len(z.namelist()) == 6 + 4 + 1

    # render to folder (what drag-to-DAW uses)
    r = client.post(f"/api/v1/tracks/{ids['track_id']}/render",
                    json={"kind": "slice", "slices": [sl[0]], "dest_dir": str(tmp_path)})
    assert r.status_code == 200, r.get_json()
    files = r.get_json()["files"]
    assert len(files) == 1 and os.path.exists(files[0])
    raw = open(files[0], "rb").read()
    assert exporter.read_acid(raw)["bpm"] == 120
    assert sf.info(files[0]).subtype == "PCM_24"
    r = client.post(f"/api/v1/tracks/{ids['track_id']}/render",
                    json={"kind": "kit", "slices": sl, "dest_dir": str(tmp_path / "x")})
    assert r.status_code == 400  # folder must exist
    (tmp_path / "x").mkdir()
    r = client.post(f"/api/v1/tracks/{ids['track_id']}/render",
                    json={"kind": "kit", "slices": sl, "dest_dir": str(tmp_path / "x")})
    assert r.status_code == 200 and len(r.get_json()["files"]) == 11
    r = client.post(f"/api/v1/tracks/{ids['track_id']}/render",
                    json={"kind": "midi", "slices": sl, "dest_dir": str(tmp_path)})
    assert r.get_json()["files"][0].endswith("_slices.mid")

    # delete
    assert client.delete(f"/api/v1/tracks/{ids['track_id']}").status_code == 200
    assert client.get(f"/api/v1/tracks/{ids['track_id']}").status_code == 404


def test_mp3_upload(client, fx):
    ids = upload(client, fx["mp3"])
    job = wait_job(client, ids["job_id"])
    assert job["status"] == "done", job
    a = client.get(f"/api/v1/tracks/{ids['track_id']}").get_json()["analysis"]
    assert abs(a["bpm"] - 120) <= 2 and a["key"] in ("Am", "C")


def test_bad_file_type(client, fx):
    with open(fx["txt"], "rb") as fh:
        r = client.post("/api/v1/tracks/upload", data={"file": (fh, "notes.txt")},
                        content_type="multipart/form-data")
    assert r.status_code == 400 and r.get_json()["error"] == "unsupported_type"
    with open(fx["bad"], "rb") as fh:
        r = client.post("/api/v1/tracks/upload", data={"file": (fh, "fake.wav")},
                        content_type="multipart/form-data")
    assert r.status_code == 400 and r.get_json()["error"] == "invalid_audio"
    r = client.post("/api/v1/tracks/upload", data={}, content_type="multipart/form-data")
    assert r.status_code == 400
    assert client.get("/api/v1/tracks").get_json()["tracks"] == []


def test_missing_track_404(client):
    for method, path in [("get", "/api/v1/tracks/nope"), ("get", "/api/v1/tracks/nope/audio"),
                         ("patch", "/api/v1/tracks/nope"), ("delete", "/api/v1/tracks/nope"),
                         ("post", "/api/v1/tracks/nope/stems"), ("get", "/api/v1/tracks/nope/stems/drums"),
                         ("post", "/api/v1/tracks/nope/export"), ("get", "/api/v1/jobs/nope"),
                         ("get", "/api/v1/nothing-here")]:
        r = getattr(client, method)(path, json={} if method in ("post", "patch") else None)
        assert r.status_code == 404, (method, path)
        body = r.get_json()
        assert set(body) == {"error", "detail"}, body
        assert "Traceback" not in r.get_data(as_text=True)


def test_validation_errors(ready_track):
    client, tid = ready_track
    assert client.patch(f"/api/v1/tracks/{tid}", json={"bpm": "fast"}).status_code == 400
    assert client.patch(f"/api/v1/tracks/{tid}", json={"bpm": 5000}).status_code == 400
    r = client.post(f"/api/v1/tracks/{tid}/export", json={"slices": [{"start": 2, "end": 1}]})
    assert r.status_code == 400 and r.get_json()["error"] == "invalid_slices"
    r = client.post(f"/api/v1/tracks/{tid}/export", json={"slices": [], "sr": 22050})
    assert r.status_code == 400
    r = client.post(f"/api/v1/tracks/{tid}/export", data="not json", content_type="application/json")
    assert r.status_code == 400
    r = client.post("/api/v1/tracks/link", json={"url": "file:///etc/passwd"})
    assert r.status_code == 400
    r = client.post("/api/v1/tracks/link", json={"url": "http://127.0.0.1:5000/x"})
    assert r.status_code == 400


def test_pro_gating(tmp_path, fx):
    app, c = make_client(tmp_path, pro_enabled=False)
    ids = upload(c, fx["wav120"])
    assert wait_job(c, ids["job_id"])["status"] == "done"
    tid = ids["track_id"]
    h = c.get("/api/v1/health").get_json()
    assert h["pro"] is False and h["features"]["stems_ai"] is False and h["features"]["stems_dsp"] is True
    sl = c.get(f"/api/v1/tracks/{tid}/slices?mode=grid&division=1bar").get_json()["slices"]
    r = c.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "ai", "model": "htdemucs"})
    assert r.status_code == 403 and r.get_json()["error"] == "pro_required"
    assert c.post(f"/api/v1/tracks/{tid}/export", json={"slices": sl}).status_code == 403
    assert c.post(f"/api/v1/tracks/{tid}/export", json={"slices": sl[:1], "include_midi": True}).status_code == 403
    r = c.post(f"/api/v1/tracks/{tid}/export", json={"slices": sl[:1], "format": "wav"})
    assert r.status_code == 200  # single slice is free
    assert wait_job(c, c.post(f"/api/v1/tracks/{tid}/stems", json={"engine": "dsp"}).get_json()["job_id"])["status"] == "done"
    r = c.post(f"/api/v1/tracks/{tid}/export", json={"stems": ["drums"], "format": "wav"})
    assert r.status_code == 200  # single stem is free


def test_token_and_host_guard(tmp_path):
    app, c = make_client(tmp_path, token="s3cret")
    assert c.get("/api/v1/health").status_code == 200           # health is open
    assert c.get("/api/v1/tracks").status_code == 401
    assert c.get("/api/v1/tracks", headers={"X-Ripper-Token": "s3cret"}).status_code == 200
    assert c.get("/api/v1/tracks?token=s3cret").status_code == 200
    r = c.get("/api/v1/health", headers={"Host": "evil.example.com"})
    assert r.status_code == 403


def test_cors(tmp_path):
    app, c = make_client(tmp_path)
    r = c.options("/api/v1/tracks", headers={"Origin": "ripper://app", "Access-Control-Request-Method": "GET"})
    assert r.headers.get("Access-Control-Allow-Origin") == "ripper://app"
    r = c.get("/api/v1/health", headers={"Origin": "https://evil.example.com"})
    assert "Access-Control-Allow-Origin" not in r.headers


def test_purge(tmp_path):
    import time
    from engine.services.library import Library
    lib = Library(tmp_path / "s")
    t = lib.create("old", "upload", "ready")
    lib.update(t["id"], created=time.time() - 25 * 3600)
    keep = lib.create("new", "upload", "ready")
    assert lib.purge(24 * 3600) == 1
    assert lib.get(t["id"]) is None and lib.get(keep["id"]) is not None
    assert not (tmp_path / "s" / t["id"]).exists()


def test_restart_marks_interrupted(tmp_path):
    from engine.services.library import Library
    lib = Library(tmp_path / "s")
    t = lib.create("x", "upload", "analyzing")
    lib2 = Library(tmp_path / "s")
    assert lib2.get(t["id"])["status"] == "error"
