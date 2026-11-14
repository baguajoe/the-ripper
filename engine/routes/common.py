from __future__ import annotations

from flask import current_app, request

from .. import config
from ..app import ApiError, EngineState


def state() -> EngineState:
    return current_app.extensions["ripper"]


def body() -> dict:
    data = request.get_json(silent=True)
    if data is None:
        if request.data:
            raise ApiError(400, "invalid_json", "Request body must be JSON")
        return {}
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_json", "Request body must be a JSON object")
    return data


def require_track(track_id: str, ready: bool = False) -> dict:
    track = state().library.get(track_id)
    if not track:
        raise ApiError(404, "not_found", f"Track {track_id} not found")
    if ready and track.get("status") != "ready":
        raise ApiError(409, "not_ready", f"Track is {track.get('status')}")
    return track


def require_feature(feature: str) -> None:
    if not config.is_allowed(feature, state().pro_enabled):
        raise ApiError(403, "pro_required", f"'{feature}' is a Pro feature")


def run_quick(target: str, args: tuple, what: str, timeout: float = 600, on_update=None):
    """Run an interactive task (export, render, onsets) in a worker and wait for it.

    A crash in the worker becomes a 500 with a clear message; the engine keeps running."""
    from .. import workers
    try:
        return workers.pool("quick").run(target, args, timeout=timeout, on_update=on_update)
    except workers.WorkerCrashed as exc:
        raise ApiError(500, "worker_crashed",
                       f"{what} crashed in the audio engine ({exc}). Nothing else was affected - try again.")
    except workers.TaskFailed as exc:
        raise ApiError(422 if exc.safe else 500, "task_failed",
                       str(exc) if exc.safe else f"{what} failed ({exc})")
    except TimeoutError:
        raise ApiError(504, "timeout", f"{what} took too long")
