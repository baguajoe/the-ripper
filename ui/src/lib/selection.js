// Selections on the waveform, in bars. Bar 1 starts at the downbeat; bars before it are 0, -1…
import { MIN_SLICE } from './grid.js'

const round6 = (x) => Math.round(x * 1e6) / 1e6
export const barLength = (bpm) => 240 / bpm

/** 1-based bar number containing t. */
export function barAt(t, bpm, downbeat) {
  return Math.floor((t - downbeat) / barLength(bpm) + 1e-9) + 1
}

export const barStart = (n, bpm, downbeat) => downbeat + (n - 1) * barLength(bpm)

/** "bar.beat" (beat 1-4, fractional beats shown to one decimal), e.g. "5.1" or "5.2.5". */
export function formatBarPos(t, bpm, downbeat) {
  const beats = (t - downbeat) / (60 / bpm)
  const bar = Math.floor(beats / 4 + 1e-9)
  const beat = beats - bar * 4
  const b = Math.abs(beat - Math.round(beat)) < 0.02 ? String(Math.round(beat) + 1) : (beat + 1).toFixed(1)
  return `${bar + 1}.${b}`
}

/** The first bar line at or after 0 s that is before `duration`. */
function firstBarLine(bpm, downbeat) {
  const bar = barLength(bpm)
  return downbeat + Math.ceil((0 - downbeat) / bar - 1e-9) * bar
}

/** `n` bars starting at the bar line at (or before) t. A bar that would start before 0 s
 *  starts at the first bar line instead (no pickup fragment). */
export function barsFrom(t, n, bpm, downbeat, duration) {
  if (!(bpm > 0) || !(duration > 0)) return null
  const bar = barLength(bpm)
  let start = barStart(barAt(t, bpm, downbeat), bpm, downbeat)
  if (start < -1e-9) start = firstBarLine(bpm, downbeat)
  if (start >= duration - MIN_SLICE) start = Math.max(0, start - n * bar)
  const end = Math.min(duration, start + n * bar)
  if (end - start < MIN_SLICE) return null
  return { start: round6(Math.max(0, start)), end: round6(end) }
}

/** Bars a..b (inclusive, either order) as a selection. */
export function barRange(a, b, bpm, downbeat, duration) {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const start = Math.max(0, barStart(lo, bpm, downbeat))
  const end = Math.min(duration, barStart(hi + 1, bpm, downbeat))
  return end - start >= MIN_SLICE ? { start: round6(start), end: round6(end) } : null
}

/** Snap a dragged selection to the grid (every `division` beats from the downbeat). An edge
 *  that snaps to before 0 s goes to the first grid line instead. */
export function snapSelection({ start, end }, bpm, downbeat, division, duration) {
  const step = (division * 60) / bpm
  const snapT = (t) => {
    let s = downbeat + Math.round((t - downbeat) / step) * step
    if (s < -1e-9) s = downbeat + Math.ceil((0 - downbeat) / step - 1e-9) * step
    return Math.min(Math.max(s, 0), duration)
  }
  let a = snapT(Math.min(start, end))
  let b = snapT(Math.max(start, end))
  if (b - a < step - 1e-9) b = Math.min(duration, a + step)
  if (b - a < MIN_SLICE) return null
  return { start: round6(a), end: round6(b) }
}

/** Length of a selection in bars (for display). */
export const selectionBars = (sel, bpm) => (sel ? (sel.end - sel.start) / barLength(bpm) : 0)
