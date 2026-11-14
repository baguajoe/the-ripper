import { describe, expect, it } from 'vitest'
import { evenSlices, gridSlices, MIN_SLICE, selectionSlices } from '../src/lib/grid.js'
import { barAt, barRange, barsFrom, formatBarPos, snapSelection } from '../src/lib/selection.js'
import { chopBanks, emptyProgram, nextEmptyBank, placeChop, renumberBank, updateBank, updateSlices } from '../src/lib/program.js'
import { canRedo, canUndo, initHistory, push, redo, undo } from '../src/lib/history.js'
import { CUT_FADE, SlicePlayer } from '../src/lib/slicePlayer.js'

const BAR128 = 240 / 128

describe('selection chopping', () => {
  it('4 bars at 128 BPM chopped Even 16 = exactly 16 equal slices in Bank A', () => {
    const sel = barsFrom(0, 4, 128, 0.2, 30)
    expect(sel).toEqual({ start: 0.2, end: 0.2 + 4 * BAR128 })
    const sl = selectionSlices('even', sel.start, sel.end, { count: 16 })
    const { program, banks } = placeChop(emptyProgram(), sl, { target: 0, chop: { id: 'c1', settings: { mode: 'even', count: 16 } } })
    expect(banks).toEqual([0])
    const a = program.banks[0].slices
    expect(a).toHaveLength(16)
    for (const s of a) expect(s.end - s.start).toBeCloseTo((4 * BAR128) / 16, 5)
    expect(a.map((s) => s.name)).toEqual(Array.from({ length: 16 }, (_, i) => `slice${String(i + 1).padStart(2, '0')}`))
    expect(program.banks.slice(1).every((b) => b.slices.length === 0)).toBe(true)
  })

  it('grid and transients only chop inside the selection', () => {
    const g = selectionSlices('grid', 4, 8, { bpm: 120, downbeat: 0, division_beats: 1 })
    expect(g).toHaveLength(8)
    expect([g[0].start, g.at(-1).end]).toEqual([4, 8])
    const t = selectionSlices('transients', 1, 3, { onsets: [0.5, 1.5, 2.2, 2.6, 3.5], strengths: [1, 0.2, 0.9, 0.5, 1], cap: 3 })
    expect(t.map((s) => s.start)).toEqual([1, 2.2, 2.6])
    expect(t.at(-1).end).toBe(3)
  })

  it('caps transients at 16 by default', () => {
    const onsets = Array.from({ length: 50 }, (_, i) => 0.1 * (i + 1))
    expect(selectionSlices('transients', 0, 6, { onsets, strengths: onsets.map((_, i) => i % 7) })).toHaveLength(16)
  })

  it('merges a pickup shorter than half a beat (the 0.1 s slice01)', () => {
    expect(gridSlices(120, 0.1, 12, 4)[0]).toEqual({ start: 0, end: 2.1, name: 'slice01' })
    // default selection from a playhead at 0 starts on the first downbeat, not at 0
    expect(barsFrom(0, 4, 120, 0.1, 30)).toEqual({ start: 0.1, end: 8.1 })
  })

  it('never makes a slice shorter than 50 ms', () => {
    const s = evenSlices(0, 0.3, 32)
    expect(s).toHaveLength(6)
    for (const x of s) expect(x.end - x.start).toBeGreaterThanOrEqual(MIN_SLICE - 1e-9)
  })
})

describe('selecting bars', () => {
  it('bar numbers, bar ranges and n bars from the playhead', () => {
    expect(barAt(0.2, 120, 0.2)).toBe(1)
    expect(barAt(2.19, 120, 0.2)).toBe(1)
    expect(barAt(2.2, 120, 0.2)).toBe(2)
    expect(barRange(3, 2, 120, 0, 30)).toEqual({ start: 2, end: 6 })
    expect(barsFrom(5.3, 2, 120, 0, 30)).toEqual({ start: 4, end: 8 })
    expect(barsFrom(5.3, 8, 120, 0, 12)).toEqual({ start: 4, end: 12 }) // clamped to the track
    expect(formatBarPos(4, 120, 0)).toBe('3.1')
    expect(formatBarPos(4.5, 120, 0)).toBe('3.2')
  })

  it('snaps a dragged selection to the grid', () => {
    expect(snapSelection({ start: 1.9, end: 6.2 }, 120, 0, 4, 30)).toEqual({ start: 2, end: 6 })
    expect(snapSelection({ start: 6.2, end: 1.9 }, 120, 0, 1, 30)).toEqual({ start: 2, end: 6 })
    expect(snapSelection({ start: 0, end: 4 }, 120, 0.1, 4, 30)).toEqual({ start: 0.1, end: 4.1 })
    expect(snapSelection({ start: 2.05, end: 2.1 }, 120, 0, 1, 30)).toEqual({ start: 2, end: 2.5 }) // at least one step
  })
})

describe('pad banks', () => {
  const sl = (n) => Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1 }))

  it('new chops go into the next empty bank; big chops span banks', () => {
    let p = placeChop(emptyProgram(), sl(16), { target: 0, chop: { id: 'a', settings: {} } }).program
    expect(nextEmptyBank(p)).toBe(1)
    const r = placeChop(p, sl(32), { target: nextEmptyBank(p, 2), chop: { id: 'b', settings: {} } })
    expect(r.banks).toEqual([1, 2])
    p = r.program
    expect(chopBanks(p, 2)).toEqual([1, 2])
    expect(nextEmptyBank(p)).toBe(3)
  })

  it('re-chopping replaces that chop\'s banks only', () => {
    let p = placeChop(emptyProgram(), sl(32), { target: 0, chop: { id: 'a', settings: {} } }).program
    p = placeChop(p, sl(4), { target: 2, chop: { id: 'b', settings: {} } }).program
    p = placeChop(p, sl(8), { target: 0, chop: { id: 'a2', settings: {} } }).program
    expect(p.banks.map((b) => b.slices.length).slice(0, 3)).toEqual([8, 0, 4])
  })

  it('respects the bank limit (no Pro: A–B) and reports what did not fit', () => {
    const r = placeChop(emptyProgram(), sl(40), { target: 0, limit: 2, chop: { id: 'a', settings: {} } })
    expect(r.banks).toEqual([0, 1])
    expect(r.dropped).toBe(8)
  })

  it('keeps each bank\'s Mono setting across chops, defaulting to Mono', () => {
    let p = emptyProgram()
    expect(p.banks.every((b) => b.mono)).toBe(true)
    p = updateBank(p, 0, { mono: false })
    p = placeChop(p, sl(3), { target: 0, chop: { id: 'a', settings: {} } }).program
    expect(p.banks[0].mono).toBe(false)
  })

  it('slice edits stay time-ordered and numbered, max 16', () => {
    let p = placeChop(emptyProgram(), sl(3), { target: 0 }).program
    p = updateSlices(p, 0, (s) => [...s, { start: 0.5, end: 0.9 }])
    expect(p.banks[0].slices.map((s) => s.name)).toEqual(['slice01', 'slice02', 'slice03', 'slice04'])
    expect(renumberBank([{ start: 1, name: 'snare' }, { start: 0, name: 'slice9' }]).map((s) => s.name)).toEqual(['slice01', 'snare'])
    p = updateSlices(p, 0, (s) => [...s, ...sl(20)])
    expect(p.banks[0].slices).toHaveLength(16)
  })
})

describe('undo / redo', () => {
  it('undoes and redoes, and coalesces bursts of the same edit', () => {
    let h = initHistory(1)
    h = push(h, 2, null, 0)
    h = push(h, 3, 'name', 1000)
    h = push(h, 4, 'name', 1500) // same key within ~1 s: one step
    expect(h.past).toEqual([1, 2])
    h = undo(h)
    expect(h.present).toBe(2)
    h = undo(h)
    expect(h.present).toBe(1)
    expect(canUndo(h)).toBe(false)
    h = redo(h)
    expect(h.present).toBe(2)
    h = push(h, 9, null, 5000)
    expect(canRedo(h)).toBe(false)
  })
})

// --- Web Audio fake: records gain automation and start/stop times ---------------------------
function fakeCtx() {
  const param = () => {
    const events = []
    return {
      value: 1, events,
      setValueAtTime: (v, t) => events.push(['set', v, t]),
      linearRampToValueAtTime: (v, t) => events.push(['ramp', v, t]),
      cancelAndHoldAtTime: (t) => events.push(['hold', t]),
      cancelScheduledValues: (t) => events.push(['cancel', t]),
    }
  }
  const node = () => ({ connect: (n) => n })
  const sources = []
  const ctx = {
    currentTime: 10, state: 'running', destination: {}, sources,
    resume: () => {},
    createGain: () => ({ ...node(), gain: param() }),
    createBufferSource: () => {
      const s = { ...node(), started: null, stopped: null }
      s.connect = (g) => { s.gain = g; return g }
      s.start = (t, off, dur) => { s.started = [t, off, dur] }
      s.stop = (t) => { s.stopped = t }
      sources.push(s)
      return s
    },
  }
  return ctx
}

describe('pads like an MPC', () => {
  const buf = { duration: 10, numberOfChannels: 2, sampleRate: 44100, length: 441000 }
  const s1 = { start: 0, end: 2 }
  const s2 = { start: 2, end: 4 }

  it('mono bank: pad 2 cuts pad 1 with a 5 ms fade', () => {
    const ctx = fakeCtx()
    const p = new SlicePlayer(ctx)
    p.buffer = buf
    p.play(s1, { bank: 0, pad: 0, mono: true, when: 10 })
    p.play(s2, { bank: 0, pad: 1, mono: true, when: 10.5 })
    const [a, b] = ctx.sources
    // the envelope is pinned at the cut (level 1, mid-slice), then ramps to 0 over 5 ms
    const ev = a.gain.gain.events
    expect(ev.slice(-3)).toEqual([['cancel', 10.5], ['set', 1, 10.5], ['ramp', 0, 10.5 + CUT_FADE]])
    expect(a.stopped).toBeLessThanOrEqual(10.5 + 0.01)
    expect(b.stopped).toBeNull()
  })

  it('poly bank: pads ring out; other banks are not cut', () => {
    const ctx = fakeCtx()
    const p = new SlicePlayer(ctx)
    p.buffer = buf
    p.play(s1, { bank: 0, pad: 0, mono: false })
    p.play(s2, { bank: 0, pad: 1, mono: false })
    p.play(s2, { bank: 1, pad: 0, mono: true })
    expect(ctx.sources.map((s) => s.stopped)).toEqual([null, null, null])
  })

  it('choke flags cut each other even in a poly bank', () => {
    const ctx = fakeCtx()
    const p = new SlicePlayer(ctx)
    p.buffer = buf
    p.play({ ...s1, choke: true }, { bank: 0, pad: 0 })
    p.play({ ...s2, choke: true }, { bank: 0, pad: 1 })
    expect(ctx.sources[0].stopped).not.toBeNull()
  })

  it('note-on pads stop on release; one-shots do not', () => {
    const ctx = fakeCtx()
    const p = new SlicePlayer(ctx)
    p.buffer = buf
    p.play({ ...s1, padMode: 'noteon', fadeOut: 0.5 }, { bank: 0, pad: 0 })
    p.play({ ...s2 }, { bank: 0, pad: 1 })
    p.release(0, 0)
    p.release(0, 1)
    expect(ctx.sources[0].stopped).toBeCloseTo(10 + CUT_FADE + 0.001)
    expect(ctx.sources[1].stopped).toBeNull()
    // a cut inside the fade-out starts from the faded level, not from full volume
    ctx.currentTime = 11.75
    const v = p.play({ ...s1, fadeOut: 0.5 }, { bank: 2, pad: 0, when: 11 })
    v.stop(12.75)
    expect(ctx.sources[2].gain.gain.events).toContainEqual(['set', 0.5, 12.75])
  })

  it('stopAll fades everything out', () => {
    const ctx = fakeCtx()
    const p = new SlicePlayer(ctx)
    p.buffer = buf
    p.play(s1, { bank: 0, pad: 0 })
    p.play(s2, { bank: 3, pad: 4 })
    p.stopAll()
    expect(ctx.sources.every((s) => s.stopped !== null)).toBe(true)
    expect(p.playing).toBe(0)
  })
})
