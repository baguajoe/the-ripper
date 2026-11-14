"""v1.1.1: crash isolation, heartbeats, retry, thread caps, user paths, video drop-in."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from engine import runtime, workers
from engine.services import media
from engine.tests import fixtures
from engine.tests.conftest import make_client, upload, wait_job

ROOT = Path(__file__).resolve().parents[2]


# --- thread caps -----------------------------------------------------------------------------
def test_thread_cap_math():
    assert runtime.thread_cap(24) == 8
    assert runtime.thread_cap(4) == 4
    assert runtime.thread_cap(1) == 1
    env = {"OMP_NUM_THREADS": "24", "OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "junk"}
    out = runtime.cap_threads(env, cpus=24)
    assert out["OMP_NUM_THREADS"] == "8"          # too high -> capped
    assert out["OPENBLAS_NUM_THREADS"] == "2"     # already lower -> kept
    assert out["MKL_NUM_THREADS"] == "8"
    for var in ("NUMBA_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        assert env[var] == "8"


def test_thread_cap_applied_before_numpy_on_24_cores(tmp_path):
    """A fresh engine process on a simulated 24-core machine with 24-thread settings in the
    environment ends up with every pool at 8 - before numpy/numba are imported."""
    code = ("import sys, json, os; import engine; "
            "assert 'numpy' not in sys.modules; "
            "import numba, numpy; "
            "print(json.dumps({k: os.environ.get(k) for k in "
            "('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMBA_NUM_THREADS',"
            "'VECLIB_MAXIMUM_THREADS')} | {'numba': numba.config.NUMBA_NUM_THREADS, "
            "'cache': os.environ.get('NUMBA_CACHE_DIR')}))")
    env = {**os.environ, "RIPPER_TEST_CPU_COUNT": "24", "RIPPER_APP_DATA": str(tmp_path / "J. Tëst app"),
           **{v: "24" for v in runtime.THREAD_VARS}}
    env.pop("NUMBA_CACHE_DIR", None)
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True,
                         text=True, check=True).stdout
    got = json.loads(out)
    assert got.pop("numba") == 8
    assert Path(got.pop("cache")) == tmp_path / "J. Tëst app" / "numba-cache"
    assert set(got.values()) == {"8"}, got


# --- worker isolation ------------------------------------------------------------------------
def test_describe_exit():
    assert "access violation" in workers.describe_exit(3221225477)   # 0xC0000005 (Windows)
    assert "access violation" in workers.describe_exit(-1073741819)  # same, signed
    assert "SIGSEGV" in workers.describe_exit(-11)


@pytest.fixture()
def crash_file(tmp_path, monkeypatch):
    f = tmp_path / "crash-next"
    monkeypatch.setenv("RIPPER_TEST_CRASH_FILE", str(f))
    monkeypatch.setenv("RIPPER_LOG_DIR", str(tmp_path / "logs"))
    workers.shutdown_all()  # workers inherit the env when spawned
    yield f
    workers.shutdown_all()


def test_native_crash_fails_only_the_job_and_retry_works(tmp_path, fx, crash_file):
    app, c = make_client(tmp_path)
    crash_file.write_text("import_file", encoding="utf-8")
    ids = upload(c, fx["wav120"])
    t0 = time.time()
    job = wait_job(c, ids["job_id"], timeout=60)
    assert time.time() - t0 < 30
    assert job["status"] == "error" and job["crashed"] is True
    assert "crashed" in job["error"] and "Retry" in job["error"]
    track = c.get(f"/api/v1/tracks/{ids['track_id']}").get_json()
    assert track["status"] == "error" and track["crashed"] is True
    # the engine is fine: other requests work
    assert c.get("/api/v1/health").get_json()["ok"] is True
    assert c.get("/api/v1/tracks").status_code == 200
    # faulthandler left a stack trace for the crashed worker
    log = (tmp_path / "logs" / runtime.CRASH_LOG_NAME).read_text(encoding="utf-8")
    assert "Fatal Python error" in log or "Windows fatal exception" in log
    assert "_crash_hook" in log
    # Retry re-runs the import in the safe pool and succeeds
    r = c.post(f"/api/v1/tracks/{ids['track_id']}/retry")
    assert r.status_code == 202, r.get_json()
    job = wait_job(c, r.get_json()["job_id"])
    assert job["status"] == "done", job
    t = c.get(f"/api/v1/tracks/{ids['track_id']}").get_json()
    assert t["status"] == "ready" and abs(t["analysis"]["bpm"] - 120) <= 1 and t["error"] is None


def test_killed_worker_fails_job_within_10s(tmp_path, fx):
    app, c = make_client(tmp_path)
    ids = upload(c, fixtures.DEFAULT_DIR / "song_126.wav")
    pool = workers.pool("jobs")
    end = time.time() + 30
    while not pool.busy_pids() and time.time() < end:
        time.sleep(0.05)
    pid = pool.busy_pids()[0]
    killed = time.time()
    os.kill(pid, 9)
    job = wait_job(c, ids["job_id"], timeout=30)
    assert job["status"] == "error" and job["crashed"] is True
    assert time.time() - killed < 10
    # the pool replaces the worker: the next import works
    ok = wait_job(c, upload(c, fx["wav120"])["job_id"])
    assert ok["status"] == "done"


def test_export_crash_is_a_clean_500(tmp_path, ready_track, crash_file):
    c, tid = ready_track
    crash_file.write_text("build_files", encoding="utf-8")
    body = {"kind": "slice", "slices": [{"start": 0, "end": 1}], "dest_dir": str(tmp_path)}
    r = c.post(f"/api/v1/tracks/{tid}/render", json=body)
    assert r.status_code == 500 and r.get_json()["error"] == "worker_crashed"
    r = c.post(f"/api/v1/tracks/{tid}/render", json=body)
    assert r.status_code == 200 and len(r.get_json()["files"]) == 1


def test_job_heartbeat_is_reported(tmp_path, fx):
    app, c = make_client(tmp_path)
    ids = upload(c, fixtures.DEFAULT_DIR / "song_126.wav")
    seen = []
    end = time.time() + 120
    while time.time() < end:
        j = c.get(f"/api/v1/jobs/{ids['job_id']}").get_json()
        seen.append(j["heartbeat_age"])
        if j["status"] in ("done", "error"):
            break
        time.sleep(0.5)
    assert j["status"] == "done"
    assert max(seen) < 10  # the worker kept beating while it worked


# --- 4-minute song: speed + accuracy ---------------------------------------------------------
def test_four_minute_song_under_60s(tmp_path):
    app, c = make_client(tmp_path)
    t0 = time.time()
    ids = upload(c, fixtures.DEFAULT_DIR / "song_126.wav")
    job = wait_job(c, ids["job_id"], timeout=120)
    took = time.time() - t0
    assert job["status"] == "done", job
    assert took < 60, took
    a = c.get(f"/api/v1/tracks/{ids['track_id']}").get_json()["analysis"]
    assert abs(a["bpm"] - fixtures.SONG_BPM) <= 1 and a["key"] == fixtures.SONG_KEY, (a["bpm"], a["key"])


# --- user folders with spaces, periods and non-ASCII -----------------------------------------
@pytest.mark.parametrize("folder", ["J. Test", "J. Gallop.v2", "Jösé Ünïcødé", "ユーザー 名"])
def test_paths_with_spaces_periods_non_ascii(tmp_path, fx, folder):
    home = tmp_path / folder
    src_dir = home / "Music. Stuff"
    src_dir.mkdir(parents=True)
    src = src_dir / "my sóng. v2.mp3"
    shutil.copy(fx["mp3"], src)
    assert media.inspect(src)["has_audio"]
    out = home / "out. wav" / "x.wav"
    out.parent.mkdir()
    media.convert_to_wav(src, out)
    assert out.exists() and out.stat().st_size > 1000
    app, c = make_client(home / "AppData. Roaming")
    ids = upload(c, src)
    job = wait_job(c, ids["job_id"])
    assert job["status"] == "done", job
    t = c.get(f"/api/v1/tracks/{ids['track_id']}").get_json()
    assert t["title"] == "my sóng. v2"
    dest = home / "Exports. Ünï"
    dest.mkdir()
    r = c.post(f"/api/v1/tracks/{ids['track_id']}/render",
               json={"kind": "slice", "slices": [{"start": 0, "end": 2}], "dest_dir": str(dest)})
    assert r.status_code == 200, r.get_json()
    assert Path(r.get_json()["files"][0]).exists()


# --- video drop-in ---------------------------------------------------------------------------
needs_ffmpeg = pytest.mark.skipif(not media.check_ffmpeg(), reason="ffmpeg not available")


@needs_ffmpeg
def test_video_extraction(tmp_path, fx):
    mp4 = fixtures.DEFAULT_DIR / "song_126.mp4"
    info = media.inspect(mp4)
    assert info["has_audio"] and info["has_video"]
    wav = tmp_path / "a b. c" / "x.wav"
    wav.parent.mkdir()
    media.extract_audio(mp4, wav)
    import soundfile as sf
    i = sf.info(str(wav))
    assert i.samplerate == 44100 and i.channels == 2 and abs(i.frames / 44100 - 240) < 0.5


@needs_ffmpeg
def test_video_import(tmp_path):
    app, c = make_client(tmp_path)
    ids = upload(c, fixtures.DEFAULT_DIR / "song_126.mp4")
    job = wait_job(c, ids["job_id"], timeout=120)
    assert job["status"] == "done", job
    t = c.get(f"/api/v1/tracks/{ids['track_id']}").get_json()
    assert t["from_video"] is True and t["title"] == "song_126"
    assert abs(t["analysis"]["bpm"] - fixtures.SONG_BPM) <= 1 and t["analysis"]["key"] == fixtures.SONG_KEY
    files = sorted(p.name for p in (tmp_path / "storage" / ids["track_id"]).iterdir())
    assert files == ["meta.json", "source.wav"]  # the video itself is not kept


@needs_ffmpeg
def test_video_without_audio_is_rejected(tmp_path):
    app, c = make_client(tmp_path)
    with pytest.raises(Exception):
        media.extract_audio(fixtures.DEFAULT_DIR / "video_noaudio.mp4", tmp_path / "x.wav")
    p = fixtures.DEFAULT_DIR / "video_noaudio.mp4"
    with open(p, "rb") as fh:
        r = c.post("/api/v1/tracks/upload", data={"file": (fh, "clip.mp4")}, content_type="multipart/form-data")
    assert r.status_code == 400 and r.get_json()["error"] == "no_audio"
    assert "no audio track" in r.get_json()["detail"]
    assert c.get("/api/v1/tracks").get_json()["tracks"] == []


def test_unsupported_and_size_limits(tmp_path, fx):
    app, c = make_client(tmp_path)
    with open(fx["txt"], "rb") as fh:
        r = c.post("/api/v1/tracks/upload", data={"file": (fh, "notes.txt")}, content_type="multipart/form-data")
    assert r.status_code == 400 and r.get_json()["error"] == "unsupported_type"
    from engine import config
    assert config.max_bytes_for(".mp4") == 500 * 1024 * 1024
    assert config.max_bytes_for(".MOV") == 500 * 1024 * 1024
    assert config.max_bytes_for(".wav") == 200 * 1024 * 1024
    h = c.get("/api/v1/health").get_json()
    assert h["max_video_mb"] == 500 and h["max_upload_mb"] == 200
    assert set(h["video_extensions"]) == {".mp4", ".mov", ".m4v", ".webm", ".mkv"}


def test_cors_private_network_preflight(tmp_path):
    app, c = make_client(tmp_path)
    r = c.options("/api/v1/tracks", headers={
        "Origin": "ripper://app", "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-ripper-token",
        "Access-Control-Request-Private-Network": "true"})
    assert r.headers.get("Access-Control-Allow-Origin") == "ripper://app"
    assert r.headers.get("Access-Control-Allow-Private-Network") == "true"
    assert "x-ripper-token" in r.headers.get("Access-Control-Allow-Headers", "").lower()
    assert int(r.headers.get("Access-Control-Max-Age", 0)) >= 600
    # errors carry CORS headers too, so the UI sees the real message instead of "Failed to fetch"
    r = c.get("/api/v1/tracks/nope", headers={"Origin": "ripper://app"})
    assert r.status_code == 404 and r.headers.get("Access-Control-Allow-Origin") == "ripper://app"


def test_http_process_never_imports_librosa(tmp_path):
    """Analysis libraries load only in workers; the HTTP process stays lean."""
    code = ("import sys, json; from engine.app import create_app; "
            "from engine.routes import tracks, export, jobs; "
            "print(json.dumps([m for m in ('librosa', 'numba', 'torch') if m in sys.modules]))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True,
                         check=True, env={**os.environ, "RIPPER_APP_DATA": str(tmp_path)}).stdout
    assert json.loads(out) == []
