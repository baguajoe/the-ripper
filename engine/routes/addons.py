"""The HQ (AI) add-on: status, one-click install (a background job) and removal."""
from __future__ import annotations

import threading

from flask import Blueprint, jsonify

from ..app import ApiError
from ..services import addon, separator_ai
from .common import body, state

bp = Blueprint("addons", __name__)

_lock = threading.Lock()
_install_job: dict = {"id": None}


def _active_job() -> dict | None:
    jid = _install_job["id"]
    job = state().jobs.public(jid) if jid else None
    return job if job and job["status"] in ("queued", "running") else job


@bp.get("/addons/ai")
def ai_status():
    out = addon.status()
    job = _active_job()
    out["job"] = job
    probe = separator_ai.probe_nowait()
    out["engine"] = probe  # None while checking
    return jsonify(out)


@bp.post("/addons/ai/install")
def ai_install():
    data = body()
    variant, reason = addon.detect_variant()
    if not variant:
        raise ApiError(409, "unsupported", reason or "HQ (AI) stems aren't available on this computer")
    st = state()
    with _lock:
        job = _active_job()
        if job and job["status"] in ("queued", "running"):
            return jsonify(job_id=job["id"]), 202

        def on_done(info: dict) -> dict:
            separator_ai.reset_probe()
            separator_ai.probe_nowait()  # HQ (AI) shows up without a restart
            return info

        # Tests point the install at a local manifest; the app always uses the release's.
        manifest_url = data.get("manifest_url") if _testing() else None
        job_id = st.jobs.submit("addon", "engine.services.pipeline:install_ai_addon", manifest_url,
                                on_done=on_done, pool_name="addon")
        _install_job["id"] = job_id
    return jsonify(job_id=job_id), 202


def _testing() -> bool:
    from flask import current_app
    return bool(current_app.config.get("TESTING"))


@bp.delete("/addons/ai")
def ai_remove():
    job = _active_job()
    if job and job["status"] in ("queued", "running"):
        raise ApiError(409, "busy", "The add-on is still downloading")
    try:
        addon.remove()
    except Exception as exc:  # JobError carries a user-facing message
        raise ApiError(409, "in_use", str(exc))
    finally:
        separator_ai.reset_probe()
        separator_ai.probe_nowait()
    return jsonify(ok=True, status=addon.status(include_manifest=False))
