"""PyInstaller entry point for the ripper-engine executable."""
import multiprocessing
import sys

from engine.app import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
