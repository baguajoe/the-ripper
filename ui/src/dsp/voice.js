// One playing pad: reads its slice out of a source buffer and shapes it, one sample at a time.
//
//   cut -> [reverse] -> tune (playback speed, cubic interpolation) -> gain + fades (source time,
//   identical to the exporter) -> envelope x velocity (output time) -> filter -> pan
//
// Everything is per-sample with no block-dependent state, so a voice renders identically live
// (128-frame blocks in the AudioWorklet) and offline (exports, resample, tests).
import { Biquad, biquadCoeffs } from './biquad.js'
import { CUT_FADE, envelopeAt, pitchRatio, resToQ, semitones, shaping, velocityCutoff, velocityGain } from './params.js'

/** Python's round(): halves go to the even neighbour (the exporter cuts with it). */
export function pyRound(x) {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

const dbToGain = (db) => Math.pow(10, (Number(db) || 0) / 20)

/** Catmull-Rom read of `d` at fractional index x; exact at integer x. */
function cubic(d, x, lo, hi) {
  const i = Math.floor(x)
  const f = x - i
  const at = (k) => (k >= lo && k < hi ? d[k] : 0)
  const y1 = at(i)
  if (f === 0) return y1
  const y0 = at(i - 1)
  const y2 = at(i + 1)
  const y3 = at(i + 2)
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return ((c3 * f + c2) * f + c1) * f + y1
}

export class Voice {
  /**
   * src: {channels: Float32Array[], sr}; slice: a pad's slice (start/end in seconds + shaping);
   * pitched: optional {channels, sr} pitch-shifted copy of the slice (keep-length tune).
   */
  constructor({ src, slice, bank = 0, pad = -1, vel = 127, outSr, startFrame = 0, pitched = null, id = 0 }) {
    this.id = id
    this.bank = bank
    this.pad = pad
    this.choke = !!slice.choke
    this.noteOn = slice.padMode === 'noteon'
    this.startFrame = startFrame
    this.outSr = outSr
    const sh = shaping(slice)
    this.sh = sh
    const st = semitones(slice)
    const usePitched = !!pitched && !!slice.keepLength && st !== 0
    const s = usePitched ? pitched : src
    this.chans = s.channels.length > 1 ? [s.channels[0], s.channels[1]] : [s.channels[0], s.channels[0]]
    const len = s.channels[0].length
    if (usePitched) {
      this.a0 = 0
      this.n = len
    } else {
      // like the exporter: round((end - start) * sr) samples from round(start * sr), silence past the end
      this.a0 = Math.min(len, Math.max(0, pyRound(slice.start * s.sr)))
      this.n = Math.max(1, pyRound((slice.end - slice.start) * s.sr))
    }
    this.lo = 0
    this.hi = len
    this.reverse = !!slice.reverse
    this.rate = (usePitched ? 1 : pitchRatio(st)) * (s.sr / outSr)
    this.lengthOut = this.n / this.rate // output frames until the source runs out
    this.level = dbToGain(slice.gain) * velocityGain(vel, sh.velVol)
    this.fi = Math.min(this.n, pyRound(Math.max(0, Number(slice.fadeIn) || 0) * s.sr))
    this.fo = Math.min(this.n, pyRound(Math.max(0, Number(slice.fadeOut) || 0) * s.sr))
    // pan (Web Audio StereoPannerNode law for a stereo input)
    const p = sh.pan
    const x = (p <= 0 ? p + 1 : p) * Math.PI / 2
    this.panLeft = p <= 0
    const snap = (g) => (Math.abs(g) < 1e-12 ? 0 : Math.abs(1 - g) < 1e-12 ? 1 : g)
    this.gA = snap(Math.cos(x))
    this.gB = snap(Math.sin(x))
    this.filter = sh.filter.type === 'off' ? null
      : new Biquad(biquadCoeffs(sh.filter.type, velocityCutoff(sh.filter.cutoff, vel, sh.velFilter), resToQ(sh.filter.res), outSr))
    // envelope: a one-shot's gate closes so its release ends with the sample
    const durSec = this.lengthOut / outSr
    this.env = sh.env
    this.envFlat = sh.env.a === 0 && sh.env.d === 0 && sh.env.s === 1
    this.tOff = !this.noteOn && sh.env.r > 0 ? Math.max(0, durSec - sh.env.r) : Infinity
    this.relEnv = sh.env // swapped for a de-click release when cut
    this.cutAt = -1 // output frame index (voice-local) where a cut started
    this.cutFrom = 0
    this.cutLen = Math.max(1, Math.round(CUT_FADE * outSr))
    this.released = false
    this.k = 0 // output frames rendered so far
    this.done = false
  }

  get stopping() { return this.cutAt >= 0 || this.released }

  /** Gain of the envelope (with release / cut) at voice-local output frame k. */
  _amp(k) {
    const t = k / this.outSr
    let g = this.envFlat && this.tOff === Infinity ? 1 : envelopeAt(this.relEnv, t, this.tOff)
    if (this.cutAt >= 0) {
      const j = k - this.cutAt
      g = j >= this.cutLen ? 0 : this.cutFrom * (1 - j / this.cutLen)
    }
    return g
  }

  /** Fade gain at fractional source offset x (0..n), as in the exporter's apply_fades. */
  _fade(x) {
    let g = 1
    if (this.fi > 0 && x < this.fi) g *= x / this.fi
    if (this.fo > 0 && x > this.n - this.fo) {
      const j = x - (this.n - this.fo)
      g *= this.fo > 1 ? Math.max(0, 1 - j / (this.fo - 1)) : 0
    }
    return g
  }

  /** Release the note (note-on pads) at absolute frame f: the envelope's release, or a de-click fade. */
  release(f) {
    if (this.released || this.done) return
    this.released = true
    const k = Math.max(0, f - this.startFrame)
    if (this.env.r > 0) {
      this.tOff = Math.min(this.tOff, k / this.outSr)
    } else {
      this.cut(f)
    }
  }

  /** Cut (mono / choke / stop) at absolute frame f with the de-click fade. */
  cut(f) {
    if (this.cutAt >= 0 || this.done) return
    const k = Math.max(0, f - this.startFrame)
    this.cutFrom = this._amp(k)
    this.cutAt = k
  }

  /**
   * Add this voice into L/R (bus buffers) for absolute frames [f0, f1); b0 is the buffer index of f0.
   * Returns false once the voice has finished.
   */
  render(L, R, f0, f1, b0) {
    if (this.done) return false
    let f = Math.max(f0, this.startFrame)
    const [c0, c1] = this.chans
    const { a0, n, rate, level, filter, reverse, lo, hi } = this
    for (; f < f1; f++) {
      const k = f - this.startFrame
      const x = k * rate // source offset (0..n)
      if (x >= n) { this.done = true; break }
      const amp = this._amp(k)
      if (amp <= 0 && (this.cutAt >= 0 || (this.tOff !== Infinity && k / this.outSr >= this.tOff))) { this.done = true; break }
      const pos = reverse ? a0 + (n - 1) - x : a0 + x
      const g = level * this._fade(x) * amp
      let l = cubic(c0, pos, lo, hi) * g
      let r = c1 === c0 ? l : cubic(c1, pos, lo, hi) * g
      if (filter) { l = filter.tick(l, 0); r = filter.tick(r, 1) }
      let ol
      let or
      if (this.panLeft) { ol = l + r * this.gA; or = r * this.gB } else { ol = l * this.gA; or = r + l * this.gB }
      const i = b0 + (f - f0)
      L[i] += ol
      R[i] += or
    }
    this.k = f - this.startFrame
    return !this.done
  }
}
