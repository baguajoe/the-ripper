"""PyInstaller entry point for the ripper-engine executable."""
import multiprocessing
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()
    # Tell the desktop app we're alive before the (slow, on a cold start) imports.
    print("RIPPER_ENGINE_STAGE Loading Python libraries", flush=True)
    from engine.app import main
    sys.exit(main())
