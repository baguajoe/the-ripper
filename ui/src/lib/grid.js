// Grid + slice math. Mirrors engine/services/chopper.py and analyzer.grid_beats exactly;
// spec in docs/formats.md (#grid, #slicing). Times are seconds.

export const MIN_SLICE = 0.05 // no slice is ever shorter than this
export const MAX_TRANSIENTS = 16 // default cap for transient chops inside a selection
export const EVEN_COUNTS = [8, 16, 32]

export const DIVISIONS = [
  { id: '1/4', label: '1/4 beat', beats: 0.25 },
  { id: '1/2', label: '1/2 beat', beats: 0.5 },
  { id: '1', label: '1 beat', beats: 1 },
  { id: '1bar', label: '1 bar', beats: 4 },
  { id: '2bar', label: '2 bars', beats: 8 },
  { id: '4bar', label: '4 bars', beats: 16 },
]

export const divisionBeats = (id) => DIVISIONS.find((d) => d.id === id)?.beats ?? 4

const round6 = (x) => Math.round(x * 1e6) / 1e6

/** Beat times in [0, duration): beat k = downbeat + k*60/bpm, k may be negative. */
export function gridBeats(bpm, downbeat, duration) {
  if (!(bpm > 0) || !(duration > 0)) return []
  const period = 60 / bpm
  const out = []
  for (let k = Math.ceil((0 - downbeat) / period - 1e-9); ; k++) {
    const t = downbeat + k * period
    if (t >= duration - 1e-6) break
    if (t >= -1e-9) out.push(round6(Math.max(t, 0)))
  }
  return out
}

/** Grid lines with a flag for bar starts (every 4th beat counted from the downbeat). */
export function gridLines(bpm, downbeat, duration) {
  if (!(bpm > 0) || !(duration > 0)) return []
  const period = 60 / bpm
  const out = []
  for (let k = Math.ceil((0 - downbeat) / period - 1e-9); ; k++) {
    const t = downbeat + k * period
    if (t >= duration - 1e-6) break
    if (t >= -1e-9) out.push({ t: Math.max(t, 0), bar: ((k % 4) + 4) % 4 === 0, index: k })
  }
  return out
}

const sliceName = (i) => `slice${String(i + 1).padStart(2, '0')}`
export const halfBeat = (bpm) => (bpm > 0 ? 30 / bpm : MIN_SLICE)

function toSlices(clean) {
  const out = []
  for (let i = 0; i < clean.length - 1; i++) out.push({ start: round6(clean[i]), end: round6(clean[i + 1]), name: sliceName(i) })
  return out
}

/** Whole-track slices from boundaries: a lead-in shorter than leadMin merges into slice01,
 *  a tail shorter than MIN_SLICE into the last slice. */
function boundsToSlices(bounds, duration, leadMin = MIN_SLICE) {
  const sorted = bounds.filter((b) => b >= 0 && b < duration).sort((a, b) => a - b)
  const clean = []
  for (const b of sorted) if (!clean.length || b - clean[clean.length - 1] >= MIN_SLICE) clean.push(b)
  if (!clean.length || clean[0] > leadMin) clean.unshift(0)
  else clean[0] = 0
  if (duration - clean[clean.length - 1] < MIN_SLICE && clean.length > 1) clean.pop()
  clean.push(duration)
  return toSlices(clean)
}

/** Grid times downbeat + n*step in [start, end). */
function gridPoints(bpm, downbeat, start, end, division) {
  const step = (division * 60) / bpm
  const out = []
  for (let n = Math.ceil((start - downbeat) / step - 1e-9); ; n++) {
    const t = downbeat + n * step
    if (t >= end) break
    out.push(t)
  }
  return out
}

/** Whole-track slices every `division` beats anchored on the downbeat. A lead-in before the
 *  first grid line shorter than half a beat is merged into slice01. */
export function gridSlices(bpm, downbeat, duration, division) {
  if (!(bpm > 0) || !(division > 0) || !(duration > 0)) return []
  return boundsToSlices(gridPoints(bpm, downbeat, 0, duration, division), duration, Math.max(MIN_SLICE, halfBeat(bpm)))
}

export function transientSlices(onsets, duration) {
  return boundsToSlices([...onsets], duration)
}

/** Nearest grid point (every `division` beats from the downbeat), clamped to [0, duration]. */
export function snap(t, bpm, downbeat, division, duration) {
  const step = (division * 60) / bpm
  const s = downbeat + Math.round((t - downbeat) / step) * step
  return Math.min(Math.max(s, 0), duration)
}

/** Split the slice containing t at t (manual chopping). Returns a new sorted array. */
export function splitAt(slices, t) {
  const i = slices.findIndex((s) => t > s.start + MIN_SLICE && t < s.end - MIN_SLICE)
  if (i < 0) return slices
  const s = slices[i]
  const a = { ...s, end: round6(t) }
  const b = { ...s, id: undefined, start: round6(t), name: undefined }
  return renumber([...slices.slice(0, i), a, b, ...slices.slice(i + 1)])
}

/** Give default-named slices sequential names (slice01...) in time order; keep custom names. */
export function renumber(slices) {
  return [...slices]
    .sort((a, b) => a.start - b.start)
    .map((s, i) => {
      const auto = !s.name || /^slice\d+$/.test(s.name)
      return { ...s, name: auto ? `slice${String(i + 1).padStart(2, '0')}` : s.name }
    })
}

/** Shift the downbeat by n beats, wrapped into [0, bar). */
export function shiftDownbeat(downbeat, bpm, nBeats) {
  const beat = 60 / bpm
  const bar = 4 * beat
  return round6((((downbeat + nBeats * beat) % bar) + bar) % bar)
}

// --- chopping a selection (mirrors engine/services/chopper.py) --------------------------------

/** Time of the first bar line at or after 0 s. */
export function firstDownbeat(bpm, downbeat) {
  if (!(bpm > 0)) return 0
  const bar = 240 / bpm
  return downbeat - Math.floor(downbeat / bar + 1e-9) * bar
}

/** Slices of [start, end) from interior boundaries: none shorter than MIN_SLICE, and a first
 *  slice before the track's first downbeat shorter than half a beat is merged into the next. */
function regionSlices(bounds, start, end, bpm = 0, downbeat = 0) {
  const inner = bounds.filter((b) => start < b && b < end).sort((a, b) => a - b)
  const clean = [start]
  for (const b of inner) if (b - clean[clean.length - 1] >= MIN_SLICE) clean.push(b)
  if (clean.length > 1 && end - clean[clean.length - 1] < MIN_SLICE) clean.pop()
  if (bpm > 0 && clean.length > 1) {
    const [a, b] = clean
    if (b <= firstDownbeat(bpm, downbeat) + 1e-6 && b - a < halfBeat(bpm)) clean.splice(1, 1)
  }
  clean.push(end)
  return toSlices(clean)
}

/** `count` equal slices of [start, end) (fewer if they'd be shorter than MIN_SLICE). */
export function evenSlices(start, end, count) {
  const length = end - start
  if (!(length > 0) || !(count > 0)) return []
  const n = Math.max(1, Math.min(Math.trunc(count), Math.floor(length / MIN_SLICE + 1e-9)))
  const step = length / n
  return Array.from({ length: n }, (_, i) => ({
    start: round6(start + i * step), end: round6(i === n - 1 ? end : start + (i + 1) * step), name: sliceName(i),
  }))
}

export function selectionGridSlices(bpm, downbeat, start, end, division) {
  if (!(bpm > 0) || !(division > 0) || !(end - start > 0)) return []
  return regionSlices(gridPoints(bpm, downbeat, start, end, division), start, end, bpm, downbeat)
}

/** At most `cap` slices from the strongest onsets inside [start, end); start is a boundary. */
export function selectionTransientSlices(onsets, strengths, start, end, cap = MAX_TRANSIENTS, bpm = 0, downbeat = 0) {
  if (!(end - start > 0)) return []
  const st = strengths ?? onsets.map(() => 1)
  const cand = onsets.map((t, i) => [t, st[i]]).filter(([t]) => start + MIN_SLICE <= t && t <= end - MIN_SLICE)
  cand.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0])) // strongest first
  const kept = []
  for (const [t] of cand) {
    if (kept.length >= Math.max(0, Math.trunc(cap) - 1)) break
    if (kept.every((k) => Math.abs(t - k) >= MIN_SLICE)) kept.push(t)
  }
  return regionSlices(kept, start, end, bpm, downbeat)
}

export function selectionSlices(mode, start, end, { bpm = 0, downbeat = 0, count = 16, division_beats: division = 1, onsets = [], strengths = null, cap = MAX_TRANSIENTS } = {}) {
  if (mode === 'even') return evenSlices(start, end, count)
  if (mode === 'grid') return selectionGridSlices(bpm, downbeat, start, end, division)
  if (mode === 'transients') return selectionTransientSlices(onsets, strengths, start, end, cap, bpm, downbeat)
  throw new Error(`unknown mode ${mode}`)
}
