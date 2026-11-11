from __future__ import annotations

from flask import Blueprint, jsonify

from ..app import ApiError
from .common import state

bp = Blueprint("jobs", __name__)


@bp.get("/jobs/<job_id>")
def get_job(job_id: str):
    job = state().jobs.public(job_id)
    if not job:
        raise ApiError(404, "not_found", f"Job {job_id} not found")
    return jsonify(job)
