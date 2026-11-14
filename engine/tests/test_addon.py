"""HQ (AI) add-on installer: manifest, split + resumed + checksummed downloads, unpacking,
self-test, removal. Uses a local HTTP server and a tiny fake runtime (the real one is
installed into the installed app in CI)."""
from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import pytest

from engine import config
from engine.jobs import JobError
from engine.services import addon, separator_ai
from engine.tests.conftest import make_client, wait_job

FAKE_RUNNER = '''import json, sys
if sys.argv[1] == "probe":
    print(json.dumps({"ok": True, "device": "cpu", "torch": "fake", "demucs": "4.1.0", "gpu": None}))
else:
    print(json.dumps({"error": "fake runtime"}))
'''


class Server:
    """Serves bytes by name with HTTP Range support. cut[name] = n: the first request for
    that file stops after n bytes (a dropped connection)."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.cut: dict[str, int] = {}
        self.requests: list[tuple[str, str | None]] = []
        srv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                name = unquote(self.path.lstrip("/"))
                rng = self.headers.get("Range")
                srv.requests.append((name, rng))
                data = srv.files.get(name)
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                start = int(rng.split("=")[1].split("-")[0]) if rng else 0
                body = data[start:]
                self.send_response(206 if rng else 200)
                if rng:
                    self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                n = srv.cut.pop(name, None)
                if n is not None:
                    self.wfile.write(body[:n])
                    self.wfile.flush()
                    self.connection.shutdown(2)
                    return
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}/"

    def close(self):
        self.httpd.shutdown()


@pytest.fixture()
def server():
    s = Server()
    yield s
    s.close()


@pytest.fixture()
def ai_home(tmp_path, monkeypatch):
    monkeypatch.setenv("RIPPER_APP_DATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("RIPPER_AI_VARIANT", "test-cpu")
    monkeypatch.delenv("RIPPER_AI_MODELS_DIR", raising=False)
    monkeypatch.setattr(addon, "RETRIES", 3)
    monkeypatch.setattr(addon.time, "sleep", lambda s: None)
    addon._manifest_cache.clear()
    yield tmp_path / "appdata" / "addons" / "ai"
    addon._manifest_cache.clear()


def make_pack(python: str = sys.executable) -> bytes:
    """A runtime zip: pack.json, the fake runner and an executable helper (mode bits kept)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("pack.json", json.dumps({"format": config.AI_PACK_FORMAT, "variant": "test-cpu",
                                            "python": python, "runner": "ripper_ai.py"}))
        z.writestr("ripper_ai.py", FAKE_RUNNER)
        info = zipfile.ZipInfo("python/bin/tool")
        info.external_attr = (stat.S_IFREG | 0o755) << 16
        z.writestr(info, "#!/bin/sh\necho hi\n")
        z.writestr("python/lib/big.bin", os.urandom(300_000))  # incompressible: splits into parts
    return buf.getvalue()


def publish(server: Server, pack: bytes, parts: int = 2, corrupt: str | None = None) -> str:
    """Put the pack (split into `parts`) and a manifest on the server; returns the manifest URL."""
    size = -(-len(pack) // parts)
    files = []
    for i in range(parts):
        chunk = pack[i * size:(i + 1) * size]
        name = f"ripper-ai-test-cpu.zip.{i + 1:03d}"
        server.files[name] = chunk
        files.append({"name": name, "size": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
    if corrupt:
        server.files[corrupt] = bytes(len(server.files[corrupt]))  # same size, wrong bytes
    manifest = {"format": config.AI_PACK_FORMAT, "app_version": config.ENGINE_VERSION,
                "variants": {"test-cpu": {"files": files, "zip_sha256": hashlib.sha256(pack).hexdigest(),
                                          "unpacked_bytes": 400_000}}}
    server.files["manifest.json"] = json.dumps(manifest).encode()
    return server.base + "manifest.json"


@pytest.fixture()
def fake_weights(server, monkeypatch):
    """Small stand-ins for the Demucs weights, served by the local 'Hugging Face'."""
    weights = {}
    for key in ("htdemucs", "htdemucs_6s"):
        files = {}
        for fname in config.DEMUCS_WEIGHTS[key]["files"]:
            data = os.urandom(1000) if fname.endswith(".safetensors") else b"models: ['x']\n"
            files[fname] = (len(data), hashlib.sha256(data).hexdigest())
            server.files[f"r/{key}/resolve/rev/{fname}"] = data
        weights[key] = {"repo": f"r/{key}", "revision": "rev", "files": files}
    monkeypatch.setattr(config, "DEMUCS_WEIGHTS", weights)
    monkeypatch.setattr(config, "HF_BASE_URL", server.base.rstrip("/"))
    return weights


class Ctx:
    def __init__(self):
        self.events: list[tuple[float, str]] = []

    def progress(self, p, msg=None):
        self.events.append((p, msg))

    def update(self, **_):
        pass


def test_install_resumes_verifies_unpacks_and_removes(server, ai_home, fake_weights, monkeypatch):
    pack = make_pack()
    url = publish(server, pack, parts=2)
    server.cut["ripper-ai-test-cpu.zip.001"] = 50_000  # connection drops mid-download
    monkeypatch.setenv("RIPPER_AI_MANIFEST_URL", url)

    st = addon.status()
    assert st["supported"] and not st["installed"] and st["manifest_error"] is None
    weights = sum(s for k in fake_weights.values() for s, _ in k["files"].values())
    assert st["download_bytes"] == len(pack) + weights      # size shown up front
    assert st["disk_bytes"] == 400_000 + weights

    ctx = Ctx()
    info = addon.install(ctx, url)
    assert info["variant"] == "test-cpu" and info["device"] == "cpu"
    # the dropped part was resumed with a Range request, not downloaded again from 0
    part1 = [r for n, r in server.requests if n == "ripper-ai-test-cpu.zip.001"]
    assert part1 == [None, "bytes=50000-"]
    ps = [p for p, _ in ctx.events]
    assert ps == sorted(ps) and ps[-1] == 1.0                # progress only moves forward
    assert any("MB/s" in (m or "") for _, m in ctx.events)

    rt = ai_home / "runtime"
    assert (rt / "ripper_ai.py").exists() and (rt / "python" / "lib" / "big.bin").stat().st_size == 300_000
    if os.name != "nt":
        assert os.access(rt / "python" / "bin" / "tool", os.X_OK)  # executable bit kept
    assert not (ai_home / "download").exists()                  # partials cleaned up
    for k in fake_weights.values():
        for fname in k["files"]:
            assert (ai_home / "models" / fname).exists()
    assert addon.installed()["variant"] == "test-cpu"
    st = addon.status()
    assert st["installed"] and st["info"]["device"] == "cpu"

    rtinfo = separator_ai.runtime()
    assert rtinfo["kind"] == "addon"
    assert separator_ai.probe()["available"] is True

    addon.remove()
    assert addon.installed() is None
    assert not rt.exists() and not (ai_home / "models").exists()
    assert not addon.status(include_manifest=False)["installed"]


def test_checksum_mismatch_is_reported_and_retried_clean(server, ai_home, fake_weights):
    pack = make_pack()
    url = publish(server, pack, parts=2, corrupt="ripper-ai-test-cpu.zip.002")
    with pytest.raises(JobError, match="checksum"):
        addon.install(Ctx(), url)
    assert addon.installed() is None
    assert not (ai_home / "download" / "ripper-ai-test-cpu.zip.002.partial").exists()
    # the good part is kept (no need to fetch it again); a fixed release installs fine
    assert (ai_home / "download" / "ripper-ai-test-cpu.zip.001").exists()
    url = publish(server, pack, parts=2)
    server.requests.clear()
    assert addon.install(Ctx(), url)["device"] == "cpu"
    assert [n for n, _ in server.requests if n.endswith(".001")] == []


def test_interrupted_download_keeps_the_partial_for_next_time(server, ai_home, fake_weights, monkeypatch):
    pack = make_pack()
    url = publish(server, pack, parts=1)
    name = "ripper-ai-test-cpu.zip.001"
    real = server.files[name]
    server.cut[name] = 100_000
    monkeypatch.setattr(addon, "RETRIES", 1)
    with pytest.raises(JobError, match="resume"):
        addon.install(Ctx(), url)
    partial = ai_home / "download" / f"{name}.partial"
    assert partial.stat().st_size == 100_000
    server.files[name] = real
    server.requests.clear()
    addon.install(Ctx(), url)
    assert server.requests[1] == (name, "bytes=100000-")


def test_broken_runtime_fails_the_self_test_and_installs_nothing(server, ai_home, fake_weights):
    pack = make_pack(python=str(Path(sys.executable).parent / "no-such-python"))
    url = publish(server, pack, parts=1)
    with pytest.raises(JobError, match="did not start|self-test"):
        addon.install(Ctx(), url)
    assert addon.installed() is None and not (ai_home / "runtime").exists()


def test_unsafe_zip_paths_are_refused(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("../evil.txt", "x")
    p = tmp_path / "evil.zip"
    p.write_bytes(buf.getvalue())
    with pytest.raises(JobError, match="unsafe"):
        addon.extract([p], tmp_path / "out", lambda _p: None)
    assert not (tmp_path / "evil.txt").exists()


def test_missing_release_and_offline_are_clear(server, ai_home):
    with pytest.raises(JobError, match="isn't published"):
        addon.fetch_manifest(server.base + "nope.json")
    with pytest.raises(JobError, match="internet"):
        addon.fetch_manifest("http://127.0.0.1:9/manifest.json", timeout=2)


def test_variant_detection(monkeypatch):
    monkeypatch.delenv("RIPPER_AI_VARIANT", raising=False)
    monkeypatch.setattr(addon, "IS_WIN", True)
    monkeypatch.setattr(addon.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(addon, "has_nvidia_gpu", lambda: True)
    assert addon.detect_variant() == ("win-cuda", None)
    monkeypatch.setattr(addon, "has_nvidia_gpu", lambda: False)
    assert addon.detect_variant() == ("win-cpu", None)
    monkeypatch.setattr(addon, "IS_WIN", False)
    monkeypatch.setattr(addon.sys, "platform", "darwin")
    monkeypatch.setattr(addon.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(addon.platform, "mac_ver", lambda: ("15.1", ("", "", ""), "arm64"))
    assert addon.detect_variant() == ("mac-arm64", None)
    monkeypatch.setattr(addon.platform, "mac_ver", lambda: ("13.6.1", ("", "", ""), "arm64"))
    assert addon.detect_variant() == (None, "HQ (AI) stems need macOS 14 (Sonoma) or later")
    monkeypatch.setattr(addon.platform, "mac_ver", lambda: ("15.1", ("", "", ""), "arm64"))
    monkeypatch.setattr(addon.platform, "machine", lambda: "x86_64")
    assert addon.detect_variant()[0] is None


def test_install_api_runs_as_a_job_and_hq_appears(server, ai_home, tmp_path):
    """Through the API (a worker process). Sparse stand-ins of the pinned weights' sizes are put
    in place first: only missing weights are fetched, so nothing goes to Hugging Face."""
    models = ai_home / "models"
    models.mkdir(parents=True)
    for w in config.DEMUCS_WEIGHTS.values():
        for fname, (size, _sha) in w["files"].items():
            with open(models / fname, "wb") as f:
                f.truncate(size)
    url = publish(server, make_pack(), parts=2)
    app, c = make_client(tmp_path / "srv")
    st = c.get("/api/v1/addons/ai").get_json()
    assert st["supported"] and not st["installed"]
    r = c.post("/api/v1/addons/ai/install", json={"manifest_url": url})
    assert r.status_code == 202
    again = c.post("/api/v1/addons/ai/install", json={"manifest_url": url})
    assert again.get_json()["job_id"] == r.get_json()["job_id"]   # one install at a time
    job = wait_job(c, r.get_json()["job_id"], timeout=120)
    assert job["status"] == "done", job
    assert c.get("/api/v1/addons/ai").get_json()["installed"]
    assert separator_ai.probe_remote(60)["available"] is True     # HQ (AI) without a restart
    r = c.delete("/api/v1/addons/ai")
    assert r.status_code == 200 and r.get_json()["status"]["installed"] is False
    separator_ai.reset_probe()
