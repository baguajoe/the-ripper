"""The Ripper engine: Flask app factory + process entrypoint.

    python -m engine [--port 0] [--parent-pid PID]

On start it writes {port, pid, version, api, token} to <app-data>/TheRipper/engine.json.
If a healthy engine of the same version is already running it prints its info and exits 0,
so the desktop app and any plugin instances share one engine.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import secrets
import signal
import sys
import threading
import time
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from . import config, runtime
from .jobs import JobRegistry
from .services import media
from .services.library import Library

log = logging.getLogger("ripper")


class ApiError(Exception):
    def __init__(self, status: int, error: str, detail: str = ""):
        super().__init__(detail or error)
        self.status, self.error, self.detail = status, error, detail


class EngineState:
    def __init__(self, storage: Path, pro_enabled: bool, workers: int):
        self.library = Library(storage)
        self.jobs = JobRegistry(workers)
        self.pro_enabled = pro_enabled
        self.started = time.time()


def create_app(storage_dir: str | Path | None = None, *, pro_enabled: bool | None = None,
               token: str | None = None, testing: bool = False, purge: bool = True) -> Flask:
    app = Flask(__name__)
    storage = Path(storage_dir) if storage_dir else config.default_storage_dir()
    app.config.update(
        TESTING=testing,
        MAX_CONTENT_LENGTH=config.MAX_VIDEO_BYTES + 1024 * 1024,  # + multipart overhead
        RIPPER_TOKEN=token,
        RIPPER_STORAGE=str(storage),
    )
    state = EngineState(storage, config.PRO_ENABLED if pro_enabled is None else pro_enabled,
                        config.JOB_WORKERS)
    app.extensions["ripper"] = state

    origins = list(config.APP_ORIGINS) + (config.DEV_ORIGINS if config.DEV_MODE else [])
    # max_age: cache preflights for 10 min instead of Chromium's 5 s default (one OPTIONS per
    # route, not one per poll). allow_private_network: answer Chromium's Private Network
    # Access preflight (Access-Control-Request-Private-Network) with "true" instead of
    # flask-cors' default "false", which would block every request from the app's page.
    CORS(app, resources={r"/api/*": {"origins": origins}},
         allow_headers=["Content-Type", "X-Ripper-Token", "Range"],
         max_age=600, allow_private_network=True,
         expose_headers=["Content-Disposition", "Content-Range", "Content-Length",
                         "Accept-Ranges", "X-Ripper-Filename"])

    @app.before_request
    def guard():
        # DNS-rebinding protection: only answer to loopback host names.
        host = (request.host or "").rsplit(":", 1)[0].strip("[]")
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise ApiError(403, "forbidden_host", "The engine only answers on 127.0.0.1")
        if request.method == "OPTIONS" or not request.path.startswith(config.API_PREFIX):
            return None
        if request.path == f"{config.API_PREFIX}/health":
            return None
        expected = app.config.get("RIPPER_TOKEN")
        if expected:
            got = request.headers.get("X-Ripper-Token") or request.args.get("token")
            if not got or not secrets.compare_digest(got, expected):
                raise ApiError(401, "unauthorized", "Missing or invalid engine token")
        return None

    @app.errorhandler(ApiError)
    def on_api_error(exc: ApiError):
        return jsonify(error=exc.error, detail=exc.detail), exc.status

    @app.errorhandler(RequestEntityTooLarge)
    def on_too_large(exc):
        return jsonify(error="file_too_large",
                       detail=f"Max file size is {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB for audio, "
                              f"{config.MAX_VIDEO_BYTES // (1024 * 1024)} MB for video"), 413

    @app.errorhandler(HTTPException)
    def on_http(exc: HTTPException):
        return jsonify(error=(exc.name or "error").lower().replace(" ", "_"),
                       detail=exc.description or ""), exc.code

    @app.errorhandler(Exception)
    def on_exception(exc: Exception):
        log.exception("unhandled error on %s %s", request.method, request.path)
        return jsonify(error="internal_error", detail="Something went wrong in the engine"), 500

    from .routes import export as export_routes
    from .routes import jobs as job_routes
    from .routes import tracks as track_routes

    app.register_blueprint(track_routes.bp, url_prefix=config.API_PREFIX)
    app.register_blueprint(job_routes.bp, url_prefix=config.API_PREFIX)
    app.register_blueprint(export_routes.bp, url_prefix=config.API_PREFIX)

    if purge:
        state.library.purge(config.PURGE_AGE_SECONDS)
        if not testing:
            def purger():
                while True:
                    time.sleep(config.PURGE_INTERVAL_SECONDS)
                    try:
                        state.library.purge(config.PURGE_AGE_SECONDS)
                    except Exception:  # pragma: no cover
                        log.exception("purge failed")
            threading.Thread(target=purger, daemon=True, name="ripper-purge").start()
    return app


def state_of(app: Flask) -> EngineState:
    return app.extensions["ripper"]


# --- process entrypoint ----------------------------------------------------------------------
def engine_json_path() -> Path:
    return config.app_data_dir() / "engine.json"


def read_engine_json() -> dict | None:
    try:
        return json.loads(engine_json_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def healthy(info: dict, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{int(info['port'])}{config.API_PREFIX}/health",
                                    timeout=timeout) as r:
            body = json.loads(r.read())
            return bool(body.get("ok")) and body.get("version") == info.get("version")
    except Exception:
        return False


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform.startswith("win"):
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFO
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stage(text: str) -> None:
    """Start-up progress for the desktop app's splash screen."""
    print(f"RIPPER_ENGINE_STAGE {text}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ripper-engine")
    parser.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    parser.add_argument("--parent-pid", type=int, default=0,
                        help="exit when this process dies (desktop app / plugin host)")
    parser.add_argument("--new", action="store_true", help="don't reuse a running engine")
    parser.add_argument("--no-engine-json", action="store_true", help="don't write engine.json")
    parser.add_argument("--analyze", metavar="FILE", help="analyze one file, print JSON, exit")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="[engine] %(levelname)s %(message)s",
                        stream=sys.stderr)
    crash_log = runtime.enable_crash_log("engine")
    log.info("crash traces -> %s; threads capped at %s (cpus %s); numba cache %s",
             crash_log, runtime.thread_cap(), runtime.cpu_count(), os.environ.get("NUMBA_CACHE_DIR"))
    if args.analyze:  # diagnostics: python -m engine --analyze FILE (runs in a worker)
        from . import workers
        t0 = time.time()
        try:
            res = workers.pool("jobs").run("engine.services.pipeline:analyze_path",
                                           (str(Path(args.analyze).resolve()),), timeout=600)
            print(json.dumps({**res, "secs": round(time.time() - t0, 1)}), flush=True)
            return 0
        except Exception as exc:
            print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}), flush=True)
            return 1
        finally:
            workers.shutdown_all()

    stage("Checking audio tools")
    from .services import tools
    for name in ("ffmpeg", "ffprobe"):
        t = tools.find(name)
        log.info("%s: %s", name, f"{t.path} ({t.source})" if t else "NOT FOUND")
    if not media.check_ffmpeg():
        print(media.FFMPEG_INSTALL_HINT, file=sys.stderr, flush=True)
        print("RIPPER_ENGINE_ERROR " + json.dumps({"error": "ffmpeg_missing",
                                                   "detail": media.FFMPEG_INSTALL_HINT}), flush=True)
        return 3

    if not args.new:
        existing = read_engine_json()
        if existing and existing.get("version") == config.ENGINE_VERSION \
                and _pid_alive(int(existing.get("pid", 0))) and healthy(existing):
            print("RIPPER_ENGINE_READY " + json.dumps({**existing, "reused": True}), flush=True)
            return 0

    def log_js_runtime():
        js = tools.js_runtime()
        log.info("js runtime (link import): %s",
                 f"{js.name} {js.version} at {js.path} ({js.source})" if js else
                 "NOT FOUND - link import will only work for sites that don't need one")
    threading.Thread(target=log_js_runtime, daemon=True, name="ripper-jsprobe").start()

    stage("Loading the audio engine")
    token = os.environ.get("RIPPER_TOKEN") or secrets.token_urlsafe(24)
    app = create_app(token=token)
    stage("Starting the server")

    from werkzeug.serving import make_server
    server = make_server("127.0.0.1", args.port, app, threaded=True)
    port = server.server_port
    info = {"port": port, "pid": os.getpid(), "version": config.ENGINE_VERSION,
            "api": config.API_VERSION, "token": token}
    if not args.no_engine_json:
        p = engine_json_path()
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(info), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        tmp.replace(p)

    stop = threading.Event()

    def shutdown(*_):
        if not stop.is_set():
            stop.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    app.extensions["ripper_shutdown"] = shutdown
    for sig in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGBREAK", None)):
        if sig is not None:
            try:
                signal.signal(sig, shutdown)
            except (ValueError, OSError):
                pass

    if args.parent_pid:
        def watchdog():
            while not stop.is_set():
                if not _pid_alive(args.parent_pid):
                    log.info("parent %s exited; shutting down", args.parent_pid)
                    shutdown()
                    return
                time.sleep(2)
        threading.Thread(target=watchdog, daemon=True, name="ripper-watchdog").start()

    from . import workers
    from .services import separator_ai
    workers.pool("jobs").warm()   # spawn a job worker + import librosa now, not on first drop
    separator_ai.probe_nowait()   # torch/demucs check, in a throw-away worker
    print("RIPPER_ENGINE_READY " + json.dumps({**info, "reused": False}), flush=True)
    log.info("listening on http://127.0.0.1:%d (storage %s)", port, app.config["RIPPER_STORAGE"])
    try:
        server.serve_forever()
    finally:
        state_of(app).jobs.shutdown()
        workers.shutdown_all()
        current = read_engine_json()
        if current and current.get("pid") == os.getpid():
            engine_json_path().unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
