import { describe, expect, it } from 'vitest'
import { clearPad, emptyProgram, padSettings, padSlice, pastePad, placeChop, swapPads, updateSlices } from '../src/lib/program.js'

const chop = (n) => placeChop(emptyProgram(), Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1 })), { target: 0 }).program

describe('pad management', () => {
  it('a chop puts slices on pads in time order', () => {
    const p = chop(4)
    expect(p.banks[0].slices.map((s) => s.pad)).toEqual([0, 1, 2, 3])
    expect(padSlice(p.banks[0], 2).start).toBe(2)
    expect(p.banks[0].ordered).toBe(true)
  })
  it('swap exchanges pads (also with an empty pad) and keeps them through later edits', () => {
    let p = swapPads(chop(4), 0, 0, 3)
    expect(padSlice(p.banks[0], 3).start).toBe(0)
    expect(padSlice(p.banks[0], 0).start).toBe(3)
    expect(p.banks[0].ordered).toBe(false)
    p = swapPads(p, 0, 1, 9)
    expect(padSlice(p.banks[0], 1)).toBeUndefined()
    expect(padSlice(p.banks[0], 9).start).toBe(1)
    // editing a slice's times doesn't move pads any more
    p = updateSlices(p, 0, (list) => list.map((s) => (s.start === 3 ? { ...s, start: 0.5, end: 0.9 } : s)))
    expect(padSlice(p.banks[0], 0).start).toBe(0.5)
    // a new slice takes the lowest free pad
    p = updateSlices(p, 0, (list) => [...list, { id: 'new', start: 7, end: 8 }])
    expect(p.banks[0].slices.find((s) => s.id === 'new').pad).toBe(1)
  })
  it('paste copies every setting onto a pad (new id), clear empties one pad', () => {
    let p = chop(3)
    const src = { ...padSlice(p.banks[0], 1), tune: 5, color: '#ff5c39', name: 'Kick' }
    p = pastePad(p, 1, 4, padSettings(src))
    const c = padSlice(p.banks[1], 4)
    expect([c.start, c.tune, c.color, c.name]).toEqual([1, 5, '#ff5c39', 'Kick'])
    expect(c.id).not.toBe(src.id)
    p = pastePad(p, 0, 0, padSettings(src)) // replaces what was there
    expect(p.banks[0].slices).toHaveLength(3)
    expect(padSlice(p.banks[0], 0).tune).toBe(5)
    p = clearPad(p, 0, 0)
    expect(padSlice(p.banks[0], 0)).toBeUndefined()
    expect(p.banks[0].slices).toHaveLength(2)
  })
})
