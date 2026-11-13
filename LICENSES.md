# Third-party programs shipped with The Ripper

The Windows and macOS installers include the programs below. Each one is a separate
executable, run as its own process by the engine. None of them is linked into The Ripper.
CI downloads them with `scripts/fetch_vendor.py` and checks each download against the
publisher's SHA-256. The exact build that shipped is recorded in
`<app resources>/licenses/<tool>/BUILD-INFO.txt`, with its version string, `configure`
line, source URL and checksum.

| Program | Platform | Build | Version | Licence |
|---|---|---|---|---|
| ffmpeg + ffprobe | Windows x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) `ffmpeg-n9.0-latest-win64-lgpl-9.0.zip` (static, **LGPL** variant) | FFmpeg 9.0.x (latest point release of the 9.0 branch at build time) | **LGPL-3.0-or-later** |
| ffmpeg + ffprobe | macOS arm64 | [Martin Riedl's FFmpeg builds](https://ffmpeg.martin-riedl.de) `macos/arm64` release (static, code-signed) | FFmpeg 9.0.2 | **GPL-3.0-or-later** (built with `--enable-gpl --enable-version3`, x264/x265) |
| Deno | Windows x64, macOS arm64 | [denoland/deno](https://github.com/denoland/deno/releases) v2.9.8 official release | 2.9.8 | **MIT** |

## ffmpeg

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project. Source code:
<https://ffmpeg.org/download.html>. The exact source for each build is in that build's
`BUILD-INFO.txt`: the version string carries the git revision.

* **Windows** ships BtbN's LGPL build, which is configured without `--enable-gpl`. CI fails
  the build if a GPL configuration ever turns up. Licence texts: `licenses/ffmpeg/LICENSE.txt`
  (LGPLv3, from the archive) and `licenses/ffmpeg/GPL-3.0.txt`, because the LGPLv3 is written
  as additions to the GPLv3.
* **macOS**: we could not find an LGPL *static* arm64 build from any publisher, so this one
  is GPLv3. Licence text: `licenses/ffmpeg/LICENSE.txt` (GPLv3). The Ripper only runs it as a
  separate program, so it is distributed alongside the app (mere aggregation), not linked.
  Under the GPL, recipients may ask for the corresponding source. Martin Riedl publishes the
  build scripts at <https://git.martin-riedl.de/ffmpeg/build-script>, and the FFmpeg source
  for the version is at <https://ffmpeg.org/releases/>. To ship an LGPL build on macOS, compile
  FFmpeg without `--enable-gpl` and replace `desktop/vendor/ffmpeg/mac/` before packaging.

Copies of the licence texts are also kept in this repository under `licenses/`.

## Deno

Deno lets yt-dlp solve the JavaScript challenges some sites (such as YouTube) use. It is MIT
licensed, Copyright 2018-2026 the Deno authors. Licence text: `licenses/deno/LICENSE.md`.
yt-dlp's solver scripts come from the `yt-dlp-ejs` Python package (Unlicense), which is
bundled in the engine.

## Other components

The engine bundles Python packages (Flask, librosa, NumPy, SciPy, yt-dlp, …) under their
own permissive licences. Electron's and Chromium's notices ship as `LICENSE.electron.txt`
and `LICENSES.chromium.html` next to the app executable.
