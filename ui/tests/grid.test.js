import { describe, expect, it } from 'vitest'
import { DIVISIONS, divisionBeats, gridBeats, gridLines, gridSlices, renumber, shiftDownbeat, snap, splitAt, transientSlices } from '../src/lib/grid.js'

describe('grid math', () => {
  it('beat -> 1-bar slice boundaries at 120 BPM', () => {
    const s = gridSlices(120, 0, 12, 4)
    expect(s.map((x) => x.start)).toEqual([0, 2, 4, 6, 8, 10])
    expect(s.at(-1).end).toBe(12)
    expect(s.map((x) => x.name)).toEqual(['slice01', 'slice02', 'slice03', 'slice04', 'slice05', 'slice06'])
  })

  it('slice count = ceil(beats / division) for every division', () => {
    const beats = gridBeats(120, 0, 12).length
    expect(beats).toBe(24)
    for (const d of DIVISIONS) expect(gridSlices(120, 0, 12, d.beats)).toHaveLength(Math.ceil(beats / d.beats))
  })

  it('adds a lead-in slice before the downbeat, snaps a tiny one to 0', () => {
    expect(gridSlices(120, 0.3, 4.3, 4).map((x) => x.start)).toEqual([0, 0.3, 2.3])
    expect(gridSlices(120, 0.02, 4.02, 4).map((x) => x.start)).toEqual([0, 2.02])
  })

  it('merges a tiny tail into the previous slice', () => {
    const s = gridSlices(120, 0, 4.03, 4)
    expect(s).toHaveLength(2)
    expect(s.at(-1)).toMatchObject({ start: 2, end: 4.03 })
  })

  it('grid beats extend before the downbeat (negative k)', () => {
    expect(gridBeats(120, 1.25, 3)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75])
  })

  it('marks bar lines every 4 beats from the downbeat', () => {
    const lines = gridLines(120, 0.5, 4)
    expect(lines.filter((l) => l.bar).map((l) => l.t)).toEqual([0.5, 2.5])
  })

  it('snaps to the nearest grid point and clamps', () => {
    expect(snap(1.13, 120, 0, 1, 12)).toBeCloseTo(1.0)
    expect(snap(1.3, 120, 0, 1, 12)).toBeCloseTo(1.5)
    expect(snap(0.37, 120, 0, 0.25, 12)).toBeCloseTo(0.375)
    expect(snap(-3, 120, 0, 1, 12)).toBe(0)
    expect(snap(99, 120, 0, 1, 12)).toBe(12)
  })

  it('transient slices drop onsets closer than 50 ms', () => {
    expect(transientSlices([0.0, 0.5, 0.52, 1.0], 2).map((s) => s.start)).toEqual([0, 0.5, 1.0])
    expect(transientSlices([], 3)).toEqual([{ start: 0, end: 3, name: 'slice01' }])
  })

  it('splits the slice under the playhead and renumbers', () => {
    const out = splitAt([{ id: 'a', start: 0, end: 2, name: 'slice01' }, { id: 'b', start: 2, end: 4, name: 'kick' }], 1)
    expect(out.map((s) => [s.start, s.end, s.name])).toEqual([[0, 1, 'slice01'], [1, 2, 'slice02'], [2, 4, 'kick']])
    expect(splitAt(out, 1.01)).toBe(out) // too close to a boundary
  })

  it('renumber keeps custom names', () => {
    expect(renumber([{ start: 2, name: 'snare' }, { start: 0, name: 'slice07' }]).map((s) => s.name)).toEqual(['slice01', 'snare'])
  })

  it('shifts the downbeat by beats within one bar', () => {
    expect(shiftDownbeat(0, 120, 1)).toBe(0.5)
    expect(shiftDownbeat(0, 120, -1)).toBe(1.5)
    expect(shiftDownbeat(1.5, 120, 1)).toBe(0)
  })

  it('division ids', () => {
    expect(divisionBeats('1/4')).toBe(0.25)
    expect(divisionBeats('4bar')).toBe(16)
  })
})
