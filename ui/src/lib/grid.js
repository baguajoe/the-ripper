// Grid + slice math. Mirrors engine/services/chopper.py and analyzer.grid_beats exactly;
// spec in docs/formats.md (#grid, #slicing). Times are seconds.

export const MIN_SLICE = 0.05

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

function boundsToSlices(bounds, duration) {
  const sorted = bounds.filter((b) => b >= 0 && b < duration).sort((a, b) => a - b)
  const clean = []
  for (const b of sorted) if (!clean.length || b - clean[clean.length - 1] >= MIN_SLICE) clean.push(b)
  if (!clean.length || clean[0] > MIN_SLICE) clean.unshift(0)
  else clean[0] = 0
  if (duration - clean[clean.length - 1] < MIN_SLICE && clean.length > 1) clean.pop()
  clean.push(duration)
  const out = []
  for (let i = 0; i < clean.length - 1; i++) {
    out.push({ start: round6(clean[i]), end: round6(clean[i + 1]), name: `slice${String(i + 1).padStart(2, '0')}` })
  }
  return out
}

/** Slices every `division` beats anchored on the downbeat (+ a lead-in slice if > MIN_SLICE). */
export function gridSlices(bpm, downbeat, duration, division) {
  if (!(bpm > 0) || !(division > 0) || !(duration > 0)) return []
  const step = (division * 60) / bpm
  const bounds = []
  for (let n = Math.ceil((0 - downbeat) / step - 1e-9); ; n++) {
    const t = downbeat + n * step
    if (t >= duration) break
    bounds.push(t)
  }
  return boundsToSlices(bounds, duration)
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
