"""Download the third-party programs the installers ship, into desktop/vendor/:

    desktop/vendor/ffmpeg/<os>/  ffmpeg, ffprobe, LICENSE.txt, BUILD-INFO.txt
    desktop/vendor/deno/<os>/    deno, LICENSE.md, BUILD-INFO.txt

    python scripts/fetch_vendor.py            # for this machine (win or mac)
    python scripts/fetch_vendor.py --check    # also fail unless the binaries run here

electron-builder copies them next to the engine (<resources>/engine/) and the licences to
<resources>/licenses/. Every download is checked against the publisher's SHA-256.
See LICENSES.md for what ships and under which licence.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import os
import platform
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "desktop" / "vendor"
DENO_VERSION = "2.9.8"

# Windows x64: BtbN/FFmpeg-Builds (linked from ffmpeg.org), LGPL static build of the 9.0 branch.
BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
WIN_FFMPEG_ZIP = "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip"
# macOS arm64: Martin Riedl's static, signed + notarized builds (linked from ffmpeg.org).
# No LGPL static macOS arm64 build is published anywhere we could find, so this one is GPLv3.
RIEDL = "https://ffmpeg.martin-riedl.de"
MAC_FFMPEG_RELEASE = "/download/macos/arm64/1789931890_9.0.2"
MAC_FFMPEG_LATEST = "/redirect/latest/macos/arm64/release"

DENO = f"https://github.com/denoland/deno/releases/download/v{DENO_VERSION}"
DENO_TARGET = {"win": "x86_64-pc-windows-msvc", "mac": "aarch64-apple-darwin"}
DENO_LICENSE = f"https://raw.githubusercontent.com/denoland/deno/v{DENO_VERSION}/LICENSE.md"


def log(msg: str) -> None:
    print(f"[vendor] {msg}", flush=True)


def fetch(url: str) -> tuple[bytes, str]:
    """GET url (following redirects). Returns (body, final url)."""
    req = urllib.request.Request(url, headers={"User-Agent": "the-ripper-build"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read(), r.geturl()
        except OSError as exc:
            if attempt == 2:
                raise
            log(f"retrying {url}: {exc}")
    raise AssertionError("unreachable")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def expect_sha(data: bytes, listing: str, name: str) -> None:
    """listing: 'sha  name' lines (sha256sum format) or a bare hash."""
    want = None
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) == 1 and re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            want = parts[0]
        elif len(parts) >= 2 and parts[-1].lstrip("*").endswith(name):
            want = parts[0]
    if not want:
        raise SystemExit(f"no checksum for {name} in the publisher's list")
    got = sha256(data)
    if got != want:
        raise SystemExit(f"checksum mismatch for {name}: got {got}, expected {want}")
    log(f"sha256 ok  {name}  {got}")


def extract(zdata: bytes, member_suffix: str, dest: Path) -> Path:
    with zipfile.ZipFile(io.BytesIO(zdata)) as z:
        names = [n for n in z.namelist() if n.endswith(member_suffix)]
        if not names:
            raise SystemExit(f"{member_suffix} not in archive")
        dest.write_bytes(z.read(names[0]))
    return dest


def clean(d: Path) -> None:
    d.mkdir(parents=True, exist_ok=True)
    for p in d.iterdir():
        if p.name != ".gitkeep":
            p.unlink() if p.is_file() else shutil.rmtree(p)


def make_runnable_on_mac(files: list[Path]) -> None:
    """Executable, no quarantine, and signed (arm64 refuses to run unsigned code)."""
    for f in files:
        f.chmod(0o755)
        subprocess.run(["xattr", "-c", str(f)], check=False)
        if subprocess.run(["codesign", "--verify", str(f)], capture_output=True).returncode != 0:
            log(f"ad-hoc signing {f.name}")
            subprocess.run(["codesign", "--force", "--sign", "-", str(f)], check=True)


def run_version(exe: Path, *args: str) -> str:
    r = subprocess.run([str(exe), *args], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise SystemExit(f"{exe} {' '.join(args)} failed ({r.returncode}): {r.stderr[:500]}")
    return r.stdout


def ffmpeg_license(configuration: str) -> str:
    gpl = "--enable-gpl" in configuration
    v3 = "--enable-version3" in configuration
    if gpl:
        return "GPL-3.0-or-later" if v3 else "GPL-2.0-or-later"
    return "LGPL-3.0-or-later" if v3 else "LGPL-2.1-or-later"


# --- ffmpeg ---------------------------------------------------------------------------------
def ffmpeg_win(dest: Path) -> dict:
    sums, _ = fetch(f"{BTBN}/checksums.sha256")
    data, final = fetch(f"{BTBN}/{WIN_FFMPEG_ZIP}")
    expect_sha(data, sums.decode(), WIN_FFMPEG_ZIP)
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        extract(data, f"/bin/{name}", dest / name)
    extract(data, "/LICENSE.txt", dest / "LICENSE.txt")
    return {"source": final, "sha256": sha256(data), "publisher": "BtbN/FFmpeg-Builds (win64 lgpl static)"}


def ffmpeg_mac(dest: Path) -> dict:
    info = {"publisher": "Martin Riedl, ffmpeg.martin-riedl.de (macOS arm64 static, release)"}
    for name in ("ffmpeg", "ffprobe"):
        try:
            data, final = fetch(f"{RIEDL}{MAC_FFMPEG_RELEASE}/{name}.zip")
            sums, _ = fetch(f"{RIEDL}{MAC_FFMPEG_RELEASE}/{name}.zip.sha256")
        except OSError:  # the pinned release was pruned: take the newest release build
            data, final = fetch(f"{RIEDL}{MAC_FFMPEG_LATEST}/{name}.zip")
            sums, _ = fetch(final + ".sha256")
        expect_sha(data, sums.decode(), f"{name}.zip")
        extract(data, name, dest / name)
        info[f"{name}_source"] = final
        info[f"{name}_sha256"] = sha256(data)
    return info


# --- deno -----------------------------------------------------------------------------------
def deno(osk: str, dest: Path) -> dict:
    asset = f"deno-{DENO_TARGET[osk]}.zip"
    data, final = fetch(f"{DENO}/{asset}")
    sums, _ = fetch(f"{DENO}/{asset}.sha256sum")
    expect_sha(data, sums.decode(), asset)
    exe = "deno.exe" if osk == "win" else "deno"
    extract(data, exe, dest / exe)
    lic, _ = fetch(DENO_LICENSE)
    (dest / "LICENSE.md").write_bytes(lic)
    return {"source": final, "sha256": sha256(data), "version": DENO_VERSION, "license": "MIT"}


def write_info(path: Path, fields: dict) -> None:
    path.write_text("".join(f"{k}: {v}\n" for k, v in fields.items()), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="run the binaries and verify licences")
    args = ap.parse_args()
    osk = {"win32": "win", "darwin": "mac"}.get(sys.platform)
    if osk is None:
        raise SystemExit("installers bundle tools for Windows and macOS only; on Linux use your distro's ffmpeg")
    if osk == "mac" and platform.machine() != "arm64":
        raise SystemExit("the macOS build bundles arm64 binaries; build on an Apple-silicon Mac")
    exe = ".exe" if osk == "win" else ""

    ff_dir, deno_dir = VENDOR / "ffmpeg" / osk, VENDOR / "deno" / osk
    clean(ff_dir)
    clean(deno_dir)
    ff_info = ffmpeg_win(ff_dir) if osk == "win" else ffmpeg_mac(ff_dir)
    deno_info = deno(osk, deno_dir)
    bins = [ff_dir / f"ffmpeg{exe}", ff_dir / f"ffprobe{exe}", deno_dir / f"deno{exe}"]
    if osk == "mac":
        make_runnable_on_mac(bins)

    # Record exactly what we ship (also needed for the licence notice).
    out = run_version(bins[0], "-version")
    version = out.splitlines()[0]
    configuration = next((l for l in out.splitlines() if l.startswith("configuration:")), "")
    lic = ffmpeg_license(configuration)
    # The (L)GPLv3 notice must travel with the binaries. LGPLv3 is a set of additions to the
    # GPLv3, so the GPLv3 text ships in both cases. Riedl's zips carry no licence file.
    shutil.copyfile(ROOT / "licenses" / "GPL-3.0.txt", ff_dir / "GPL-3.0.txt")
    if osk == "mac":
        shutil.copyfile(ROOT / "licenses" / "GPL-3.0.txt", ff_dir / "LICENSE.txt")
    write_info(ff_dir / "BUILD-INFO.txt", {"version": version, "license": lic, **ff_info,
                                           "configuration": configuration.removeprefix("configuration: ")})
    deno_version = run_version(bins[2], "--version").splitlines()[0]
    write_info(deno_dir / "BUILD-INFO.txt", {**deno_info, "version": deno_version})
    run_version(bins[1], "-version")

    for b in bins:
        log(f"{b.relative_to(ROOT)}  {b.stat().st_size / 1e6:.1f} MB")
    log(f"ffmpeg: {version}  [{lic}]")
    log(f"deno:   {deno_version}  [MIT]")
    if args.check and osk == "win" and lic.startswith("GPL"):
        raise SystemExit("expected an LGPL ffmpeg build for Windows")
    gh_out = os.environ.get("GITHUB_STEP_SUMMARY")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write(f"### Bundled tools ({osk})\n\n| tool | version | licence |\n|---|---|---|\n"
                    f"| ffmpeg + ffprobe | `{version}` | {lic} |\n| deno | `{deno_version}` | MIT |\n\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
