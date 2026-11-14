"""Crash-isolated job workers.

Heavy native code (ffmpeg decode, librosa/numba/scipy analysis, stem separation, export)
never runs in the Flask process. It runs in worker *processes*, so a native crash
(an access violation in a numeric library, an out-of-memory kill, ...) fails only the job
that was running in that worker - the engine keeps serving and a new worker is started.

Protocol (multiprocessing Pipe, pickled tuples):
    parent -> worker   ("run", task_id, "module:function", args)  |  ("stop",)
    worker -> parent   ("hello", pid)
                       ("hb", time)                         heartbeat, every HEARTBEAT_S
                       ("progress", task_id, p, message)
                       ("update", task_id, fields)          track fields to store
                       ("done", task_id, result)
                       ("error", task_id, message, safe)    safe = message is user-facing

A task function is called as fn(ctx, *args) where ctx.progress(p, msg) reports progress and
ctx.update(**fields) asks the parent to store fields on the job's track.

The parent detects a dead worker immediately (process sentinel) and a hung one when its
heartbeats stop for HANG_S; either way the task fails within seconds with a clear message.
"""
from __future__ import annotations

import importlib
import logging
import multiprocessing as mp
import os
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from multiprocessing.connection import wait as mp_wait
from typing import Any, Callable

from . import runtime

log = logging.getLogger("ripper.workers")

HEARTBEAT_S = 1.0
# A dead process is noticed at once via its sentinel. Heartbeats catch a worker that is alive
# but stuck: NUMBA/C code can hold the GIL for a few seconds, so allow a margin.
HANG_S = float(os.environ.get("RIPPER_WORKER_HANG_S", "60"))
IDLE_EXIT_S = 15 * 60  # free a worker's memory after 15 min without work (pool keeps >=1 warm)


class WorkerCrashed(Exception):
    """The worker process died (or hung) while running a task."""

    def __init__(self, message: str, exit_code: int | None = None, trace: str = ""):
        super().__init__(message)
        self.exit_code = exit_code
        self.trace = trace


class TaskFailed(Exception):
    """The task raised. `safe` = the message may be shown to the user as-is."""

    def __init__(self, message: str, safe: bool):
        super().__init__(message)
        self.safe = safe


def describe_exit(code: int | None) -> str:
    """Human description of a worker exit code (Windows NTSTATUS / POSIX signal)."""
    if code is None:
        return "stopped responding"
    if code < -255:  # Windows NTSTATUS seen as a negative 32-bit int
        code &= 0xFFFFFFFF
    if code < 0:
        import signal
        try:
            return f"crashed ({signal.Signals(-code).name})"
        except ValueError:
            return f"crashed (signal {-code})"
    u = code & 0xFFFFFFFF
    known = {0xC0000005: "access violation", 0xC00000FD: "stack overflow",
             0xC0000409: "stack buffer overrun", 0xC0000374: "heap corruption",
             0xC000001D: "illegal instruction", 0xC0000017: "out of memory"}
    if u in known:
        return f"crashed (0x{u:08X} {known[u]})"
    if u >= 0xC0000000:
        return f"crashed (0x{u:08X})"
    return f"exited with code {code}"


# --- worker side ---------------------------------------------------------------------------
class _Ctx:
    def __init__(self, send: Callable[[tuple], None], task_id: str):
        self._send, self.task_id = send, task_id

    def progress(self, p: float, message: str | None = None) -> None:
        self._send(("progress", self.task_id, float(p), message))

    def update(self, **fields: Any) -> None:
        self._send(("update", self.task_id, fields))


def _resolve(target: str) -> Callable:
    mod, _, name = target.partition(":")
    return getattr(importlib.import_module(mod), name)


def _crash_hook(target: str) -> None:
    """Test hook: RIPPER_TEST_CRASH_FILE=<file containing a target name substring>.
    The first task whose target matches deletes the file and crashes natively."""
    path = os.environ.get("RIPPER_TEST_CRASH_FILE")
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            want = fh.read().strip()
        if want and want not in target:
            return
        os.remove(path)
    except OSError:
        return
    import ctypes
    ctypes.string_at(0)  # genuine access violation / SIGSEGV


def worker_main(conn, role: str, threads: int | None = None) -> None:
    """Entry point of a worker process (spawned; must be importable).

    threads: override the thread cap (the 'safe' pool uses 1). Applied before any numeric
    library is imported in this process."""
    if threads:
        for var in runtime.THREAD_VARS:
            os.environ[var] = str(threads)
    runtime.configure()
    runtime.enable_crash_log(role)
    logging.basicConfig(level=logging.INFO, format=f"[{role}] %(levelname)s %(message)s")
    lock = threading.Lock()
    stop = threading.Event()

    def send(msg: tuple) -> None:
        with lock:
            conn.send(msg)

    def heartbeat() -> None:
        while not stop.wait(HEARTBEAT_S):
            try:
                send(("hb", time.time()))
            except (OSError, EOFError, BrokenPipeError):
                os._exit(0)  # parent is gone

    send(("hello", os.getpid()))
    threading.Thread(target=heartbeat, daemon=True, name="ripper-hb").start()
    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            break
        if msg[0] == "stop":
            break
        if msg[0] == "warm":
            try:
                from .services import analyzer  # noqa: F401 - imports librosa/numba ahead of the first job
            except Exception:  # pragma: no cover
                log.exception("warm-up import failed")
            continue
        _, task_id, target, args = msg
        try:
            _crash_hook(target)
            result = _resolve(target)(_Ctx(send, task_id), *args)
            send(("done", task_id, result))
        except Exception as exc:
            from .jobs import JobError
            if isinstance(exc, JobError):
                send(("error", task_id, str(exc), True))
            else:
                log.error("task %s failed:\n%s", target, traceback.format_exc())
                send(("error", task_id, f"Internal error ({type(exc).__name__})", False))
    stop.set()


# --- parent side ---------------------------------------------------------------------------
@dataclass
class _Task:
    id: str
    target: str
    args: tuple
    on_progress: Callable[[float, str | None], None]
    on_update: Callable[[dict], None]
    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: BaseException | None = None
    heartbeat: float = field(default_factory=time.time)


class _Worker:
    def __init__(self, pool: "WorkerPool", n: int):
        ctx = mp.get_context("spawn")
        self.parent_conn, child_conn = ctx.Pipe(duplex=True)
        self.proc = ctx.Process(target=worker_main, args=(child_conn, f"{pool.name}-worker-{n}", pool.threads),
                                daemon=True, name=f"ripper-{pool.name}-{n}")
        self.proc.start()
        child_conn.close()
        self.pool = pool
        self.task: _Task | None = None
        self.last_seen = time.time()
        self.idle_since = time.time()
        self.send_lock = threading.Lock()

    @property
    def pid(self) -> int | None:
        return self.proc.pid

    def send(self, msg: tuple) -> None:
        with self.send_lock:
            self.parent_conn.send(msg)

    def kill(self) -> None:
        try:
            self.proc.kill()
        except Exception:  # pragma: no cover
            pass
        self.proc.join(timeout=5)
        try:
            self.parent_conn.close()
        except OSError:
            pass


class WorkerPool:
    """`size` worker processes; tasks are queued FIFO and each runs in exactly one worker."""

    def __init__(self, name: str, size: int, keep_warm: int = 1, threads: int | None = None):
        self.name, self.size, self.keep_warm, self.threads = name, max(1, size), keep_warm, threads
        self._lock = threading.Condition()
        self._queue: list[_Task] = []
        self._workers: list[_Worker] = []
        self._spawned = 0
        self._closed = False
        self.crashes = 0
        self._thread = threading.Thread(target=self._loop, daemon=True, name=f"ripper-pool-{name}")
        self._thread.start()

    # -- public ---------------------------------------------------------------------------
    def warm(self) -> None:
        """Start one worker now and pre-import the analysis libraries in it."""
        with self._lock:
            if not self._workers:
                w = self._spawn()
                try:
                    w.send(("warm",))
                except OSError:
                    pass
            self._lock.notify_all()

    def submit(self, target: str, args: tuple = (), *, on_progress=None, on_update=None) -> _Task:
        task = _Task(uuid.uuid4().hex, target, tuple(args), on_progress or (lambda *_: None),
                     on_update or (lambda _f: None))
        with self._lock:
            if self._closed:
                raise RuntimeError("worker pool is shut down")
            self._queue.append(task)
            self._lock.notify_all()
        return task

    def run(self, target: str, args: tuple = (), timeout: float | None = None, **kw) -> Any:
        """Submit and wait. Raises WorkerCrashed / TaskFailed / TimeoutError."""
        task = self.submit(target, args, **kw)
        if not task.done.wait(timeout):
            raise TimeoutError(f"{target} did not finish in {timeout} s")
        if task.error:
            raise task.error
        return task.result

    def pids(self) -> list[int]:
        with self._lock:
            return [w.pid for w in self._workers if w.pid]

    def busy_pids(self) -> list[int]:
        with self._lock:
            return [w.pid for w in self._workers if w.pid and w.task]

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            workers, self._workers = self._workers, []
            pending, self._queue = self._queue, []
            self._lock.notify_all()
        for t in pending:
            t.error = WorkerCrashed("The engine is shutting down")
            t.done.set()
        for w in workers:
            try:
                w.send(("stop",))
            except OSError:
                pass
        for w in workers:
            w.proc.join(timeout=2)
            if w.proc.is_alive():
                w.kill()

    # -- internals ------------------------------------------------------------------------
    def _spawn(self) -> _Worker:
        self._spawned += 1
        w = _Worker(self, self._spawned)
        self._workers.append(w)
        log.info("%s pool: started worker pid %s", self.name, w.pid)
        return w

    def _dispatch(self) -> None:
        """Hand queued tasks to idle workers (spawning up to `size`). Caller holds the lock."""
        while self._queue:
            idle = next((w for w in self._workers if w.task is None), None)
            if idle is None:
                if len(self._workers) >= self.size:
                    return
                idle = self._spawn()
            task = self._queue.pop(0)
            idle.task = task
            task.heartbeat = time.time()
            try:
                idle.send(("run", task.id, task.target, task.args))
            except OSError as exc:
                self._fail_worker(idle, f"could not start the task ({exc})")

    def _finish(self, w: _Worker, error: BaseException | None = None, result: Any = None) -> None:
        task, w.task = w.task, None
        w.idle_since = time.time()
        if task is None:
            return
        task.result, task.error = result, error
        task.done.set()

    def _fail_worker(self, w: _Worker, why: str | None = None) -> None:
        """The worker died or hung: fail its task, forget it. Caller holds the lock."""
        if w in self._workers:
            self._workers.remove(w)
        if w.proc.is_alive():
            w.kill()
        else:
            w.proc.join(timeout=1)
        code = w.proc.exitcode
        desc = why or describe_exit(code)
        trace = runtime.crash_trace_for(w.pid) if w.pid else ""
        if w.task is not None:
            self.crashes += 1
            log.error("%s pool: worker pid %s %s while running %s%s", self.name, w.pid, desc,
                      w.task.target, f"\n--- crash trace (engine-crash.log) ---\n{trace}" if trace else "")
            self._finish(w, WorkerCrashed(desc, code, trace))
        else:
            log.warning("%s pool: idle worker pid %s %s", self.name, w.pid, desc)

    def _handle(self, w: _Worker, msg: tuple) -> None:
        w.last_seen = time.time()
        kind = msg[0]
        task = w.task
        if kind in ("hb", "hello"):
            if task:
                task.heartbeat = w.last_seen
            return
        if task is None or msg[1] != task.id:
            return
        task.heartbeat = w.last_seen
        if kind == "progress":
            _safe(task.on_progress, msg[2], msg[3])
        elif kind == "update":
            _safe(task.on_update, msg[2])
        elif kind == "done":
            self._finish(w, result=msg[2])
        elif kind == "error":
            self._finish(w, TaskFailed(msg[2], bool(msg[3])))

    def _loop(self) -> None:
        while True:
            with self._lock:
                if self._closed:
                    return
                self._dispatch()
                workers = list(self._workers)
                if not workers:
                    self._lock.wait(0.5)
                    continue
            handles = [w.parent_conn for w in workers] + [w.proc.sentinel for w in workers]
            try:
                ready = mp_wait(handles, timeout=0.25)
            except OSError:
                ready = []
            now = time.time()
            with self._lock:
                for w in workers:
                    if w not in self._workers:
                        continue
                    if w.parent_conn in ready:
                        try:
                            while w.parent_conn.poll():
                                self._handle(w, w.parent_conn.recv())
                        except (EOFError, OSError):
                            self._fail_worker(w)
                            continue
                    if w.proc.sentinel in ready or not w.proc.is_alive():
                        # drain anything it sent before dying (e.g. its final "done")
                        try:
                            while w.parent_conn.poll():
                                self._handle(w, w.parent_conn.recv())
                        except (EOFError, OSError):
                            pass
                        self._fail_worker(w)
                        continue
                    if w.task and now - w.task.heartbeat > HANG_S:
                        self._fail_worker(w, f"stopped responding (no heartbeat for {HANG_S:.0f} s)")
                        continue
                    if (w.task is None and now - w.idle_since > IDLE_EXIT_S
                            and len(self._workers) > self.keep_warm):
                        self._workers.remove(w)
                        try:
                            w.send(("stop",))
                        except OSError:
                            pass
                self._lock.notify_all()


def _safe(fn: Callable, *a: Any) -> None:
    try:
        fn(*a)
    except Exception:  # pragma: no cover
        log.exception("worker callback failed")


# --- process-wide pools --------------------------------------------------------------------
_pools: dict[str, WorkerPool] = {}
_pools_lock = threading.Lock()


def pool(name: str) -> WorkerPool:
    """'jobs'  = imports + stems (long-running),
    'quick' = export / render / onsets (interactive, so never stuck behind a long job),
    'safe'  = retries: one single-threaded worker, the most conservative settings."""
    with _pools_lock:
        p = _pools.get(name)
        if p is None or p._closed:
            from . import config
            if name == "jobs":
                p = WorkerPool(name, config.JOB_WORKERS)
            elif name == "safe":
                p = WorkerPool(name, 1, keep_warm=0, threads=1)
            else:
                p = WorkerPool(name, 2, keep_warm=1)
            _pools[name] = p
        return p


def shutdown_all() -> None:
    with _pools_lock:
        pools = list(_pools.values())
        _pools.clear()
    for p in pools:
        p.shutdown()


import atexit  # noqa: E402

atexit.register(shutdown_all)
