# PyInstaller spec for the standalone engine.  Build with:  npm run build:engine
#   (or: python scripts/build_engine.py [--onefile] [--with-ai])
# Output: engine/dist/ripper-engine/ripper-engine[.exe]  (onedir: fast start, what the app ships)
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

WITH_AI = os.environ.get("RIPPER_BUILD_AI") == "1"
ONEFILE = os.environ.get("RIPPER_BUILD_ONEFILE") == "1"

datas = (collect_data_files("librosa") + collect_data_files("yt_dlp")
         + collect_data_files("yt_dlp_ejs", includes=["**/*.js"]))
hidden = (collect_submodules("librosa") + collect_submodules("engine") + collect_submodules("yt_dlp_ejs")
          + ["soundfile", "soxr", "mido.backends", "sklearn.utils._typedefs"])
excludes = ["tkinter", "matplotlib", "IPython", "pytest", "Xlib", "PyInstaller"]
if WITH_AI:
    hidden += collect_submodules("demucs")
    datas += collect_data_files("demucs")
else:
    excludes += ["torch", "torchaudio", "demucs", "torchvision", "triton"]

a = Analysis(
    ["run_engine.py"],
    pathex=[os.path.abspath("..")],
    datas=datas,
    hiddenimports=hidden,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)
if ONEFILE:
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, name="ripper-engine", console=True, upx=False)
else:
    exe = EXE(pyz, a.scripts, exclude_binaries=True, name="ripper-engine", console=True, upx=False)
    coll = COLLECT(exe, a.binaries, a.datas, name="ripper-engine", upx=False)
