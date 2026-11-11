from __future__ import annotations

import time
from pathlib import Path

import pytest

from engine.app import create_app
from engine.services import media
from engine.tests import fixtures


@pytest.fixture(scope="session")
def fx() -> dict[str, Path]:
    return fixtures.generate()


@pytest.fixture(scope="session")
def converted(fx, tmp_path_factory) -> dict[str, Path]:
    """Fixtures converted the same way the engine converts imports."""
    d = tmp_path_factory.mktemp("converted")
    out = {}
    for key in ("wav120", "wav90", "mp3"):
        p = d / f"{key}.wav"
        media.convert_to_wav(fx[key], p)
        out[key] = p
    return out


def make_client(tmp_path: Path, **kw):
    app = create_app(tmp_path / "storage", testing=True, purge=False, **kw)
    return app, app.test_client()


@pytest.fixture()
def client(tmp_path):
    app, c = make_client(tmp_path)
    c.application = app
    return c


def wait_job(client, job_id: str, timeout: float = 180) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        r = client.get(f"/api/v1/jobs/{job_id}")
        assert r.status_code == 200, r.get_json()
        job = r.get_json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} timed out")


def upload(client, path: Path) -> dict:
    with open(path, "rb") as fh:
        r = client.post("/api/v1/tracks/upload", data={"file": (fh, path.name)},
                        content_type="multipart/form-data")
    assert r.status_code == 202, r.get_json()
    return r.get_json()


@pytest.fixture(scope="session")
def ready_track(tmp_path_factory, fx):
    """A shared app with the 120 BPM fixture uploaded and analyzed."""
    tmp = tmp_path_factory.mktemp("shared")
    app, c = make_client(tmp)
    ids = upload(c, fx["wav120"])
    job = wait_job(c, ids["job_id"])
    assert job["status"] == "done", job
    return c, ids["track_id"]
