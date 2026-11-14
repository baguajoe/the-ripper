"""Background jobs: an in-memory registry in the Flask process; the work itself runs in a
crash-isolated worker process (see workers.py)."""
from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, Callable

log = logging.getLogger("ripper.jobs")


class JobError(Exception):
    """An expected failure whose message is safe to show to the user."""


CRASH_MESSAGE = {
    "import": "Analysis crashed in the audio engine ({why}). Nothing else was affected - click Retry.",
    "stems": "Stem separation crashed in the audio engine ({why}). Nothing else was affected - try again.",
}


def crash_message(kind: str, why: str) -> str:
    return CRASH_MESSAGE.get(kind, "The job crashed in the audio engine ({why}). Try again.").format(why=why)


class JobRegistry:
    def __init__(self, workers: int = 2):
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._closed = False

    def submit(self, kind: str, target: str, *args: Any, meta: dict | None = None,
               on_update: Callable[[dict], None] | None = None,
               on_done: Callable[[Any], None] | None = None,
               on_error: Callable[[str, bool], None] | None = None,
               pool_name: str = "jobs") -> str:
        """Run `target` ("module:function") in a worker as fn(ctx, *args).

        on_update(fields)  - the task asked to store fields (runs in the engine process)
        on_done(result)    - after success; its return value replaces the job result
        on_error(msg, crashed) - after failure (msg is user-facing)
        """
        from . import workers

        job_id = uuid.uuid4().hex
        now = time.time()
        job = {"id": job_id, "kind": kind, "status": "queued", "progress": 0.0,
               "message": "Queued", "result": None, "error": None, "crashed": False,
               "created": now, "heartbeat": now, **(meta or {})}
        with self._lock:
            self._jobs[job_id] = job

        def progress(p: float, message: str | None = None) -> None:
            with self._lock:
                job["status"] = "running"
                job["progress"] = max(0.0, min(1.0, float(p)))
                job["heartbeat"] = time.time()
                if message:
                    job["message"] = message

        task = workers.pool(pool_name).submit(target, args, on_progress=progress,
                                              on_update=on_update)
        job["task"] = task

        def waiter() -> None:
            while not task.done.wait(1.0):
                with self._lock:
                    if task.heartbeat > job["heartbeat"]:
                        job["heartbeat"] = task.heartbeat
            err = task.error
            if err is None:
                result = task.result
                try:
                    if on_done:
                        result = on_done(result) or result
                except Exception as exc:  # pragma: no cover
                    log.exception("job %s finaliser failed", job_id)
                    err = workers.TaskFailed(f"Internal error ({type(exc).__name__})", False)
                if err is None:
                    with self._lock:
                        job.update(status="done", progress=1.0, message="Done", result=result,
                                   heartbeat=time.time())
                    return
            crashed = isinstance(err, workers.WorkerCrashed)
            if crashed:
                msg = crash_message(kind, str(err))
            elif isinstance(err, workers.TaskFailed):
                msg = str(err)
            else:  # pragma: no cover
                msg = f"Internal error ({type(err).__name__})"
            with self._lock:
                job.update(status="error", message="Failed", error=msg, crashed=crashed,
                           heartbeat=time.time())
            if on_error:
                try:
                    on_error(msg, crashed)
                except Exception:  # pragma: no cover
                    log.exception("job %s error handler failed", job_id)

        threading.Thread(target=waiter, daemon=True, name=f"ripper-job-{job_id[:6]}").start()
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return {k: v for k, v in job.items() if k != "task"} if job else None

    def public(self, job_id: str) -> dict | None:
        job = self.get(job_id)
        if not job:
            return None
        out = {k: job[k] for k in ("id", "kind", "status", "progress", "message", "result",
                                   "error", "crashed")}
        out["heartbeat_age"] = round(max(0.0, time.time() - job["heartbeat"]), 1)
        return out

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
        self._closed = True
