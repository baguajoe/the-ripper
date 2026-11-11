"""Background job runner: ThreadPoolExecutor + in-memory registry."""
from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

log = logging.getLogger("ripper.jobs")


class JobError(Exception):
    """An expected failure whose message is safe to show to the user."""


class JobRegistry:
    def __init__(self, workers: int = 2):
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ripper-job")
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def submit(self, kind: str, fn: Callable[..., Any], *args: Any, meta: dict | None = None) -> str:
        job_id = uuid.uuid4().hex
        job = {
            "id": job_id,
            "kind": kind,
            "status": "queued",
            "progress": 0.0,
            "message": "Queued",
            "result": None,
            "error": None,
            "created": time.time(),
            **(meta or {}),
        }
        with self._lock:
            self._jobs[job_id] = job

        def progress(p: float, message: str | None = None) -> None:
            with self._lock:
                job["progress"] = max(0.0, min(1.0, float(p)))
                if message:
                    job["message"] = message

        def run() -> None:
            with self._lock:
                job["status"] = "running"
                job["message"] = "Running"
            try:
                result = fn(progress, *args)
                with self._lock:
                    job.update(status="done", progress=1.0, message="Done", result=result)
            except JobError as exc:
                with self._lock:
                    job.update(status="error", message="Failed", error=str(exc))
            except Exception as exc:  # never leak tracebacks to clients
                log.error("job %s (%s) failed:\n%s", job_id, kind, traceback.format_exc())
                with self._lock:
                    job.update(status="error", message="Failed",
                               error=f"Internal error ({type(exc).__name__})")

        self._pool.submit(run)
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def public(self, job_id: str) -> dict | None:
        job = self.get(job_id)
        if not job:
            return None
        return {k: job[k] for k in ("id", "kind", "status", "progress", "message", "result", "error")}

    def wait(self, job_id: str, timeout: float = 120.0) -> dict | None:
        """Block until a job finishes (used by tests / CLI)."""
        end = time.time() + timeout
        while time.time() < end:
            job = self.get(job_id)
            if job and job["status"] in ("done", "error"):
                return job
            time.sleep(0.05)
        return self.get(job_id)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
