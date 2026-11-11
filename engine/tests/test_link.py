"""Link import through yt-dlp. Skips (not fails) when the network blocks it."""
import os
import socket
from pathlib import Path

import pytest

from engine.jobs import JobError
from engine.services import downloader
from engine.tests.conftest import client  # noqa: F401  (fixture)

# Override with RIPPER_TEST_URL. Default: a tiny public MP3 on GitHub (yt-dlp's generic
# extractor). YouTube often blocks CI / datacenter IPs, so it isn't the default.
TEST_URL = os.environ.get(
    "RIPPER_TEST_URL",
    "https://github.com/anars/blank-audio/raw/master/1-second-of-silence.mp3",
)
BLOCKED = ("403", "429", "blocked", "unable to download", "timed out", "connection", "proxy",
           "ssl", "resolve", "unavailable", "sign in", "bot")


def _online(host: str) -> bool:
    try:
        socket.create_connection((host, 443), timeout=5).close()
        return True
    except OSError:
        return False


def test_validate_url():
    assert downloader.validate_url("https://example.com/a")
    assert not downloader.validate_url("ftp://example.com/a")
    assert not downloader.validate_url("http://localhost:5000/")
    assert not downloader.validate_url("javascript:alert(1)")


def test_link_download(tmp_path: Path):
    from urllib.parse import urlparse
    host = urlparse(TEST_URL).hostname
    if not _online(host):
        pytest.skip(f"network unavailable: cannot reach {host}")
    seen = []
    try:
        f, title = downloader.download(TEST_URL, tmp_path, lambda p, m: seen.append(p))
    except JobError as exc:
        msg = str(exc).lower()
        if any(s in msg for s in BLOCKED):
            pytest.skip(f"network blocked the download: {exc}")
        raise
    assert f.exists() and f.stat().st_size > 1000
    assert title
    from engine.services import media
    assert media.probe(f) is not None


def test_link_import_api(client):
    from urllib.parse import urlparse
    from engine.tests.conftest import wait_job
    host = urlparse(TEST_URL).hostname
    if not _online(host):
        pytest.skip(f"network unavailable: cannot reach {host}")
    r = client.post("/api/v1/tracks/link", json={"url": TEST_URL})
    assert r.status_code == 202
    job = wait_job(client, r.get_json()["job_id"])
    if job["status"] == "error" and any(s in (job["error"] or "").lower() for s in BLOCKED):
        pytest.skip(f"network blocked the download: {job['error']}")
    assert job["status"] == "done", job
    t = client.get(f"/api/v1/tracks/{r.get_json()['track_id']}").get_json()
    assert t["status"] == "ready" and t["source"] == "link" and t["duration"] > 0.5
