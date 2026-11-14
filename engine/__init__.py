"""The Ripper audio engine."""
# Must run before numpy / scipy / numba / librosa are imported anywhere in this process:
# caps their thread pools and points numba's cache at a writable folder (engine/runtime.py).
from . import runtime as _runtime

_runtime.configure()
