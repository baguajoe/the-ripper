// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/dsp/engine.js'
import { renderPad, voiceFrames } from '../src/dsp/render.js'
import { pyRound } from '../src/dsp/voice.js'
import { envelopeAt, isShaped, pitchRatio, shaping, velocityCutoff, velocityGain } from '../src/dsp/params.js'

const SR = 44100

export function sine(freq, seconds, { sr = SR, amp = 0.5, stereo = true } = {}) {
  const n = Math.round(seconds * sr)
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return { sr, channels: stereo ? [d, d.slice()] : [d] }
}

/** Frequency from upward zero crossings (interpolated) over a buffer region. */
export function freqOf(d, sr, a = 0, b = d.length) {
  const xs = []
  for (let i = a + 1; i < b; i++) if (d[i - 1] < 0 && d[i] >= 0) xs.push(i - 1 + d[i - 1] / (d[i - 1] - d[i]))
  return ((xs.length - 1) * sr) / (xs[xs.length - 1] - xs[0])
}

const rms = (d, a = 0, b = d.length) => {
  let s = 0
  for (let i = a; i < b; i++) s += d[i] * d[i]
  return Math.sqrt(s / Math.max(1, b - a))
}
const peak = (d, a = 0, b = d.length) => {
  let p = 0
  for (let i = a; i < b; i++) p = Math.max(p, Math.abs(d[i]))
  return p
}

describe('pad shaping parameters', () => {
  it('defaults are neutral and clamped', () => {
    const s = shaping({ tune: 99, fine: -80, pan: 3, env: { s: 2 }, filter: { type: 'xx' } })
    expect(s.tune).toBe(24)
    expect(s.fine).toBe(-50)
    expect(s.pan).toBe(1)
    expect(s.env.s).toBe(1)
    expect(s.filter.type).toBe('off')
    expect(isShaped({})).toBe(false)
    expect(isShaped({ gain: -3, reverse: true, fadeIn: 0.1 })).toBe(false) // v1.1 fields export as before
    expect(isShaped({ tune: 1 })).toBe(true)
    expect(isShaped({ pan: -0.5 })).toBe(true)
    expect(isShaped({ filter: { type: 'lp', cutoff: 800 } })).toBe(true)
    expect(isShaped({ env: { a: 0.01 } })).toBe(true)
  })
  it('pitch, velocity and envelope math', () => {
    expect(pitchRatio(12)).toBeCloseTo(2, 12)
    expect(pitchRatio(-12)).toBeCloseTo(0.5, 12)
    expect(velocityGain(127, 1)).toBe(1)
    expect(velocityGain(0, 1)).toBe(0)
    expect(velocityGain(64, 0)).toBe(1)
    expect(velocityGain(64, 0.5)).toBeCloseTo(0.5 + 0.5 * 64 / 127, 12)
    expect(velocityCutoff(8000, 127, 1)).toBe(8000)
    expect(velocityCutoff(8000, 0, 1)).toBeCloseTo(500, 6) // 4 octaves down
    const env = { a: 0.1, d: 0.1, s: 0.5, r: 0.2 }
    expect(envelopeAt(env, 0.05)).toBeCloseTo(0.5, 12)
    expect(envelopeAt(env, 0.15)).toBeCloseTo(0.75, 12)
    expect(envelopeAt(env, 0.5)).toBeCloseTo(0.5, 12)
    expect(envelopeAt(env, 0.6, 0.5)).toBeCloseTo(0.25, 12)
    expect(envelopeAt(env, 0.8, 0.5)).toBe(0)
  })
})

describe('rounding like the Python exporter', () => {
  it('halves go to even', () => {
    expect([0.5, 1.5, 2.5, 220.5, -0.5, 3.4, 3.6].map(pyRound)).toEqual([0, 2, 2, 220, -0, 3, 4])
  })
})

describe('pad rendering (what the pads play and the exports contain)', () => {
  const src = sine(441, 2)

  it('an unshaped slice is the exact cut, like the exporter (reverse, gain, fades)', () => {
    const s = { start: 0.25, end: 0.75, gain: -6, reverse: true, fadeIn: 0.01, fadeOut: 0.02 }
    const [L, R] = renderPad(src, s)
    const n = Math.round(0.5 * SR)
    expect(L.length).toBe(n)
    // the exporter: seg = audio[a:a+n] reversed, * gain, linear fades in source samples
    const a = Math.round(0.25 * SR)
    const g = Math.pow(10, -6 / 20)
    const fi = pyRound(0.01 * SR)
    const fo = pyRound(0.02 * SR)
    let maxErr = 0
    for (let k = 0; k < n; k++) {
      let x = src.channels[0][a + n - 1 - k] * g
      if (k < fi) x *= k / fi
      if (k >= n - fo) x *= 1 - (k - (n - fo)) / (fo - 1)
      maxErr = Math.max(maxErr, Math.abs(L[k] - x), Math.abs(R[k] - x))
    }
    expect(maxErr).toBeLessThan(1e-6)
  })

  it('tune +12 plays one octave up at double speed; -12 an octave down', () => {
    const s = { start: 0, end: 1 }
    const up = renderPad(src, { ...s, tune: 12 })
    expect(up[0].length).toBe(Math.round(SR / 2))
    expect(freqOf(up[0], SR) / 441).toBeCloseTo(2, 3)
    const down = renderPad(src, { ...s, tune: -12 })
    expect(down[0].length).toBe(SR * 2)
    expect(freqOf(down[0], SR) / 441).toBeCloseTo(0.5, 3)
    const fine = renderPad(src, { ...s, fine: 50 }) // a quarter tone
    expect(freqOf(fine[0], SR) / 441).toBeCloseTo(Math.pow(2, 0.5 / 12), 3)
  })

  it('keep-length tune plays the pitched copy at its own length', () => {
    const pitched = sine(882, 1)
    const s = { start: 0, end: 1, tune: 12, keepLength: true }
    expect(voiceFrames(src, s, SR, pitched)).toBe(SR)
    const [L] = renderPad(src, s, { pitched })
    expect(L.length).toBe(SR)
    expect(freqOf(L, SR) / 441).toBeCloseTo(2, 3)
  })

  it('envelope: attack ramps up, decay falls to sustain, a one-shot release ends with the sample', () => {
    const s = { start: 0, end: 1, env: { a: 0.1, d: 0.1, s: 0.5, r: 0.2 } }
    const [L] = renderPad(sine(441, 2, { amp: 1 }), s)
    const lvl = (t) => peak(L, Math.round(t * SR) - 60, Math.round(t * SR) + 60)
    expect(lvl(0.05)).toBeCloseTo(0.5, 1)
    expect(lvl(0.15)).toBeCloseTo(0.75, 1)
    expect(lvl(0.5)).toBeCloseTo(0.5, 1)
    expect(lvl(0.9)).toBeCloseTo(0.25, 1) // release starts at 1 - 0.2 s
    expect(peak(L, SR - 50, SR)).toBeLessThan(0.01)
  })

  it('filter: low-pass, high-pass and band-pass', () => {
    const lowTone = sine(200, 1)
    const highTone = sine(8000, 1)
    const level = (src2, filter) => rms(renderPad(src2, { start: 0, end: 1, filter })[0], 4410)
    const lp = { type: 'lp', cutoff: 1000, res: 0 }
    expect(level(lowTone, lp) / rms(lowTone.channels[0])).toBeGreaterThan(0.95)
    expect(level(highTone, lp) / rms(highTone.channels[0])).toBeLessThan(0.02)
    const hp = { type: 'hp', cutoff: 1000, res: 0 }
    expect(level(lowTone, hp) / rms(lowTone.channels[0])).toBeLessThan(0.05)
    expect(level(highTone, hp) / rms(highTone.channels[0])).toBeGreaterThan(0.95)
    const bp = { type: 'bp', cutoff: 1000, res: 0.5 }
    expect(level(sine(1000, 1), bp) / rms(sine(1000, 1).channels[0])).toBeGreaterThan(0.95)
    expect(level(lowTone, bp) / rms(lowTone.channels[0])).toBeLessThan(0.1)
  })

  it('pan: hard left / hard right / centre', () => {
    const s = { start: 0, end: 0.5 }
    const [l1, r1] = renderPad(src, { ...s, pan: -1 })
    expect(peak(r1)).toBe(0)
    expect(peak(l1)).toBeCloseTo(1, 2) // both channels summed into the left
    const [l2, r2] = renderPad(src, { ...s, pan: 1 })
    expect(peak(l2)).toBe(0)
    expect(peak(r2)).toBeCloseTo(1, 2)
    const [l3, r3] = renderPad(src, { ...s, pan: 0 })
    expect(peak(l3)).toBeCloseTo(0.5, 3)
    expect(peak(r3)).toBeCloseTo(0.5, 3)
  })

  it('velocity -> volume and velocity -> filter', () => {
    const s = { start: 0, end: 0.5 }
    const full = peak(renderPad(src, s, { vel: 127 })[0])
    expect(peak(renderPad(src, s, { vel: 64 })[0]) / full).toBeCloseTo(64 / 127, 3)
    expect(peak(renderPad(src, { ...s, velVol: 0 }, { vel: 20 })[0]) / full).toBeCloseTo(1, 6)
    const bright = sine(3000, 0.5)
    const f = { ...s, filter: { type: 'lp', cutoff: 6000, res: 0 }, velFilter: 1, velVol: 0 }
    const hard = rms(renderPad(bright, f, { vel: 127 })[0], 2000)
    const soft = rms(renderPad(bright, f, { vel: 10 })[0], 2000)
    expect(soft).toBeLessThan(hard * 0.3)
  })
})

describe('engine: banks, choke, note-on, timing', () => {
  const loud = sine(440, 4, { amp: 0.5 })
  const make = () => {
    const e = new Engine(48000)
    e.setSource('main', loud.channels, loud.sr)
    return e
  }
  const s1 = { start: 0, end: 1.5 }
  const s2 = { start: 1.5, end: 3, gain: -60 }

  it('mono bank: pad 1 is silent within 10 ms of pad 2; poly keeps ringing', () => {
    const T = Math.round(0.3 * 48000)
    const run = (mono, pads) => {
      const e = make()
      if (pads.includes(1)) e.noteOn({ slice: s1, bank: 0, pad: 0, mono, frame: 4800 })
      if (pads.includes(2)) e.noteOn({ slice: s2, bank: 0, pad: 1, mono, frame: T })
      return e.render(48000)[0]
    }
    for (const mono of [true, false]) {
      const both = run(mono, [1, 2])
      const two = run(mono, [2])
      const diff = (a, b) => { let p = 0; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(both[i] - two[i])); return p }
      expect(diff(T - 2400, T)).toBeGreaterThan(0.4)
      if (mono) expect(diff(T + 480, T + 24000)).toBe(0)
      else expect(diff(T + 480, T + 24000)).toBeGreaterThan(0.4)
    }
  })

  it('choke group cuts across banks; note-on stops on release; stop cuts everything', () => {
    const e = make()
    e.noteOn({ slice: { ...s1, choke: true }, bank: 0, pad: 0, frame: 0 })
    e.noteOn({ slice: { ...s1 }, bank: 1, pad: 0, frame: 0 })
    e.render(1000)
    expect(e.playing).toBe(2)
    e.noteOn({ slice: { ...s1, choke: true }, bank: 2, pad: 0, frame: e.frame })
    e.render(1000)
    expect(e.playing).toBe(2) // the first choked pad was cut
    e.noteOn({ slice: { ...s1, padMode: 'noteon' }, bank: 3, pad: 5, frame: e.frame })
    e.render(500)
    expect(e.playing).toBe(3)
    e.noteOff(3, 5, e.frame)
    e.render(1000)
    expect(e.playing).toBe(2)
    e.stopAll()
    e.render(1000)
    expect(e.voices.length).toBe(0)
  })

  it('events start on their exact sample, whatever the block size', () => {
    const at = 12345
    const render = (block) => {
      const e = make()
      e.noteOn({ slice: { start: 0.1, end: 0.2 }, frame: at })
      return e.render(20000, block)[0]
    }
    const a = render(128)
    const b = render(37)
    expect(a[at - 1]).toBe(0)
    expect(a[at + 1]).not.toBe(0)
    let maxErr = 0
    for (let i = 0; i < a.length; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]))
    expect(maxErr).toBe(0)
  })
})
