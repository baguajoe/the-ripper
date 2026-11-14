"""Build the HQ (AI) add-on runtime for one platform, and the release manifest.

    python scripts/build_ai_pack.py build --variant win-cpu --out dist/ai [--selftest]
    python scripts/build_ai_pack.py manifest --out dist/ai/ripper-ai-manifest.json dist/ai/*.json

A pack is a relocatable CPython (python-build-standalone, via uv) with torch + Demucs 4.1
installed, plus engine/ai_runner/ripper_ai.py and pack.json. It holds NO model weights: the
app fetches those from the Demucs author's Hugging Face repos when the add-on is installed
(see engine/services/addon.py and LICENSES.md).

The zip is split into parts below GitHub's 2 GiB release-asset limit. Each build writes
<variant>.json (its files, sizes, SHA-256s); `manifest` merges them into the release manifest
the app reads (config.AI_MANIFEST_NAME).

Needs `uv` on PATH (CI: astral-sh/setup-uv).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PYTHON = "3.12"
DEMUCS = "demucs==4.1.0"
COMMON = ["numpy>=2.0,<2.6", "soundfile>=0.13", "PyYAML>=6"]
PYTORCH_INDEX = "https://download.pytorch.org/whl"
# variant -> (torch requirement, package index for torch or None for PyPI)
#   win-cuda: cu128 = any NVIDIA driver with CUDA 12 support (2023+), RTX 20 … RTX 50 series.
#             GPUs it has no kernels for (e.g. GTX 10 series) fall back to the CPU at run time.
VARIANTS = {
    "win-cpu": ("torch==2.15.0", f"{PYTORCH_INDEX}/cpu"),
    "win-cuda": ("torch==2.11.0", f"{PYTORCH_INDEX}/cu128"),
    "mac-arm64": ("torch==2.15.0", None),          # PyPI wheels support Apple Silicon (MPS)
    "linux-cpu": ("torch==2.15.0", f"{PYTORCH_INDEX}/cpu"),  # dev / CI only, not released
}
PART_BYTES = 1_900_000_000  # < 2 GiB per GitHub release asset
PRUNE = ["torch/include", "torch/share/cmake", "torch/test", "caffe2"]


def log(msg: str) -> None:
    print(f"[ai-pack] {msg}", flush=True)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    log("$ " + " ".join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], check=True, **kw)


def find_python(root: Path) -> Path:
    for rel in ("python.exe", "bin/python3"):
        p = root / rel
        if p.exists():
            return p
    raise SystemExit(f"no python in {root}")


def site_packages(py: Path) -> Path:
    out = subprocess.run([str(py), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
                         capture_output=True, text=True, check=True).stdout.strip()
    return Path(out)


def dir_bytes(d: Path) -> int:
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


def build(variant: str, out: Path, work: Path, selftest: bool, part_bytes: int) -> dict:
    from engine import config

    torch_req, index = VARIANTS[variant]
    out.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(work, ignore_errors=True)
    stage = work / "stage"
    stage.mkdir(parents=True)

    # 1. a relocatable CPython (python-build-standalone, checksummed by uv)
    pyroots = work / "pythons"
    env = {**os.environ, "UV_PYTHON_INSTALL_DIR": str(pyroots), "UV_PYTHON_INSTALL_BIN": "0"}
    run(["uv", "python", "install", PYTHON], env=env)
    # the real install is cpython-3.12.N-…; uv adds a cpython-3.12-… alias (symlink / junction)
    found = [p for p in pyroots.iterdir() if re.match(r"cpython-\d+\.\d+\.\d+", p.name) and not p.is_symlink()]
    if len(found) != 1:
        raise SystemExit(f"expected one uv python in {pyroots}, got {found}")
    shutil.move(str(found[0]), stage / "python")
    py = find_python(stage / "python")
    for marker in (stage / "python").rglob("EXTERNALLY-MANAGED"):
        marker.unlink()  # it's our own private Python
    pyver = subprocess.run([str(py), "-c", "import sys; print(sys.version.split()[0])"],
                           capture_output=True, text=True, check=True).stdout.strip()
    log(f"python {pyver} at {py}")

    # 2. torch (+ the right index) and Demucs
    cmd = ["uv", "pip", "install", "--python", py, "--no-cache", "--link-mode=copy", torch_req]
    if index:
        cmd += ["--index-url", index, "--extra-index-url", "https://pypi.org/simple", "--index-strategy", "unsafe-best-match"]
    run(cmd + COMMON)
    run(["uv", "pip", "install", "--python", py, "--no-cache", "--link-mode=copy", DEMUCS, *COMMON, torch_req]
        + (["--index-url", index, "--extra-index-url", "https://pypi.org/simple", "--index-strategy", "unsafe-best-match"] if index else []))
    sp = site_packages(py)
    for rel in PRUNE:
        shutil.rmtree(sp / rel, ignore_errors=True)
    for d in list(sp.rglob("__pycache__")):
        shutil.rmtree(d, ignore_errors=True)
    versions = json.loads(subprocess.run(
        [str(py), "-c", "import json, torch, demucs, numpy; print(json.dumps({'torch': torch.__version__, "
                        "'demucs': demucs.__version__, 'numpy': numpy.__version__, 'cuda': torch.version.cuda}))"],
        capture_output=True, text=True, check=True).stdout)
    log(f"installed {versions}")

    # 3. the runner + pack.json
    shutil.copyfile(ROOT / "engine" / "ai_runner" / "ripper_ai.py", stage / "ripper_ai.py")
    rel_py = py.relative_to(stage).as_posix()
    pack = {"format": config.AI_PACK_FORMAT, "variant": variant, "python": rel_py, "runner": "ripper_ai.py",
            "python_version": pyver, **versions, "built": time.strftime("%Y-%m-%d")}
    (stage / "pack.json").write_text(json.dumps(pack, indent=1), encoding="utf-8")

    # 4. self-test: the pack's own Python separates a 10 s clip with every model
    if selftest:
        selftest_pack(stage)

    # 5. zip (keeping executable bits) and split
    unpacked = dir_bytes(stage)
    name = f"ripper-ai-{config.ENGINE_VERSION}-{variant}.zip"
    zpath = work / name
    log(f"zipping {unpacked / 1e9:.2f} GB")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=5) as z:
        for p in sorted(stage.rglob("*")):
            if p.is_file():
                info = zipfile.ZipInfo.from_file(p, p.relative_to(stage).as_posix())
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(p, "rb") as fh, z.open(info, "w") as zf:
                    shutil.copyfileobj(fh, zf, 1 << 20)
    zsha = sha256(zpath)
    files = []
    with open(zpath, "rb") as fh:
        i = 1
        while True:
            chunk = fh.read(part_bytes)
            if not chunk:
                break
            part = out / f"{name}.{i:03d}"
            part.write_bytes(chunk)
            files.append({"name": part.name, "size": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
            i += 1
    zsize = zpath.stat().st_size
    zpath.unlink()
    frag = {"variant": variant, "files": files, "zip_sha256": zsha, "zip_bytes": zsize,
            "unpacked_bytes": unpacked, **{k: pack[k] for k in ("python_version", "torch", "demucs", "cuda")}}
    (out / f"{variant}.json").write_text(json.dumps(frag, indent=1), encoding="utf-8")
    log(f"{variant}: {zsize / 1e9:.2f} GB in {len(files)} part(s), {unpacked / 1e9:.2f} GB unpacked")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### HQ (AI) add-on: {variant}\n\n- download **{zsize / 1e6:.0f} MB** in {len(files)} part(s), "
                    f"{unpacked / 1e6:.0f} MB unpacked\n- Python {pyver}, torch {pack['torch']}, Demucs {pack['demucs']}"
                    f"{', CUDA ' + str(pack['cuda']) if pack['cuda'] else ''}\n\n")
    return frag


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def models_dir() -> Path:
    d = Path(os.environ.get("RIPPER_AI_MODELS_DIR") or Path.home() / ".cache" / "ripper-demucs-models")
    os.environ["RIPPER_AI_MODELS_DIR"] = str(d)
    return d


def selftest_pack(stage: Path) -> None:
    """probe, then 4-stem / 6-stem / 2-stem on a 10 s clip, with the pack's own Python."""
    import numpy as np
    import soundfile as sf

    from engine.services import addon
    from engine.tests import fixtures

    models = models_dir()
    addon.ensure_weights(None, lambda p, m: None)  # from the author's HF repos (pinned, checked)
    probe = addon.run_runner(stage, ["probe"], timeout=600)
    log(f"probe: {probe}")
    clip = stage.parent / "clip.wav"
    sf.write(str(clip), fixtures.make_beat(120, duration=10.0).T, fixtures.SR, subtype="PCM_16")
    expect = {"htdemucs": {"drums", "bass", "other", "vocals"},
              "htdemucs_6s": {"drums", "bass", "other", "vocals", "guitar", "piano"},
              "two_stem": {"vocals", "instrumental"}}
    for model, names in expect.items():
        out = stage.parent / f"out-{model}"
        t0 = time.time()
        res = addon.run_runner(stage, ["separate", "--input", str(clip), "--output", str(out), "--model", model,
                                       "--models-dir", str(models)], timeout=1800)
        got = {p.stem for p in out.glob("*.wav")}
        if set(res["stems"]) != names or got != names:
            raise SystemExit(f"self-test {model}: got {res['stems']} / {sorted(got)}, expected {sorted(names)}")
        for p in out.glob("*.wav"):
            data, sr = sf.read(str(p))
            if sr != fixtures.SR or len(data) != 10 * fixtures.SR or not np.isfinite(data).all():
                raise SystemExit(f"self-test {model}: bad output {p.name}")
        log(f"self-test {model} ok on {res['device']} in {time.time() - t0:.1f} s")
        shutil.rmtree(out)
    clip.unlink()
    for d in list(stage.rglob("__pycache__")):  # created by the self-test; not shipped
        shutil.rmtree(d, ignore_errors=True)


def manifest(out: Path, fragments: list[Path], base_url: str | None) -> dict:
    from engine import config
    variants = {}
    for f in fragments:
        frag = json.loads(f.read_text(encoding="utf-8"))
        if base_url:
            for item in frag["files"]:
                item["name"] = base_url.rstrip("/") + "/" + item["name"]
        variants[frag.pop("variant")] = frag
    data = {"format": config.AI_PACK_FORMAT, "app_version": config.ENGINE_VERSION, "variants": variants}
    out.write_text(json.dumps(data, indent=1), encoding="utf-8")
    log(f"manifest {out}: {sorted(variants)}")
    return data


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    b.add_argument("--out", type=Path, default=ROOT / "dist" / "ai")
    b.add_argument("--work", type=Path, default=ROOT / "build" / "ai-pack")
    b.add_argument("--selftest", action="store_true")
    b.add_argument("--part-bytes", type=int, default=PART_BYTES)
    m = sub.add_parser("manifest")
    m.add_argument("--out", type=Path, required=True)
    m.add_argument("--base-url", help="absolute URL prefix for the files (default: next to the manifest)")
    m.add_argument("fragments", nargs="+", type=Path)
    args = ap.parse_args()
    if args.cmd == "build":
        build(args.variant, args.out, args.work, args.selftest, args.part_bytes)
    else:
        manifest(args.out, args.fragments, args.base_url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
