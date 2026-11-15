// The pad engine: voices -> bank buses -> master, with sample-exact event scheduling.
// Pure JS (no Web Audio), so the same code runs live in the AudioWorklet and offline for
// exports, resampling and the tests.
//
// Pad rules:
//   * Mono bank (default): a pad cuts whatever that bank is playing (5 ms de-click fade).
//   * Poly bank: pads ring out over each other.
//   * Choke flag: choked pads cut each other in any bank (a choke group).
//   * Note-on pads play only while held; release() starts their release.
import { Voice } from './voice.js'

export const BANKS = 8
export const AUX = BANKS // the metronome bus: no bank processing
const BUSES = BANKS + 1

export class Engine {
  constructor(sampleRate) {
    this.sr = sampleRate
    this.frame = 0 // absolute output frame of the next sample to render
    this.sources = new Map() // id -> {channels: Float32Array[], sr}
    this.voices = []
    this.queue = [] // pending events, sorted by frame
    this.cap = 0
    this.busL = []
    this.busR = []
    this.bankFx = Array.from({ length: BANKS }, () => null) // {process(L, R, n)} per bank (vintage)
    this.master = null // {process(L, R, n)} master bus
    this.triggered = 0
    this.nextId = 1
    this.listeners = new Set() // (event) => void: 'start' / 'end' notifications
  }

  setSource(id, channels, sr) {
    this.sources.set(id, { channels, sr })
  }

  removeSource(id) {
    this.sources.delete(id)
  }

  /** Queue an event ({frame, type, ...}); a frame in the past means "now". */
  schedule(ev) {
    const e = { ...ev, frame: Math.max(this.frame, Math.round(ev.frame ?? this.frame)) }
    let i = this.queue.length
    while (i > 0 && this.queue[i - 1].frame > e.frame) i--
    this.queue.splice(i, 0, e)
  }

  /** Trigger a slice: {slice, bank, pad, mono, vel, frame, source = 'main', pitched}. */
  noteOn(opts) { this.schedule({ ...opts, type: 'on' }) }

  noteOff(bank, pad, frame) { this.schedule({ type: 'off', bank, pad, frame }) }

  stopAll(frame) { this.schedule({ type: 'stop', frame }) }

  /** Voices still sounding (not fading out). */
  get playing() {
    let n = 0
    for (const v of this.voices) if (!v.stopping) n++
    return n
  }

  _apply(e) {
    const f = e.frame
    if (e.type === 'stop') {
      for (const v of this.voices) v.cut(f)
      return
    }
    if (e.type === 'off') {
      for (const v of this.voices) if (v.noteOn && v.bank === e.bank && v.pad === e.pad) v.release(f)
      return
    }
    if (e.type === 'on') {
      const src = this.sources.get(e.source ?? 'main')
      if (!src || !e.slice) return
      const choke = !!e.slice.choke
      for (const v of this.voices) {
        if ((e.mono && v.bank === e.bank) || (choke && v.choke)) v.cut(f)
      }
      const pitched = e.pitched ? this.sources.get(e.pitched) ?? null : null
      const v = new Voice({ src, slice: e.slice, bank: e.bank ?? 0, pad: e.pad ?? -1, vel: e.vel ?? 127,
        outSr: this.sr, startFrame: f, pitched, id: this.nextId++ })
      this.voices.push(v)
      this.triggered++
      for (const fn of this.listeners) fn({ type: 'start', voice: v, event: e })
      return
    }
    for (const fn of this.listeners) fn({ type: e.type, event: e }) // custom events (sequencer, metronome)
  }

  _ensure(n) {
    if (n <= this.cap) return
    this.cap = n
    this.busL = Array.from({ length: BUSES }, () => new Float32Array(n))
    this.busR = Array.from({ length: BUSES }, () => new Float32Array(n))
  }

  /** Render n frames, ADDING into L and R (Float32Arrays, at offset `at`). */
  process(L, R, n, at = 0) {
    this.onBlock?.(this.frame, n) // the sequencer schedules this block's events here
    this._ensure(n)
    const used = new Array(BUSES).fill(false)
    for (let b = 0; b < BUSES; b++) { this.busL[b].fill(0, 0, n); this.busR[b].fill(0, 0, n) }
    const end = this.frame + n
    let f = this.frame
    while (f < end) {
      while (this.queue.length && this.queue[0].frame <= f) this._apply(this.queue.shift())
      const next = this.queue.length ? Math.min(end, this.queue[0].frame) : end
      for (const v of this.voices) {
        used[v.bank] = true
        v.render(this.busL[v.bank], this.busR[v.bank], f, next, f - this.frame)
      }
      f = next
    }
    const before = this.voices.length
    this.voices = this.voices.filter((v) => !v.done)
    if (this.voices.length !== before) for (const fn of this.listeners) fn({ type: 'end' })
    for (let b = 0; b < BUSES; b++) {
      const fx = b < BANKS ? this.bankFx[b] : null
      if (fx && (used[b] || fx.tail?.())) fx.process(this.busL[b], this.busR[b], n)
      else if (!used[b]) continue
      const bl = this.busL[b]
      const br = this.busR[b]
      for (let i = 0; i < n; i++) { L[at + i] += bl[i]; R[at + i] += br[i] }
    }
    if (this.master) this.master.process(L, R, n, at)
    this.frame = end
  }

  /** Render `frames` frames offline into new buffers, in blocks of `block` frames. */
  render(frames, block = 128) {
    const L = new Float32Array(frames)
    const R = new Float32Array(frames)
    for (let i = 0; i < frames; i += block) this.process(L, R, Math.min(block, frames - i), i)
    return [L, R]
  }
}
