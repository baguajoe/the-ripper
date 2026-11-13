#!/usr/bin/env bash
# Smoke test: start the engine, check health, upload the fixture MP3 (WAV if no MP3 could be
# made), poll until analyzed, chop by bar, download the export kit zip and list its contents.
#
#   RIPPER_ENGINE_CMD=<installed engine>  test a frozen / installed engine instead of python -m engine
#   SMOKE_EXPECT_BUNDLED=1                 fail unless the engine uses its bundled ffmpeg + Deno
#   SMOKE_FIXTURE=<file>                   import this file instead
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${RIPPER_PYTHON:-$ROOT/.venv/bin/python}"; [ -x "$PY" ] || PY=python3
WORK="$(mktemp -d)"
export RIPPER_APP_DATA="$WORK/appdata" RIPPER_STORAGE="$WORK/storage"
ENGINE_PID=""
cleanup() { [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

json() { "$PY" -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "==> generating fixtures"
"$PY" -m engine.tests.fixtures >/dev/null
GEN="$ROOT/engine/tests/fixtures/generated"
FIXTURE="${SMOKE_FIXTURE:-$GEN/beat_120.mp3}"
[ -f "$FIXTURE" ] || FIXTURE="$GEN/beat_120.wav"

# RIPPER_ENGINE_CMD=engine/dist/ripper-engine/ripper-engine bash scripts/smoke.sh  -> test the frozen build
if [ -n "${RIPPER_ENGINE_CMD:-}" ]; then ENGINE=("$RIPPER_ENGINE_CMD"); else ENGINE=("$PY" -m engine); fi
echo "==> starting engine: ${ENGINE[*]}"
"${ENGINE[@]}" --port 0 --new > "$WORK/engine.out" 2> "$WORK/engine.err" &
ENGINE_PID=$!
# A cold first start (Python + librosa/numba imports) can take a while on CI runners.
START=$SECONDS
until grep -q RIPPER_ENGINE_READY "$WORK/engine.out" 2>/dev/null; do
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then echo "engine exited during start-up:"; cat "$WORK/engine.out" "$WORK/engine.err"; exit 1; fi
  if (( SECONDS - START > 120 )); then echo "engine not ready after 120 s:"; cat "$WORK/engine.out" "$WORK/engine.err"; exit 1; fi
  sleep 0.5
done
echo "   ready after $(( SECONDS - START )) s"
READY="$(grep RIPPER_ENGINE_READY "$WORK/engine.out" | sed 's/^RIPPER_ENGINE_READY //')"
PORT="$(echo "$READY" | json 'd["port"]')"
TOKEN="$(echo "$READY" | json 'd["token"]')"
BASE="http://127.0.0.1:$PORT/api/v1"
H=(-H "X-Ripper-Token: $TOKEN")

echo "==> GET /health"
curl -fsS "$BASE/health" | tee "$WORK/health.json"; echo
echo "   tools: $(json 'json.dumps(d.get("tools"))' < "$WORK/health.json")"
if [ "${SMOKE_EXPECT_BUNDLED:-}" = 1 ]; then
  json '"ok" if d["tools"]["ffmpeg"] == d["tools"]["ffprobe"] == "bundled" else sys.exit("ffmpeg/ffprobe are not the bundled copies: %s" % d["tools"])' < "$WORK/health.json"
  json '"ok" if (d["tools"]["js_runtime"] or {}).get("source") == "bundled" and d["tools"]["js_runtime"]["name"] == "deno" else sys.exit("JS runtime is not the bundled Deno: %s" % d["tools"])' < "$WORK/health.json"
  echo "   bundled ffmpeg, ffprobe and Deno in use"
fi

echo "==> POST /tracks/upload ($FIXTURE)"
UP="$(curl -fsS "${H[@]}" -F "file=@$FIXTURE" "$BASE/tracks/upload")"
JOB="$(echo "$UP" | json 'd["job_id"]')"; TRACK="$(echo "$UP" | json 'd["track_id"]')"
echo "job=$JOB track=$TRACK"

echo "==> polling job"
for _ in $(seq 1 300); do
  J="$(curl -fsS "${H[@]}" "$BASE/jobs/$JOB")"
  ST="$(echo "$J" | json 'd["status"]')"
  printf '\r   %s %s%%   ' "$ST" "$(echo "$J" | json 'int(d["progress"]*100)')"
  [ "$ST" = done ] && break
  [ "$ST" = error ] && { echo; echo "$J"; exit 1; }
  sleep 0.3
done
echo
curl -fsS "${H[@]}" "$BASE/tracks/$TRACK" | json '"bpm=%s key=%s duration=%ss beats=%d" % (d["analysis"]["bpm"], d["analysis"]["key"], d["duration"], len(d["analysis"]["beats"]))'

echo "==> GET /tracks/$TRACK/slices (1 bar)"
SLICES="$(curl -fsS "${H[@]}" "$BASE/tracks/$TRACK/slices?mode=grid&division=1bar" | json 'json.dumps(d["slices"])')"
echo "$SLICES" | json '"%d slices" % len(d)'

echo "==> POST /tracks/$TRACK/export (kit: slices + stems + MIDI)"
curl -fsS "${H[@]}" -H "Content-Type: application/json" \
  -d "{\"slices\": $SLICES, \"mode\": \"oneshot\", \"sr\": 44100, \"include_stems\": true, \"include_midi\": true}" \
  -o "$WORK/kit.zip" "$BASE/tracks/$TRACK/export"
echo "==> kit contents"
"$PY" - "$WORK/kit.zip" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    print(f"   {i.file_size:>10,}  {i.filename}")
print(f"   {len(z.infolist())} files")
PY
echo "SMOKE OK"
