# Third-party software in The Ripper

## Programs shipped in the installers

The Windows and macOS installers include the programs below. Each one is a separate
executable, run as its own process by the engine. None of them is linked into The Ripper.
`scripts/fetch_vendor.py` puts them in place (downloads are checked against the publisher's
SHA-256; sources we build are checked against pinned SHA-256s). The exact build that shipped is
recorded in `<app resources>/licenses/<tool>/BUILD-INFO.txt`, with its version string,
`configure` line, source and checksum.

| Program | Platform | Build | Version | Licence |
|---|---|---|---|---|
| ffmpeg + ffprobe | Windows x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) `ffmpeg-n9.0-latest-win64-lgpl-9.0.zip` (static, **LGPL** variant) | FFmpeg 9.0.x (latest point release of the 9.0 branch at build time) | **LGPL-3.0-or-later** |
| ffmpeg + ffprobe | macOS arm64 | **Built from source** by `scripts/build_ffmpeg_mac.sh` in CI: static, without `--enable-gpl`, linking only macOS system libraries | FFmpeg 9.0.2 (+ LAME 3.100 for MP3 encoding) | **LGPL-2.1-or-later** |
| Deno | Windows x64, macOS arm64 | [denoland/deno](https://github.com/denoland/deno/releases) v2.9.8 official release | 2.9.8 | **MIT** |

### ffmpeg

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project. Source code:
<https://ffmpeg.org/download.html>.

* **Windows** ships BtbN's LGPL build, which is configured without `--enable-gpl`. Licence
  texts: `licenses/ffmpeg/LICENSE.txt` (LGPLv3, from the archive) and
  `licenses/ffmpeg/GPL-3.0.txt`, because the LGPLv3 is written as additions to the GPLv3.
* **macOS arm64** ships our own build of FFmpeg 9.0.2, compiled in CI from the release
  tarball <https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz> (SHA-256
  `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`) with LAME 3.100
  (libmp3lame, LGPL-2.0-or-later, <https://lame.sourceforge.io>, tarball SHA-256
  `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`). It is configured with
  `--disable-autodetect`, without `--enable-gpl` or `--enable-nonfree`, so the result is
  LGPL-2.1-or-later. The build script and its `configure` line are in this repository
  (`scripts/build_ffmpeg_mac.sh`) and in `licenses/ffmpeg/SOURCE.txt` in the app. Licence text:
  `licenses/ffmpeg/LICENSE.txt` (`COPYING.LGPLv2.1` from the FFmpeg source).
* CI fails the build if either platform's ffmpeg reports a GPL or non-free configuration, or if
  `ffmpeg -L` doesn't report the GNU Lesser General Public License. The installed macOS app is
  checked the same way.

Copies of the licence texts are also kept in this repository under `licenses/`.

### Deno

Deno lets yt-dlp solve the JavaScript challenges some sites (such as YouTube) use. It is MIT
licensed, Copyright 2018-2026 the Deno authors. Licence text: `licenses/deno/LICENSE.md`.
yt-dlp's solver scripts come from the `yt-dlp-ejs` Python package (Unlicense), which is
bundled in the engine.

## The HQ (AI) add-on (optional, downloaded by the user)

The HQ (AI) stems add-on is **not** in the installers. When the user clicks *Get HQ (AI) stems*,
the app downloads two things into `<app data>/TheRipper/addons/ai/`:

### 1. The add-on runtime (from this project's GitHub release)

Built per platform in CI by `scripts/build_ai_pack.py` and attached to the release as
`ripper-ai-<version>-<platform>.zip.NNN`. It contains:

| Component | Licence |
|---|---|
| CPython 3.12 ([python-build-standalone](https://github.com/astral-sh/python-build-standalone)) | PSF-2.0 (bundled libraries under their own licences, listed in the distribution) |
| PyTorch 2.15 (CPU, macOS) / 2.11 + CUDA 12.8 (Windows NVIDIA build), the official wheels | PyTorch's BSD-style licence plus those of the libraries bundled in the wheel (the wheel's licence expression lists Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2/3-Clause, MIT and others); the CUDA build also contains NVIDIA CUDA libraries, redistributed under the NVIDIA CUDA EULA as in PyTorch's own wheels |
| Demucs 4.1.0 (code) | MIT, Copyright (c) Meta Platforms, Inc. and affiliates |
| NumPy, soundfile (libsndfile: LGPL-2.1), PyYAML, einops, julius, safetensors, sphn, huggingface_hub, tqdm and their dependencies | BSD / MIT / Apache-2.0 / MPL-2.0; lameenc (LAME) LGPL-3.0-or-later |
| `ripper_ai.py` (the runner) | part of The Ripper |

### 2. The Demucs model weights (from the Demucs author's Hugging Face repositories)

**We do not redistribute the model weights.** They are downloaded on the user's computer from
the Hugging Face repositories of Demucs' author, Alexandre Défossez, pinned to exact commits and
checked against these SHA-256 sums (`engine/config.py`, `DEMUCS_WEIGHTS`):

| Model | Source | Files |
|---|---|---|
| `htdemucs` (4 stems; also used for vocals / instrumental) | <https://huggingface.co/adefossez/HTDemucs> @ `cbc8a9b1a87023b7fd74e7b3412e6321c0eab003` | `htdemucs.yaml`, `955717e8.safetensors` (`d9fa1413…576dd`) |
| `htdemucs_6s` (6 stems) | <https://huggingface.co/adefossez/HTDemucs-6s> @ `3c5ee475be622df764938de97e4281a7b07ffa58` | `htdemucs_6s.yaml`, `5c90dfd2.safetensors` (`d2a1745f…d411`) |

**Stated licence:** neither Hugging Face repository states a licence (no licence field, no
licence tag, and the model cards don't mention one, checked 2026-11-14). The Demucs code
repository the model cards point to (<https://github.com/adefossez/demucs>) says, in its
"License" section:

> Demucs code is released under the MIT license as found in the LICENSE file.
> The license of the weights is not clear: MusDB contains some data that were only usable for
> research purpose. I sadly cannot help granting a license, both coming from Meta custom data,
> or from the original MusDB data. The 6 source variant of htdemucs was trained only on Meta
> internal dataset, which likely means CC-NC-BY license is applicable, as it was the case for
> all models released by FAIR.

So the weights have no clear licence, and the 6-stem model is likely non-commercial
(CC BY-NC). That is why the app fetches them from the author's repositories instead of shipping
them, and why this needs a decision before HQ (AI) stems become a paid feature.

## Time-stretching and pitch-shifting (v1.2)

Keep-length pad tuning and "fit the sample to my beat" (tempo / key) use
**[Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch)**
(MIT, Copyright (c) 2021-2022 Geraint Luff / Signalsmith Audio Ltd.) through the Python wrapper
**[python-stretch](https://github.com/gregogiudici/python-stretch) 0.3.1** (MIT, Copyright (c)
2024 Gregorio Andrea Giudici; built with nanobind, BSD-3-Clause). Both are compiled into one
Python extension inside the bundled engine. MIT and BSD allow use in a closed-source, paid
app; the only condition is shipping the notices, which the installers do in
`licenses/signalsmith-stretch/` (copied from `licenses/signalsmith-stretch/` in this repository).

**Not used:** Rubber Band Library — GPL-2.0-or-later unless a commercial licence is bought, so
it can't go into a closed-source app for free. SoundTouch (LGPL-2.1, would have needed dynamic
linking) was the fallback and wasn't needed.

## Other components

The engine bundles Python packages (Flask, librosa, NumPy, SciPy, yt-dlp, …) under their
own permissive licences. Electron's and Chromium's notices ship as `LICENSE.electron.txt`
and `LICENSES.chromium.html` next to the app executable.
