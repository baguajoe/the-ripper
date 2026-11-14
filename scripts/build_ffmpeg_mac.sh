#!/usr/bin/env bash
# Build ffmpeg + ffprobe for macOS arm64 from source, LGPL only (no --enable-gpl), static, with
# nothing linked but macOS system libraries. CI caches the result (keyed on this file).
#
#   bash scripts/build_ffmpeg_mac.sh [OUT_DIR]      # default build/ffmpeg-mac
#
# OUT_DIR gets ffmpeg, ffprobe, LICENSE.txt (the LGPL v2.1 text from the FFmpeg source) and
# SOURCE.txt (exact sources, checksums and configure line). scripts/fetch_vendor.py copies them
# into desktop/vendor/ffmpeg/mac/. Runs on Linux too (for testing the configuration).
#
# Sources (checksums pinned below):
#   FFmpeg 9.0.2  https://ffmpeg.org/releases/  (LGPL-2.1-or-later as configured)
#   LAME 3.100    libmp3lame (LGPL-2.0-or-later): MP3 encoding, used by our test fixtures
set -euo pipefail

FFMPEG_VERSION=9.0.2
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
LAME_VERSION=3.100
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
MACOS_MIN=12.0   # Electron 45 needs macOS 12+

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/ffmpeg-mac}"
WORK="$(mktemp -d)"
PREFIX="$WORK/prefix"
trap 'rm -rf "$WORK"' EXIT
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

fetch() { # url sha256 dest
  curl -fsSL --retry 4 --retry-delay 5 -o "$3" "$1"
  local got
  got="$( (shasum -a 256 "$3" 2>/dev/null || sha256sum "$3") | cut -d' ' -f1)"
  [ "$got" = "$2" ] || { echo "checksum mismatch for $1: $got"; exit 1; }
  echo "sha256 ok  $(basename "$3")"
}

EXTRA_CFLAGS="-O2"
EXTRA_LDFLAGS=""
FF_PLATFORM=(--disable-x86asm)  # Linux test builds: no nasm needed
if [ "$(uname)" = Darwin ]; then
  EXTRA_CFLAGS="$EXTRA_CFLAGS -mmacosx-version-min=$MACOS_MIN"
  EXTRA_LDFLAGS="-mmacosx-version-min=$MACOS_MIN"
  FF_PLATFORM=(--cc=clang --arch=arm64 --target-os=darwin --enable-securetransport)
  export MACOSX_DEPLOYMENT_TARGET=$MACOS_MIN
  # never pick up Homebrew's libraries (they don't exist on users' Macs)
  export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
fi

cd "$WORK"
fetch "$LAME_URL" "$LAME_SHA256" lame.tar.gz
fetch "$FFMPEG_URL" "$FFMPEG_SHA256" ffmpeg.tar.xz
tar xzf lame.tar.gz
tar xJf ffmpeg.tar.xz

echo "==> LAME $LAME_VERSION (static)"
(
  cd "lame-$LAME_VERSION"
  # 3.100 lists a symbol it doesn't define; Homebrew applies the same fix
  sed -i.bak '/lame_init_old/d' include/libmp3lame.sym
  host=()
  [ "$(uname)" = Darwin ] && host=(--build=aarch64-apple-darwin --host=aarch64-apple-darwin)
  CFLAGS="$EXTRA_CFLAGS" LDFLAGS="$EXTRA_LDFLAGS" ./configure "${host[@]}" --prefix="$PREFIX" \
    --disable-shared --enable-static --disable-frontend --disable-decoder --disable-dependency-tracking >/dev/null
  make -j"$JOBS" >/dev/null
  make install >/dev/null
)

echo "==> FFmpeg $FFMPEG_VERSION (LGPL, static)"
CONFIGURE=(
  --prefix="$PREFIX" "${FF_PLATFORM[@]}"
  --disable-autodetect --enable-pthreads --enable-zlib --enable-bzlib --enable-iconv
  --enable-libmp3lame
  --disable-ffplay --disable-doc --disable-debug --disable-shared --enable-static
  --pkg-config-flags=--static
  --extra-cflags="-I$PREFIX/include $EXTRA_CFLAGS" --extra-ldflags="-L$PREFIX/lib $EXTRA_LDFLAGS"
)
(
  cd "ffmpeg-$FFMPEG_VERSION"
  ./configure "${CONFIGURE[@]}" > "$WORK/configure.log" || { tail -40 ffbuild/config.log; exit 1; }
  make -j"$JOBS" ffmpeg ffprobe >/dev/null
)

mkdir -p "$OUT"
rm -f "$OUT"/ffmpeg "$OUT"/ffprobe
cp "ffmpeg-$FFMPEG_VERSION/ffmpeg" "ffmpeg-$FFMPEG_VERSION/ffprobe" "$OUT/"
cp "ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$OUT/LICENSE.txt"
strip "$OUT/ffmpeg" "$OUT/ffprobe" 2>/dev/null || true

conf="$("$OUT/ffmpeg" -hide_banner -buildconf | tr -s ' \n' ' ')"
case "$conf" in *--enable-gpl*|*--enable-nonfree*) echo "GPL/nonfree configuration: $conf"; exit 1;; esac
# (-L wraps its text over lines: join them before matching)
"$OUT/ffmpeg" -hide_banner -L | tr -s ' \n' ' ' | grep -q "GNU Lesser General Public License" || { echo "not an LGPL build"; exit 1; }
if [ "$(uname)" = Darwin ]; then
  # only system libraries / frameworks may be linked
  if otool -L "$OUT/ffmpeg" "$OUT/ffprobe" | tail -n +2 | grep -v -E '^\S|/usr/lib/|/System/Library/'; then
    echo "linked against a non-system library"; exit 1
  fi
fi
{
  echo "FFmpeg ${FFMPEG_VERSION}: ${FFMPEG_URL}"
  echo "  sha256 ${FFMPEG_SHA256}"
  echo "LAME ${LAME_VERSION} (libmp3lame): ${LAME_URL}"
  echo "  sha256 ${LAME_SHA256}"
  echo "Built by scripts/build_ffmpeg_mac.sh (The Ripper repository) on $(uname -sm), $(date -u +%Y-%m-%d)"
  echo "configure: ${CONFIGURE[*]}"
} > "$OUT/SOURCE.txt"
"$OUT/ffmpeg" -hide_banner -version | head -1
echo "LGPL ffmpeg + ffprobe -> $OUT"
