import multiprocessing
import sys

# Guarded: job workers are spawned processes that re-import __main__ (as __mp_main__).
if __name__ == "__main__":
    multiprocessing.freeze_support()
    from engine.app import main

    sys.exit(main())
