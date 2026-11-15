// Sequencer transport inside the pad engine: plays a pass of note events (lib/sequence.js
// passEvents) on exact samples, loops it, counts in, clicks the metronome, runs note repeat
// and reports recorded hits. Runs in the AudioWorklet and offline, identically.
import { AUX } from './engine.js'
import { swingTick } from '../lib/sequence.js'

const PPQ = 960

/** Click samples for the metronome (accent = bar, normal = beat). */
function clickSample(sr, freq, amp) {
  const n = Math.round(0.03 * sr)
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr) * Math.exp(-i / (0.006 * sr))
  return d
}

export class Transport {
  constructor(engine) {
    this.e = engine
    this.sr = engine.sr
    this.program = { banks: [] } // [{mono, pads: [slice|null] x16}], slice may carry pitched (source id)
    this.pass = { events: [], length: PPQ * 4, bpm: 120, swing: 50 }
    this.loop = true
    this.playing = false
    this.start = 0 // frame of tick 0 of the first pass
    this.countFrom = 0 // first count-in click
    this.metronome = false
    this.recording = false
    this.repeat = null // {bank, pad, vel, rate (ticks), swing, from (frame), free}
    this.onHit = null // (hit) => void   recorded hit: {bank, pad, vel, tick (in pass, swung)}
    this.onFire = null // (event) => void (tests / UI playhead)
    engine.setSource('__click_hi', [clickSample(this.sr, 1760, 0.5)], this.sr)
    engine.setSource('__click_lo', [clickSample(this.sr, 1320, 0.35)], this.sr)
    engine.onBlock = (f, n) => this.block(f, n)
  }

  frameOfTick(t) { return Math.round(((t * 60) / (this.pass.bpm * PPQ)) * this.sr) }
  tickOfFrame(f) { return (f * this.pass.bpm * PPQ) / (60 * this.sr) }
  get passFrames() { return this.frameOfTick(this.pass.length) }

  setProgram(p) { this.program = p }

  /** pass: {events: [{tick, offTick, bank, pad, vel}], length (ticks), bpm, swing}. */
  setPass(pass, loop = this.loop) {
    this.pass = { events: pass.events || [], length: Math.max(1, pass.length), bpm: pass.bpm || this.pass.bpm, swing: pass.swing ?? 50 }
    this.loop = loop
  }

  /** Start at frame `at`; with a count-in, one bar of clicks first. */
  play(at, { countIn = false, metronome = this.metronome } = {}) {
    this.metronome = metronome
    const bar = this.frameOfTick(PPQ * 4)
    this.countFrom = at
    this.start = countIn ? at + bar : at
    this.playing = true
  }

  stop() {
    this.playing = false
    this.recording = false
  }

  /** Position now: {pass, tick (in pass, swung), frame} or null when stopped / counting in. */
  position(frame = this.e.frame) {
    if (!this.playing || frame < this.start) return null
    const rel = frame - this.start
    const pf = this.passFrames
    const pass = Math.floor(rel / pf)
    if (!this.loop && pass > 0) return null
    return { pass, tick: this.tickOfFrame(rel - pass * pf), frame }
  }

  trigger(bank, pad, vel, frame, offFrame) {
    const b = this.program.banks[bank]
    const slice = b?.pads?.[pad]
    if (!slice) return
    this.e.noteOn({ slice, bank, pad, vel, mono: !!b.mono, frame, pitched: slice.pitched || null })
    if (slice.padMode === 'noteon' && offFrame != null) this.e.noteOff(bank, pad, offFrame)
    this.onFire?.({ bank, pad, vel, frame })
  }

  /** A pad hit from outside (keys / mouse / MIDI) while recording: report its position. */
  hit(bank, pad, vel, frame) {
    if (!this.recording) return
    const p = this.position(frame)
    if (p) this.onHit?.({ bank, pad, vel, tick: p.tick, pass: p.pass })
    // a hit up to a 16th before the first beat (right after Record / the count-in) still counts:
    // a negative tick, which quantizing pulls onto the downbeat
    else if (this.playing && frame < this.start && this.start - frame <= this.frameOfTick(PPQ / 4)) {
      this.onHit?.({ bank, pad, vel, tick: this.tickOfFrame(frame - this.start), pass: 0 })
    }
  }

  /** Note repeat while a pad is held: r = {bank, pad, vel, rate (ticks)} or null to stop. */
  setRepeat(r, frame) {
    this.repeat = r ? { ...r, from: frame, mode: null, k: 0 } : null
  }

  click(frame, accent) {
    this.e.noteOn({ slice: { start: 0, end: 0.03, fadeOut: 0 }, bank: AUX, pad: -1, frame, source: accent ? '__click_hi' : '__click_lo' })
  }

  block(f0, n) {
    const f1 = f0 + n
    if (this.playing) {
      const pf = this.passFrames
      const beat = this.frameOfTick(PPQ)
      // count-in + metronome clicks
      if (this.metronome || this.countFrom < this.start) {
        const first = Math.max(0, Math.ceil((f0 - this.countFrom) / beat))
        for (let k = first; ; k++) {
          const t = this.countFrom + Math.round((k * (60 / this.pass.bpm)) * this.sr)
          if (t >= f1) break
          if (t >= this.start && !this.metronome) break
          if (t < f0) continue
          this.click(t, k % 4 === 0)
        }
      }
      // pattern events for every pass overlapping [f0, f1)
      if (f1 > this.start) {
        const firstPass = Math.max(0, Math.floor((f0 - this.start) / pf) - 1)
        const lastPass = Math.floor((f1 - this.start) / pf)
        for (let k = firstPass; k <= lastPass; k++) {
          if (!this.loop && k > 0) {
            if (f0 >= this.start + pf) this.stop()
            break
          }
          const base = k * this.pass.length
          for (const e of this.pass.events) {
            const fr = this.start + this.frameOfTick(base + e.tick)
            if (fr >= f0 && fr < f1) this.trigger(e.bank, e.pad, e.vel, fr, this.start + this.frameOfTick(base + e.offTick))
          }
        }
      }
    }
    // note repeat: on the transport's (swung) grid while playing, free-running from the press otherwise
    const r = this.repeat
    if (r) {
      if (r.mode == null) {
        const grid = this.playing && r.from >= this.start
        r.mode = grid ? 'grid' : 'free'
        r.k = grid ? Math.ceil(this.tickOfFrame(r.from - this.start) / r.rate - 1e-6) : 0
      }
      for (;;) {
        const fr = r.mode === 'grid'
          ? this.start + this.frameOfTick(swingTick(Math.round(r.k * r.rate), this.pass.swing))
          : r.from + this.frameOfTick(r.k * r.rate)
        if (fr >= f1) break
        r.k++
        if (fr < f0) continue
        this.trigger(r.bank, r.pad, r.vel, fr, fr + this.frameOfTick(r.rate / 2))
        if (this.recording) {
          const p = this.position(fr)
          if (p) this.onHit?.({ bank: r.bank, pad: r.pad, vel: r.vel, tick: p.tick, pass: p.pass, repeat: true })
        }
      }
    }
  }
}
