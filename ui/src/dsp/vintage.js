// Vintage bank character, on the bank's bus (so it colours every pad of the bank, live and in
// exports):
//   '12bit': anti-alias low-pass -> sample-and-hold to ~40 kHz -> 12-bit quantise ->
//            reconstruction low-pass (the grainy, slightly aliased early-sampler sound)
//   '16bit': gentle saturation + a soft high cut + 16-bit quantise (warmer, cleaner)
// Peaks are soft-limited just under full scale so the effect never clips.
import { Biquad, biquadCoeffs } from './biquad.js'

export const VINTAGE_MODES = ['off', '12bit', '16bit']

const softLimit = (x) => {
  const a = Math.abs(x)
  if (a <= 0.9) return x
  // 0.9 .. inf -> 0.9 .. 0.999, continuous slope 1 at 0.9
  const y = 0.9 + 0.099 * Math.tanh((a - 0.9) / 0.099)
  return x < 0 ? -y : y
}

export class Vintage {
  constructor(sr, mode = '12bit') {
    this.sr = sr
    this.setMode(mode)
  }

  setMode(mode) {
    this.mode = mode
    const sr = this.sr
    if (mode === '12bit') {
      this.target = Math.min(40000, sr) // sample-and-hold rate
      this.levels = 2047 // 12-bit signed
      const cut = Math.min(0.45 * this.target, 0.45 * sr)
      // 4th-order Butterworth-ish (two 2nd-order sections) before and after the decimation
      this.pre = [new Biquad(biquadCoeffs('lp', cut, 0.5412, sr)), new Biquad(biquadCoeffs('lp', cut, 1.3066, sr))]
      this.post = [new Biquad(biquadCoeffs('lp', cut, 0.5412, sr)), new Biquad(biquadCoeffs('lp', cut, 1.3066, sr))]
      this.drive = 1
    } else {
      this.target = sr
      this.levels = 32767
      this.pre = [new Biquad(biquadCoeffs('lp', Math.min(15000, sr * 0.45), Math.SQRT1_2, sr))]
      this.post = []
      this.drive = 1.6
    }
    this.phase = 0
    this.hold = [0, 0]
  }

  /** Keep running when the bank is idle, so live (any block size) and offline renders match. */
  tail() { return true }

  /** In place on L/R[at .. at+n). */
  process(L, R, n, at = 0) {
    const step = this.target / this.sr
    const q = this.levels
    const sat = this.drive > 1 ? 1 / Math.tanh(this.drive) : 1
    for (let i = at; i < at + n; i++) {
      let l = L[i]
      let r = R[i]
      for (const f of this.pre) { l = f.tick(l, 0); r = f.tick(r, 1) }
      if (this.drive > 1) { l = Math.tanh(l * this.drive) * sat; r = Math.tanh(r * this.drive) * sat }
      // sample-and-hold at the target rate (a new value whenever the phase wraps)
      this.phase += step
      if (this.phase >= 1 || step >= 1) {
        this.phase -= Math.floor(this.phase)
        this.hold[0] = Math.round(Math.max(-1, Math.min(1, l)) * q) / q
        this.hold[1] = Math.round(Math.max(-1, Math.min(1, r)) * q) / q
      }
      l = this.hold[0]
      r = this.hold[1]
      for (const f of this.post) { l = f.tick(l, 0); r = f.tick(r, 1) }
      L[i] = softLimit(l)
      R[i] = softLimit(r)
    }
  }
}
