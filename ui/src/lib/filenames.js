// Mirrors engine/services/exporter.py (sanitize / format_bpm / build_filename).
// {track}_{bpm}bpm_{key}_{slice##|stemname}.wav

export function sanitize(text, fallback = 'track', maxLen = 40) {
  let s = String(text ?? '').replace(/[^A-Za-z0-9#]+/g, '-').replace(/^-+|-+$/g, '')
  s = s.slice(0, maxLen).replace(/^-+|-+$/g, '')
  return s || fallback
}

/** One decimal, round-half-up (matches Python's math.floor(x*10+0.5)/10). */
export function formatBpm(bpm) {
  const r = Math.floor(Number(bpm) * 10 + 0.5) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

export function baseName(track, bpm, key) {
  const parts = [sanitize(track), `${formatBpm(bpm)}bpm`]
  if (key) parts.push(sanitize(key, 'key', 4))
  return parts.join('_')
}

export function buildFilename(track, bpm, key, part, ext = 'wav') {
  return `${baseName(track, bpm, key)}_${sanitize(part, 'part')}.${ext}`
}

export const sliceName = (i) => `slice${String(i + 1).padStart(2, '0')}`
