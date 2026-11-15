// Effects: drive (saturation), tempo-synced delay, reverb, compressor. Per pad (drive -> delay
// -> reverb on the pad's own bus) and on the master bus (drive -> delay -> reverb -> compressor).
// Every effect has a wet/dry mix. All per-sample with no block-dependent state, so pads, the
// sequencer, resampling and exports render identically.

export const DELAY_TIMES = { '1/4': 1, '1/8': 0.5, '1/8.': 0.75, '1/16': 0.25, '1/4T': 2 / 3, '1/8T': 1 / 3, '1/2': 2 } // beats
export const DEFAULT_FX = Object.freeze({
  drive: Object.freeze({ on: false, amount: 0.4, mix: 1 }),
  delay: Object.freeze({ on: false, time: '1/8', feedback: 0.35, mix: 0.3 }),
  reverb: Object.freeze({ on: false, size: 0.6, damp: 0.4, mix: 0.25 }),
})
export const DEFAULT_COMP = Object.freeze({ on: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.15, makeup: 4, mix: 1 })
export const DEFAULT_MASTER = Object.freeze({ ...DEFAULT_FX, comp: DEFAULT_COMP })

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo))
const on = (f) => !!f && f.on && clamp(f.mix ?? 1, 0, 1) > 0

/** Delay time in seconds for a note value at bpm. */
export const delaySeconds = (time, bpm) => ((DELAY_TIMES[time] ?? 0.5) * 60) / (bpm || 120)

/** Seconds of tail an export needs after the dry sound ends (delay echoes + reverb decay). */
export function fxTail(fx, bpm) {
  if (!fx) return 0
  let t = 0
  if (on(fx.delay)) {
    const fb = clamp(fx.delay.feedback, 0, 0.9)
    const echoes = fb > 0 ? Math.min(40, Math.ceil(Math.log(0.001) / Math.log(fb))) : 1
    t += delaySeconds(fx.delay.time, bpm) * echoes
  }
  if (on(fx.reverb)) t += 0.8 + 3.2 * clamp(fx.reverb.size, 0, 1)
  return Math.min(8, t)
}

class Drive {
  constructor() { this.set(DEFAULT_FX.drive) }
  set(p) {
    this.k = 1 + 15 * clamp(p.amount, 0, 1)
    this.norm = 1 / Math.tanh(this.k)
    this.mix = clamp(p.mix ?? 1, 0, 1)
  }
  reset() {}
  tick(x) { return x + this.mix * (Math.tanh(this.k * x) * this.norm * 0.8 - x) }
}

class Delay {
  constructor(sr) {
    this.sr = sr
    this.size = Math.ceil(sr * 6) + 2 // up to a half note at 40 BPM
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)]
    this.w = 0
    this.set(DEFAULT_FX.delay, 120)
  }
  set(p, bpm) {
    this.d = Math.max(1, Math.min(this.size - 1, Math.round(delaySeconds(p.time, bpm) * this.sr)))
    this.fb = clamp(p.feedback, 0, 0.9)
    this.mix = clamp(p.mix ?? 0.3, 0, 1)
  }
  reset() { this.buf[0].fill(0); this.buf[1].fill(0); this.w = 0 }
  tick(l, r) {
    const ri = (this.w - this.d + this.size) % this.size
    const dl = this.buf[0][ri]
    const dr = this.buf[1][ri]
    // ping-pong: each channel's echo feeds the other
    this.buf[0][this.w] = l + dr * this.fb
    this.buf[1][this.w] = r + dl * this.fb
    this.w = (this.w + 1) % this.size
    return [l + this.mix * dl, r + this.mix * dr]
  }
}

// Freeverb (Jezar's public-domain design): 8 damped combs + 4 allpasses per channel.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASSES = [556, 441, 341, 225]
const SPREAD = 23
class Comb {
  constructor(n) { this.b = new Float32Array(n); this.i = 0; this.store = 0 }
  tick(x, fb, damp) {
    const y = this.b[this.i]
    this.store = y * (1 - damp) + this.store * damp
    this.b[this.i] = x + this.store * fb
    if (++this.i >= this.b.length) this.i = 0
    return y
  }
  reset() { this.b.fill(0); this.store = 0; this.i = 0 }
}
class Allpass {
  constructor(n) { this.b = new Float32Array(n); this.i = 0 }
  tick(x) {
    const y = this.b[this.i]
    this.b[this.i] = x + y * 0.5
    if (++this.i >= this.b.length) this.i = 0
    return y - x
  }
  reset() { this.b.fill(0); this.i = 0 }
}
class Reverb {
  constructor(sr) {
    const s = sr / 44100
    this.c = [COMBS.map((n) => new Comb(Math.round(n * s))), COMBS.map((n) => new Comb(Math.round((n + SPREAD) * s)))]
    this.a = [ALLPASSES.map((n) => new Allpass(Math.round(n * s))), ALLPASSES.map((n) => new Allpass(Math.round((n + SPREAD) * s)))]
    this.set(DEFAULT_FX.reverb)
  }
  set(p) {
    this.fb = 0.7 + 0.28 * clamp(p.size, 0, 1)
    this.damp = 0.4 * clamp(p.damp ?? 0.4, 0, 1)
    this.mix = clamp(p.mix ?? 0.25, 0, 1)
  }
  reset() { for (const ch of [...this.c, ...this.a]) for (const f of ch) f.reset() }
  tick(l, r) {
    const x = (l + r) * 0.015
    let ol = 0
    let or = 0
    for (const f of this.c[0]) ol += f.tick(x, this.fb, this.damp)
    for (const f of this.c[1]) or += f.tick(x, this.fb, this.damp)
    for (const f of this.a[0]) ol = f.tick(ol)
    for (const f of this.a[1]) or = f.tick(or)
    return [l + this.mix * ol * 3, r + this.mix * or * 3]
  }
}

/** Feed-forward stereo-linked compressor: peak detector, 6 dB soft knee, makeup, parallel mix. */
class Compressor {
  constructor(sr) { this.sr = sr; this.env = 0; this.set(DEFAULT_COMP) }
  set(p) {
    this.th = clamp(p.threshold, -60, 0)
    this.ratio = clamp(p.ratio, 1, 20)
    this.att = Math.exp(-1 / (Math.max(0.0001, clamp(p.attack, 0, 1)) * this.sr))
    this.rel = Math.exp(-1 / (Math.max(0.001, clamp(p.release, 0, 5)) * this.sr))
    this.makeup = Math.pow(10, clamp(p.makeup, 0, 24) / 20)
    this.mix = clamp(p.mix ?? 1, 0, 1)
  }
  reset() { this.env = 0 }
  gainDb(levelDb) {
    const knee = 6
    const over = levelDb - this.th
    if (over <= -knee / 2) return 0
    if (over >= knee / 2) return -over * (1 - 1 / this.ratio)
    const x = over + knee / 2
    return -((1 - 1 / this.ratio) * x * x) / (2 * knee)
  }
  tick(l, r) {
    const peak = Math.max(Math.abs(l), Math.abs(r))
    const c = peak > this.env ? this.att : this.rel
    this.env = c * this.env + (1 - c) * peak
    const db = this.env > 1e-9 ? 20 * Math.log10(this.env) : -180
    const g = Math.pow(10, this.gainDb(db) / 20) * this.makeup
    const m = this.mix
    return [l * (1 - m + m * g), r * (1 - m + m * g)]
  }
}

/**
 * A chain: drive -> delay -> reverb [-> compressor]. configure(fx, bpm) keeps the state (no
 * clicks while tweaking). After the input has been silent for longer than the tail, the state
 * is cleared on that exact sample, so idle chains can be skipped without changing the output.
 */
export class FxChain {
  constructor(sr, { master = false } = {}) {
    this.sr = sr
    this.master = master
    this.drive = new Drive()
    this.delay = new Delay(sr)
    this.reverb = new Reverb(sr)
    this.comp = master ? new Compressor(sr) : null
    this.quiet = Infinity // samples since the last non-zero input
    this.tailLen = 0
    this.active = { drive: false, delay: false, reverb: false, comp: false }
  }

  configure(fx = {}, bpm = 120) {
    const f = { ...DEFAULT_MASTER, ...fx }
    this.active = { drive: on(f.drive), delay: on(f.delay), reverb: on(f.reverb), comp: !!this.comp && on(f.comp) }
    if (this.active.drive) this.drive.set(f.drive)
    if (this.active.delay) this.delay.set(f.delay, bpm)
    if (this.active.reverb) this.reverb.set(f.reverb)
    if (this.active.comp) this.comp.set(f.comp)
    this.tailLen = Math.round(fxTail(f, bpm) * this.sr) + 1
    return this
  }

  get enabled() { return Object.values(this.active).some(Boolean) }

  /** Still ringing (or always, for a master compressor: its envelope is continuous). */
  tail() { return this.active.comp || this.quiet < this.tailLen }

  reset() { this.drive.reset(); this.delay.reset(); this.reverb.reset(); this.comp?.reset() }

  process(L, R, n, at = 0) {
    const { drive, delay, reverb, comp } = this.active
    for (let i = at; i < at + n; i++) {
      let l = L[i]
      let r = R[i]
      if (l !== 0 || r !== 0) this.quiet = 0
      else if (this.quiet !== Infinity && ++this.quiet >= this.tailLen && !comp) {
        this.quiet = Infinity
        this.reset() // fully decayed: start from silence, exactly like a fresh chain
      }
      if (drive) { l = this.drive.tick(l); r = this.drive.tick(r) }
      if (delay) [l, r] = this.delay.tick(l, r)
      if (reverb) [l, r] = this.reverb.tick(l, r)
      if (comp) [l, r] = this.comp.tick(l, r)
      L[i] = l
      R[i] = r
    }
  }
}
