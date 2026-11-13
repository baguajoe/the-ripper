"""The ffmpeg / ffprobe / JS-runtime resolver (engine/services/tools.py).

Order under test: explicit override → bundled copy → PATH → clear error.
"""
import os
import stat
import sys
from pathlib import Path

import pytest

from engine.services import downloader, media, tools

EXE = ".exe" if sys.platform.startswith("win") else ""


def _fake_exe(folder: Path, name: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / (name + EXE)
    p.write_text("#!/bin/sh\necho fake\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return p


@pytest.fixture()
def dirs(tmp_path, monkeypatch):
    """A bundled dir and a PATH dir, with no overrides, real PATH or repo vendor dir."""
    for var in ("RIPPER_FFMPEG", "RIPPER_FFPROBE", "RIPPER_DENO", "RIPPER_BIN_DIR"):
        monkeypatch.delenv(var, raising=False)
    bundled, on_path = tmp_path / "bundled", tmp_path / "path"
    bundled.mkdir()
    on_path.mkdir()
    monkeypatch.setenv("PATH", str(on_path))
    monkeypatch.setattr(tools, "_vendor_dir", lambda name: tmp_path / "no-vendor")
    monkeypatch.setenv("RIPPER_BIN_DIR", str(bundled))
    tools.js_runtime.cache_clear()
    yield bundled, on_path
    tools.js_runtime.cache_clear()


@pytest.mark.parametrize("name", ["ffmpeg", "ffprobe", "deno"])
def test_bundled_copy_wins_over_path(dirs, name):
    bundled, on_path = dirs
    b = _fake_exe(bundled, name)
    _fake_exe(on_path, name)
    t = tools.find(name)
    assert t.source == "bundled" and Path(t.path) == b


@pytest.mark.parametrize("name", ["ffmpeg", "ffprobe", "deno"])
def test_falls_back_to_path_when_bundle_missing(dirs, name):
    _, on_path = dirs
    p = _fake_exe(on_path, name)
    t = tools.find(name)
    assert t.source == "path" and Path(t.path).resolve() == p.resolve()


@pytest.mark.parametrize("name", ["ffmpeg", "ffprobe", "deno"])
def test_both_missing_is_a_clear_error(dirs, name):
    assert tools.find(name) is None
    with pytest.raises(tools.ToolMissing, match=f"{name} was not found"):
        tools.require(name)


def test_env_override_beats_bundle(dirs, tmp_path, monkeypatch):
    bundled, _ = dirs
    _fake_exe(bundled, "ffmpeg")
    custom = _fake_exe(tmp_path / "custom", "ffmpeg")
    monkeypatch.setenv("RIPPER_FFMPEG", str(custom))
    assert tools.find("ffmpeg") == tools.Tool("ffmpeg", str(custom), "env")


def test_bogus_env_override_is_ignored(dirs, monkeypatch):
    bundled, _ = dirs
    b = _fake_exe(bundled, "ffmpeg")
    monkeypatch.setenv("RIPPER_FFMPEG", str(bundled / "nope"))
    assert tools.find("ffmpeg").path == str(b)


@pytest.mark.skipif(sys.platform.startswith("win"), reason="no exec bit on Windows")
def test_non_executable_bundled_copy_is_skipped(dirs):
    bundled, on_path = dirs
    b = _fake_exe(bundled, "ffmpeg")
    b.chmod(0o644)
    p = _fake_exe(on_path, "ffmpeg")
    assert Path(tools.find("ffmpeg").path).resolve() == p.resolve()


def test_media_uses_resolved_paths_and_reports_missing(dirs):
    bundled, _ = dirs
    assert not media.check_ffmpeg()
    assert media.ffmpeg_location() is None
    ff, fp = _fake_exe(bundled, "ffmpeg"), _fake_exe(bundled, "ffprobe")
    assert media.ffmpeg_bin() == str(ff) and media.ffprobe_bin() == str(fp)
    assert media.check_ffmpeg()
    assert media.ffmpeg_location() == str(bundled)  # yt-dlp --ffmpeg-location


def test_ffmpeg_location_when_split_across_folders(dirs):
    bundled, on_path = dirs
    ff = _fake_exe(bundled, "ffmpeg")
    _fake_exe(on_path, "ffprobe")
    assert media.ffmpeg_location() == str(ff)


# --- JS runtime -------------------------------------------------------------------------
def _versions(table):
    return lambda path, pattern: table.get(Path(path).stem)


def test_js_runtime_prefers_bundled_deno(dirs):
    bundled, on_path = dirs
    _fake_exe(bundled, "deno")
    _fake_exe(on_path, "node")
    js = tools.find_js_runtime(check_version=_versions({"deno": (2, 9, 8), "node": (24, 0, 0)}))
    assert (js.name, js.source, js.version) == ("deno", "bundled", "2.9.8")
    assert js.ytdlp_option() == {"deno": {"path": js.path}}


def test_js_runtime_falls_back_to_system_deno_then_node(dirs):
    _, on_path = dirs
    _fake_exe(on_path, "node")
    js = tools.find_js_runtime(check_version=_versions({"node": (22, 1, 0)}))
    assert (js.name, js.source) == ("node", "path")
    _fake_exe(on_path, "deno")
    js = tools.find_js_runtime(check_version=_versions({"deno": (2, 5, 0), "node": (22, 1, 0)}))
    assert (js.name, js.source) == ("deno", "path")


def test_js_runtime_skips_too_old_or_broken(dirs):
    bundled, on_path = dirs
    _fake_exe(bundled, "deno")  # won't run (version None)
    _fake_exe(on_path, "node")  # too old for yt-dlp
    assert tools.find_js_runtime(check_version=_versions({"node": (18, 0, 0)})) is None


def test_no_js_runtime_gives_clear_link_error(dirs, monkeypatch, tmp_path):
    """Without any runtime, a JS-related yt-dlp failure becomes a friendly message."""
    import yt_dlp

    class Boom:
        def __init__(self, opts):
            assert opts["js_runtimes"] == {}
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def extract_info(self, *a, **k):
            raise RuntimeError("ERROR: No supported JavaScript runtime could be found")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", Boom)
    with pytest.raises(downloader.JobError, match="needs a JavaScript runtime"):
        downloader.download("https://example.com/watch", tmp_path, lambda *a: None)


def test_real_js_runtime_if_installed():
    """Smoke-check against whatever this machine really has (skips if nothing)."""
    tools.js_runtime.cache_clear()
    js = tools.js_runtime()
    if js is None:
        pytest.skip("no deno/node >= 22 on this machine")
    assert os.path.exists(js.path) and js.version
