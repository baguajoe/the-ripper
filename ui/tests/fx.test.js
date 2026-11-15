// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/dsp/engine.js'
import { renderPad, renderBeat } from '../src/dsp/render.js'
import { FxChain, delaySeconds, fxTail } from '../src/dsp/fx.js'
import { applyProgram } from '../src/dsp/program.js'
import { Transport } from '../src/dsp/transport.js'
import { emptySeq, passEvents, toggleStep } from '../src/lib/sequence.js'

const SR = 44100
const impulseSrc = () => { const d = new Float32Array(SR); d[0] = 1; return { sr: SR, channels: [d, d.slice()] } }
const noiseSrc = (seconds = 2, amp = 0.8) => {
  let x = 12345
  const d = new Float32Array(seconds * SR)
  for (let i = 0; i < d.length; i++) { x = (x * 1103515245 + 12345) % 2147483648; d[i] = amp * (x / 1073741824 - 1) }
  return { sr: SR, channels: [d, d.slice()] }
}
const peakAfter = (d, from) => { let p = 0; for (let i = from; i < d.length; i++) p = Math.max(p, Math.abs(d[i])); return p }

describe('effects', () => {
  it('tempo-synced delay: echoes land exactly on the note value at the tempo', () => {
    for (const [time, bpm] of [['1/8', 120], ['1/4', 93], ['1/8.', 140], ['1/16', 87]]) {
      const fx = { delay: { on: true, time, feedback: 0.5, mix: 1 } }
      const [L, R] = renderPad(impulseSrc(), { start: 0, end: 0.01, fadeOut: 0, fx }, { bpm, tail: fxTail(fx, bpm) })
      const d = Math.round(delaySeconds(time, bpm) * SR)
      // ping-pong: 1st echo on the right of the left input (both channels carry the impulse here)
      expect(L[d]).toBeCloseTo(1, 6)
      expect(R[d]).toBeCloseTo(1, 6)
      expect(L[2 * d]).toBeCloseTo(0.5, 6) // feedback
      for (let i = 1; i < d; i++) expect(L[i]).toBe(0)
    }
  })

  it('reverb adds a decaying tail; exports include it', () => {
    const fx = { reverb: { on: true, size: 0.7, mix: 0.5 } }
    const s = { start: 0, end: 0.2, fx }
    const tail = fxTail(fx, 120)
    expect(tail).toBeGreaterThan(2)
    const [L] = renderPad(noiseSrc(), s, { tail })
    expect(L.length).toBe(Math.round(0.2 * SR) + Math.round(tail * SR))
    expect(peakAfter(L, Math.round(0.25 * SR))).toBeGreaterThan(0.01) // still ringing after the dry sound
    expect(peakAfter(L, L.length - 100)).toBeLessThan(0.01) // and decayed by the end
  })

  it('drive saturates (bounded), wet/dry mixes', () => {
    const src = noiseSrc(1, 0.9)
    const dry = renderPad(src, { start: 0, end: 0.5 })[0]
    const wet = renderPad(src, { start: 0, end: 0.5, fx: { drive: { on: true, amount: 1, mix: 1 } } })[0]
    const half = renderPad(src, { start: 0, end: 0.5, fx: { drive: { on: true, amount: 1, mix: 0.5 } } })[0]
    expect(peakAfter(wet, 0)).toBeLessThanOrEqual(0.8 + 1e-6)
    let d = 0
    for (let i = 0; i < dry.length; i++) { d = Math.max(d, Math.abs(wet[i] - dry[i])); expect(half[i]).toBeCloseTo((dry[i] + wet[i]) / 2, 5) }
    expect(d).toBeGreaterThan(0.05)
  })

  it('master compressor turns loud material down (and makeup up)', () => {
    const c = new FxChain(SR, { master: true }).configure({ comp: { on: true, threshold: -20, ratio: 8, attack: 0.001, release: 0.1, makeup: 0, mix: 1 } })
    const L = new Float32Array(SR).fill(0.9)
    const R = L.slice()
    c.process(L, R, SR)
    expect(L[SR - 1]).toBeLessThan(0.2) // ~ -20 dB + (19 dB over / 8)
    expect(L[SR - 1]).toBeGreaterThan(0.08)
  })

  it('pads with effects + master render identically in any block size, across idle gaps', () => {
    let seq = emptySeq()
    let p = seq.patterns.A
    for (const st of [0, 7]) p = toggleStep(p, 0, 0, st)
    p = toggleStep(p, 0, 1, 12)
    seq = { ...seq, patterns: { ...seq.patterns, A: { ...p, steps: 64 } } }
    const prog = {
      bpm: 120,
      master: { reverb: { on: true, size: 0.3, mix: 0.2 }, comp: { on: true, threshold: -12, ratio: 3 } },
      banks: [{ mono: false, pads: [
        { start: 0, end: 0.1, fx: { delay: { on: true, time: '1/16', feedback: 0.2, mix: 0.5 }, reverb: { on: true, size: 0.2, mix: 0.3 } } },
        { start: 0.5, end: 0.6, fx: { drive: { on: true, amount: 0.5 } } },
      ] }],
    }
    const pass = { ...passEvents(seq), bpm: 120, swing: 50 }
    const render = (block) => {
      const eng = new Engine(SR)
      eng.setSource('main', noiseSrc().channels, SR)
      const tr = new Transport(eng)
      applyProgram(eng, tr, prog)
      tr.setPass(pass, false)
      tr.play(0)
      return eng.render(tr.passFrames, block)[0]
    }
    const a = render(128)
    const b = render(53)
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`differs at ${i}: ${a[i]} vs ${b[i]}`)
    const c = renderBeat({ main: noiseSrc() }, prog, pass)[0]
    for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) throw new Error(`renderBeat differs at ${i}`)
  })
})
