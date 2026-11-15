// Slice trimming: snapping (zero crossing, nearest transient, grid), nudging and
// "link neighbors" (moving an edge moves the touching edge of the slice next to it).
// Pure functions over plain slices; the trim editor and the main waveform both use them.
import { MIN_SLICE, snap as gridSnap } from './grid.js'

export const ZERO_WINDOW = 0.005 // seconds searched either side for a zero crossing
export const NUDGE = { fine: 0.001, coarse: 0.01 } // arrow / Shift+arrow; Ctrl+arrow = 1 beat
export const DEFAULT_TRIM = { snap: 'off', zero: true, link: false } // snap: 'off' | 'transient' | 'grid'

/** Mono mix of {channels} (cached per source object). */
const monoCache = new WeakMap()
export function monoOf(src) {
  let m = monoCache.get(src)
  if (m) return m
  const [a, b] = src.channels
  if (!b) m = a
  else {
    m = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) m[i] = 0.5 * (a[i] + b[i])
  }
  monoCache.set(src, m)
  return m
}

/** True when sample j sits on a zero crossing: it is 0, or the sign changes right before or after it. */
export function isZeroCrossing(d, j) {
  if (j <= 0 || j >= d.length - 1) return true // the ends of the audio count
  const neg = d[j] < 0
  return d[j] === 0 || (d[j - 1] < 0) !== neg || (d[j + 1] < 0) !== neg
}

/**
 * Time of the zero crossing nearest t (of the two samples around a sign change, the one nearer
 * to zero), within ±window. dir: 0 = either side, +1 = strictly after `after`, -1 = strictly
 * before it (nudging). Returns t unchanged if there's none.
 */
export function snapZero(src, t, { window = ZERO_WINDOW, dir = 0, after = t } = {}) {
  const d = monoOf(src)
  const sr = src.sr
  const c = Math.round(t * sr)
  const w = Math.max(1, Math.round(window * sr))
  let best = -1
  let bestDist = Infinity
  for (let i = Math.max(1, c - w); i <= Math.min(d.length - 1, c + w + 1); i++) {
    if (!(d[i] === 0 || (d[i - 1] < 0) !== (d[i] < 0))) continue
    const j = Math.abs(d[i - 1]) < Math.abs(d[i]) ? i - 1 : i
    if (dir > 0 && j / sr <= after + 1e-9) continue
    if (dir < 0 && j / sr >= after - 1e-9) continue
    const dist = Math.abs(j - c)
    if (dist < bestDist) { best = j; bestDist = dist }
  }
  return best < 0 ? t : best / sr
}

/** Nearest onset to t (or t when there are none). */
export function snapTransient(onsets, t) {
  let best = t
  let dist = Infinity
  for (const o of onsets || []) {
    const dd = Math.abs(o - t)
    if (dd < dist) { dist = dd; best = o }
  }
  return best
}

/**
 * Snap an edge time per the trim settings.
 * ctx: {src, onsets, bpm, downbeat, divisionBeats, duration}; opts: DEFAULT_TRIM-shaped.
 */
export function snapEdge(t, opts, ctx, { dir = 0, after = t } = {}) {
  let x = t
  if (opts.snap === 'transient') x = snapTransient(ctx.onsets, x)
  else if (opts.snap === 'grid' && ctx.bpm) x = gridSnap(x, ctx.bpm, ctx.downbeat ?? 0, ctx.divisionBeats ?? 1, ctx.duration ?? Infinity)
  if (opts.zero && ctx.src) x = snapZero(ctx.src, x, { dir, after })
  return Math.max(0, Math.min(ctx.duration ?? Infinity, x))
}

/** Nudge step in seconds for an arrow-key event (Shift = 10 ms, Ctrl/Cmd = 1 beat). */
export function nudgeStep(e, bpm) {
  if (e.ctrlKey || e.metaKey) return 60 / (bpm || 120)
  return e.shiftKey ? NUDGE.coarse : NUDGE.fine
}

/**
 * Move `edge` ('start' | 'end') of slice `id` to t (already snapped). Keeps the slice at least
 * MIN_SLICE long; with link, the neighbouring slice's touching edge follows (slices stay contiguous).
 * Returns a new slice list (same order).
 */
export function moveEdge(slices, id, edge, t, { link = false, duration = Infinity } = {}) {
  const sorted = [...slices].sort((a, b) => a.start - b.start)
  const k = sorted.findIndex((s) => s.id === id)
  if (k < 0) return slices
  const s = sorted[k]
  const prev = sorted[k - 1]
  const next = sorted[k + 1]
  let lo = 0
  let hi = duration
  if (edge === 'start') {
    hi = s.end - MIN_SLICE
    if (link && prev) lo = prev.start + MIN_SLICE
  } else {
    lo = s.start + MIN_SLICE
    if (link && next) hi = next.end - MIN_SLICE
  }
  const v = Math.min(hi, Math.max(lo, t))
  const patch = new Map([[s.id, edge === 'start' ? { start: v } : { end: v }]])
  if (link && edge === 'start' && prev) patch.set(prev.id, { end: v })
  if (link && edge === 'end' && next) patch.set(next.id, { start: v })
  return slices.map((x) => (patch.has(x.id) ? { ...x, ...patch.get(x.id) } : x))
}

/** Set both edges of a slice (typed times), with the same rules. */
export function setRange(slices, id, start, end, opts = {}) {
  const s = slices.find((x) => x.id === id)
  if (!s) return slices
  // move the edge that grows first so the two never cross
  const first = start < s.start ? ['start', start] : ['end', end]
  const second = first[0] === 'start' ? ['end', end] : ['start', start]
  const a = moveEdge(slices, id, first[0], first[1], opts)
  return moveEdge(a, id, second[0], second[1], opts)
}

/** "1.234" seconds text <-> number (ms precision); accepts m:ss.mmm too. */
export function parseTime(text) {
  const t = String(text).trim()
  const m = /^(\d+):(\d{1,2}(?:\.\d*)?)$/.exec(t)
  const v = m ? Number(m[1]) * 60 + Number(m[2]) : Number(t)
  return Number.isFinite(v) && v >= 0 ? v : null
}
export const formatSeconds = (t) => (Math.round(t * 1000) / 1000).toFixed(3)
