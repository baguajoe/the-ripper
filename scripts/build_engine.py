"""Build the standalone engine with PyInstaller.

    python scripts/build_engine.py            # onedir, no AI  -> engine/dist/ripper-engine/
    python scripts/build_engine.py --with-ai  # also bundle torch + demucs (very large)
    python scripts/build_engine.py --onefile  # single self-extracting file (slower start)
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine"


def main() -> int:
    env = dict(os.environ)
    if "--with-ai" in sys.argv:
        env["RIPPER_BUILD_AI"] = "1"
    if "--onefile" in sys.argv:
        env["RIPPER_BUILD_ONEFILE"] = "1"
    shutil.rmtree(ENGINE / "build", ignore_errors=True)
    shutil.rmtree(ENGINE / "dist", ignore_errors=True)
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
           "--distpath", str(ENGINE / "dist"), "--workpath", str(ENGINE / "build"),
           "ripper-engine.spec"]
    r = subprocess.run(cmd, cwd=ENGINE, env=env)
    if r.returncode:
        return r.returncode
    exe = ENGINE / "dist" / "ripper-engine" / ("ripper-engine.exe" if os.name == "nt" else "ripper-engine")
    if not exe.exists():
        exe = ENGINE / "dist" / ("ripper-engine.exe" if os.name == "nt" else "ripper-engine")
    print(f"\nBuilt {exe}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
