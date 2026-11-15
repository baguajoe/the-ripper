// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/dsp/engine.js'
import { Transport } from '../src/dsp/transport.js'
import { renderBeat } from '../src/dsp/render.js'
import { Vintage } from '../src/dsp/vintage.js'
import {
  PPQ, STEP, REPEAT_RATES, addHit, buildMidi, emptySeq, padNote, parseMidi, passEvents, quantizeTick, setStepVelocity,
  swingTick, ticksToSeconds, toggleAccent, toggleStep, unswingTick,
} from '../src/lib/sequence.js'

const SR = 44100

/** A source of single-sample impulses: slice k starts with a 1.0 sample (everything else 0). */
function impulses(n = 16, gap = 0.25) {
  const d = new Float32Array(Math.round(n * gap * SR))
  for (let k = 0; k < n; k++) d[Math.round(k * gap * SR)] = 1
  return { sr: SR, channels: [d, d.slice()] }
}
const program = (pads, mono = false) => ({ banks: [{ mono, pads }] })
const impulsePads = () => Array.from({ length: 16 }, (_, k) => ({ start: k * 0.25, end: k * 0.25 + 0.2, fadeOut: 0 }))

/** Frames where an impulse starts (first non-zero sample after silence). */
const onsets = (L) => {
  const out = []
  for (let i = 0; i < L.length; i++) if (L[i] !== 0 && (i === 0 || L[i - 1] === 0)) out.push(i)
  return out
}

function fourOnFloorPlus(seq, steps = 16) {
  let p = seq.patterns.A
  for (let s = 0; s < steps; s++) p = toggleStep(p, 0, s % 4, s)
  return { ...seq, patterns: { ...seq.patterns, A: p } }
}

describe('swing, quantize, steps', () => {
  it('swing warps every second 16th; 50% is straight', () => {
    expect(swingTick(STEP, 50)).toBe(STEP)
    expect(swingTick(STEP, 75)).toBe(360) // 75% of an 8th
    expect(swingTick(STEP, 66)).toBe(Math.round(0.66 * 480))
    expect(swingTick(0, 75)).toBe(0)
    expect(swingTick(480 + STEP, 60)).toBe(480 + 288)
    expect(swingTick(STEP / 2, 75)).toBe(180) // 32nds swing proportionally
    for (const s of [54, 62, 75]) for (const t of [0, 60, 240, 300, 479]) expect(Math.abs(unswingTick(swingTick(t, s), s) - t)).toBeLessThanOrEqual(1)
  })
  it('quantize and step edits', () => {
    expect(quantizeTick(250, '1/16')).toBe(240)
    expect(quantizeTick(370, '1/8')).toBe(480)
    expect(quantizeTick(170, '1/32')).toBe(120)
    expect(quantizeTick(170.4, 'off')).toBe(170)
    let p = toggleStep(emptySeq().patterns.A, 0, 3, 5)
    expect(p.notes).toEqual([{ bank: 0, pad: 3, tick: 1200, vel: 100, len: 240 }])
    p = setStepVelocity(p, 0, 3, 5, 40)
    expect(p.notes[0].vel).toBe(40)
    p = toggleAccent(p, 5)
    const seq = { ...emptySeq(), patterns: { ...emptySeq().patterns, A: p } }
    expect(passEvents(seq).events[0].vel).toBe(127) // accented
    expect(toggleStep(p, 0, 3, 5).notes).toEqual([])
    // recorded hits: quantized, wrapped into the pattern, no doubles on the same spot
    p = addHit(emptySeq().patterns.A, { bank: 1, pad: 2, tick: 3830, vel: 90 }, '1/16')
    expect(p.notes[0].tick).toBe(0)
    p = addHit(p, { bank: 1, pad: 2, tick: 10, vel: 50 }, '1/16')
    expect(p.notes).toHaveLength(1)
  })
})

describe('sequencer timing (rendered through the engine)', () => {
  for (const bpm of [90, 140]) {
    it(`every hit is within 1 ms of its grid time at ${bpm} BPM, with and without swing`, () => {
      for (const swing of [50, 62]) {
        const seq = { ...fourOnFloorPlus(emptySeq()), swing }
        const pass = { ...passEvents(seq), bpm, swing }
        const [L] = renderBeat({ main: impulses() }, program(impulsePads()), pass)
        const got = onsets(L)
        expect(got).toHaveLength(16)
        got.forEach((f, s) => {
          const grid = ticksToSeconds(swingTick(s * STEP, swing), bpm)
          expect(Math.abs(f / SR - grid)).toBeLessThan(0.001)
        })
        expect(L.length).toBe(Math.round(ticksToSeconds(16 * STEP, bpm) * SR))
      }
    })
  }

  it('pattern chaining plays patterns back to back in song order', () => {
    let seq = emptySeq()
    seq = { ...seq, patterns: { ...seq.patterns, A: toggleStep(seq.patterns.A, 0, 0, 0), B: toggleStep({ ...seq.patterns.B, steps: 32 }, 0, 1, 4) } }
    seq = { ...seq, song: ['A', 'B', 'A'], mode: 'song' }
    const pass = passEvents(seq)
    expect(pass.length).toBe((16 + 32 + 16) * STEP)
    expect(pass.events.map((e) => [e.tick, e.pad, e.pattern])).toEqual([[0, 0, 'A'], [16 * STEP + 4 * STEP, 1, 'B'], [48 * STEP, 0, 'A']])
    const [L] = renderBeat({ main: impulses() }, program(impulsePads()), { ...pass, bpm: 120, swing: 50 })
    expect(onsets(L).map((f) => f / SR)).toEqual([0, (20 * 0.125), 48 * 0.125].map((t) => expect.closeTo(t, 4)))
  })

  it('looping, count-in and metronome in the live transport', () => {
    const eng = new Engine(SR)
    eng.setSource('main', impulses().channels, SR)
    const tr = new Transport(eng)
    tr.setProgram(program(impulsePads()))
    const seq = fourOnFloorPlus(emptySeq())
    tr.setPass({ ...passEvents(seq), bpm: 120, swing: 50 }, true)
    const fired = []
    tr.onFire = (e) => fired.push(e.frame)
    tr.play(1000, { countIn: true, metronome: true })
    eng.render(Math.round(SR * 2 + 1000 + SR * 4.1)) // count-in bar (2 s) + 2 passes + 0.1 s
    const bar = Math.round(2 * SR)
    expect(fired[0]).toBe(1000 + bar)
    expect(fired).toHaveLength(32 + 1) // two passes + the third pass's first hit
    expect(fired[16] - fired[0]).toBe(Math.round(2 * SR))
  })
})

describe('note repeat', () => {
  for (const [name, rate] of Object.entries(REPEAT_RATES)) {
    it(`${name} repeats at its rate (free-running and on the grid)`, () => {
      const eng = new Engine(SR)
      eng.setSource('main', impulses().channels, SR)
      const tr = new Transport(eng)
      tr.setProgram(program(impulsePads()))
      tr.setPass({ events: [], length: 16 * STEP, bpm: 120, swing: 50 }, true)
      const fired = []
      tr.onFire = (e) => fired.push(e.frame)
      tr.setRepeat({ bank: 0, pad: 0, vel: 100, rate }, 0)
      eng.render(SR) // 1 s at 120 BPM = 2 beats
      const period = ticksToSeconds(rate, 120) * SR
      expect(fired.length).toBe(Math.ceil(SR / period - 1e-9))
      fired.forEach((f, k) => expect(Math.abs(f - k * period)).toBeLessThanOrEqual(0.5))
      // on the grid while playing: pressed mid-step, the first repeat waits for the next grid line
      const eng2 = new Engine(SR)
      eng2.setSource('main', impulses().channels, SR)
      const tr2 = new Transport(eng2)
      tr2.setProgram(program(impulsePads()))
      tr2.setPass({ events: [], length: 16 * STEP, bpm: 120, swing: 50 }, true)
      const f2 = []
      tr2.onFire = (e) => f2.push(e.frame)
      tr2.play(0)
      eng2.render(1000)
      tr2.setRepeat({ bank: 0, pad: 0, vel: 100, rate }, 1000)
      eng2.render(SR)
      expect(Math.abs(f2[0] - period)).toBeLessThanOrEqual(0.5)
    })
  }
})

describe('MIDI export', () => {
  it('has exactly the ticks, notes and velocities the sequencer plays (swing applied)', () => {
    let seq = { ...fourOnFloorPlus(emptySeq()), swing: 58 }
    seq = { ...seq, patterns: { ...seq.patterns, A: setStepVelocity(seq.patterns.A, 0, 1, 1, 77) } }
    const bpm = 93.5
    const pass = passEvents(seq)
    const midi = parseMidi(buildMidi(pass, bpm))
    expect(midi.ppq).toBe(PPQ)
    expect(Math.abs(60_000_000 / midi.tempo - bpm)).toBeLessThan(0.001)
    expect(midi.notes.map((n) => [n.tick, n.note, n.vel])).toEqual(pass.events.map((e) => [e.tick, padNote(e.bank, e.pad), e.vel]))
    expect(midi.notes[1].vel).toBe(77)
    expect(padNote(0, 0)).toBe(36) // C1
    // and the sequencer fires each note on the frame of its MIDI time
    const eng = new Engine(SR)
    eng.setSource('main', impulses().channels, SR)
    const tr = new Transport(eng)
    tr.setProgram(program(impulsePads()))
    tr.setPass({ ...pass, bpm, swing: 58 }, false)
    const fired = []
    tr.onFire = (e) => fired.push(e.frame)
    tr.play(0)
    eng.render(Math.round(SR * 3))
    const secPerTick = midi.tempo / 1e6 / midi.ppq
    fired.forEach((f, i) => expect(Math.abs(f - midi.notes[i].tick * secPerTick * SR)).toBeLessThanOrEqual(0.5))
  })
})

describe('vintage', () => {
  const music = () => {
    const n = SR * 2
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) a[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.39 * Math.sin((2 * Math.PI * 9100 * i) / SR)
    return a
  }
  for (const mode of ['12bit', '16bit']) {
    it(`${mode}: differs from the original, same length, no clipping`, () => {
      const L = music()
      const R = music()
      const orig = L.slice()
      const v = new Vintage(SR, mode)
      for (let i = 0; i < L.length; i += 128) v.process(L, R, Math.min(128, L.length - i), i)
      expect(L.length).toBe(orig.length)
      let diff = 0
      let peak = 0
      for (let i = 0; i < L.length; i++) { diff = Math.max(diff, Math.abs(L[i] - orig[i])); peak = Math.max(peak, Math.abs(L[i])) }
      expect(diff).toBeGreaterThan(0.01)
      expect(peak).toBeLessThan(1)
    })
  }
  it('is block-size independent (live and offline renders match)', () => {
    const run = (block) => {
      const L = music()
      const R = music()
      const v = new Vintage(SR, '12bit')
      for (let i = 0; i < L.length; i += block) v.process(L, R, Math.min(block, L.length - i), i)
      return L
    }
    const a = run(128)
    const b = run(77)
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`differs at ${i}`)
  })
})
