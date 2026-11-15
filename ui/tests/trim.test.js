// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isZeroCrossing, moveEdge, monoOf, nudgeStep, parseTime, setRange, snapEdge, snapTransient, snapZero } from '../src/lib/trim.js'

const SR = 44100
function noisySine(seconds = 1) {
  const n = Math.round(seconds * SR)
  const a = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    a[i] = 0.6 * Math.sin((2 * Math.PI * 97.3 * i) / SR + 0.4) + 0.2 * Math.sin((2 * Math.PI * 1234 * i) / SR)
    b[i] = 0.5 * Math.sin((2 * Math.PI * 97.3 * i) / SR + 0.5)
  }
  return { sr: SR, channels: [a, b] }
}

describe('zero-crossing snap', () => {
  const src = noisySine()
  it('lands on a zero crossing near the target', () => {
    const d = monoOf(src)
    for (const t of [0.1234, 0.3, 0.55555, 0.9]) {
      const z = snapZero(src, t)
      const j = Math.round(z * SR)
      expect(Math.abs(j / SR - z)).toBeLessThan(1e-12) // a whole sample
      expect(isZeroCrossing(d, j)).toBe(true)
      expect(Math.abs(z - t)).toBeLessThanOrEqual(0.005 + 1 / SR)
    }
  })
  it('directional search for nudges', () => {
    const t = snapZero(src, 0.5)
    const next = snapZero(src, t + 0.001, { dir: 1, after: t })
    expect(next).toBeGreaterThan(t)
    const prev = snapZero(src, t - 0.001, { dir: -1, after: t })
    expect(prev).toBeLessThan(t)
  })
  it('snapEdge combines grid / transient with zero crossing', () => {
    const ctx = { src, onsets: [0.2, 0.61], bpm: 120, downbeat: 0, divisionBeats: 1, duration: 1 }
    expect(snapEdge(0.58, { snap: 'transient', zero: false }, ctx)).toBe(0.61)
    expect(snapEdge(0.58, { snap: 'grid', zero: false }, ctx)).toBe(0.5)
    const z = snapEdge(0.58, { snap: 'grid', zero: true }, ctx)
    expect(Math.abs(z - 0.5)).toBeLessThan(0.0051)
    expect(isZeroCrossing(monoOf(src), Math.round(z * SR))).toBe(true)
    expect(snapEdge(0.58, { snap: 'off', zero: false }, ctx)).toBe(0.58)
    expect(snapTransient([], 0.3)).toBe(0.3)
  })
})

describe('moving edges', () => {
  const slices = [{ id: 'a', start: 0, end: 1 }, { id: 'b', start: 1, end: 2 }, { id: 'c', start: 2, end: 3 }]
  it('without link only the slice changes', () => {
    const r = moveEdge(slices, 'b', 'end', 2.25)
    expect(r.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 2.25], [2, 3]])
  })
  it('link neighbors keeps slices contiguous', () => {
    let r = moveEdge(slices, 'b', 'end', 2.25, { link: true })
    expect(r.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 2.25], [2.25, 3]])
    r = moveEdge(r, 'b', 'start', 0.5, { link: true })
    expect(r.map((s) => [s.start, s.end])).toEqual([[0, 0.5], [0.5, 2.25], [2.25, 3]])
    for (let i = 1; i < r.length; i++) expect(r[i].start).toBe(r[i - 1].end)
    // a neighbour never shrinks below the minimum slice
    r = moveEdge(slices, 'b', 'end', 9, { link: true })
    expect(r[2].start).toBeCloseTo(3 - 0.05, 9)
  })
  it('keeps a minimum length and typed ranges apply', () => {
    expect(moveEdge(slices, 'a', 'end', -1)[0].end).toBeCloseTo(0.05, 9)
    const r = setRange(slices, 'b', 1.2, 1.7)
    expect([r[1].start, r[1].end]).toEqual([1.2, 1.7])
    const r2 = setRange(slices, 'b', 0.8, 2.4, { link: true })
    expect(r2.map((s) => [s.start, s.end])).toEqual([[0, 0.8], [0.8, 2.4], [2.4, 3]])
  })
  it('nudge steps and time parsing', () => {
    expect(nudgeStep({}, 120)).toBe(0.001)
    expect(nudgeStep({ shiftKey: true }, 120)).toBe(0.01)
    expect(nudgeStep({ ctrlKey: true }, 120)).toBe(0.5)
    expect(parseTime('1.25')).toBe(1.25)
    expect(parseTime('1:02.5')).toBe(62.5)
    expect(parseTime('x')).toBe(null)
  })
})
