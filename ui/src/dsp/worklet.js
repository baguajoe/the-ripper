// AudioWorklet host for the pad engine: the live side of the same DSP the exports render with.
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */
import { Engine } from './engine.js'
import { Transport } from './transport.js'
import { applyProgram } from './program.js'

class RipperEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.engine = new Engine(sampleRate)
    this.engine.frame = currentFrame
    this.transport = new Transport(this.engine)
    this.transport.onHit = (h) => this.port.postMessage({ type: 'hit', ...h })
    this.fired = null // test hook: frames of sequencer triggers
    this.transport.onFire = (e) => { if (this.fired) this.fired.push(e) }
    this.capture = null // resample: {chunks: [], frames}
    this.reported = -1
    this.blocks = 0
    this.port.onmessage = (e) => this.onMessage(e.data)
  }

  frameOf(at) {
    return at == null ? undefined : Math.round(at * sampleRate)
  }

  onMessage(m) {
    const eng = this.engine
    switch (m.type) {
      case 'source': eng.setSource(m.id, m.channels, m.sr); break
      case 'removeSource': eng.removeSource(m.id); break
      case 'on': {
        const frame = this.frameOf(m.at) ?? eng.frame
        eng.noteOn({ ...m, frame })
        this.transport.hit(m.bank, m.pad, m.vel ?? 127, frame)
        break
      }
      case 'program': applyProgram(eng, this.transport, m.program); break
      case 'pass': this.transport.setPass(m.pass, m.loop); break
      case 'play': this.transport.play(this.frameOf(m.at) ?? eng.frame, m); this.transport.recording = !!m.record; break
      case 'transportStop': this.transport.stop(); eng.stopAll(); break
      case 'record': this.transport.recording = !!m.on; break
      case 'metronome': this.transport.metronome = !!m.on; break
      case 'repeat': this.transport.setRepeat(m.repeat, this.frameOf(m.at) ?? eng.frame); break
      case 'capture': // live resample: everything the engine plays, until told to stop
        if (m.on) this.capture = { from: eng.frame, chunks: [], frames: 0, until: Infinity }
        else this.finishCapture()
        break
      case 'resample': { // one pass of the pattern / song, from its first sample, plus the tail
        const from = this.frameOf(m.at) ?? eng.frame
        this.savedLoop = this.transport.loop
        this.transport.loop = false
        this.transport.play(from, { metronome: false })
        this.capture = { from, chunks: [], frames: 0, until: from + this.transport.passFrames, maxTail: Math.round((m.maxTail ?? 6) * sampleRate), quiet: 0 }
        break
      }
      case 'ping': this.port.postMessage({ type: 'pong', id: m.id, t: currentFrame / sampleRate }); break
      case 'traceFires': this.fired = m.on ? [] : null; break
      case 'getFires': this.port.postMessage({ type: 'fires', fires: this.fired || [] }); break
      case 'off': eng.noteOff(m.bank, m.pad, this.frameOf(m.at)); break
      case 'stop': eng.stopAll(this.frameOf(m.at)); break
      default: this.extra?.(m)
    }
  }

  finishCapture() {
    const c = this.capture
    if (!c) return
    this.capture = null
    if (this.savedLoop != null) { this.transport.loop = this.savedLoop; this.savedLoop = null }
    const L = new Float32Array(c.frames)
    const R = new Float32Array(c.frames)
    let o = 0
    for (const [l, r] of c.chunks) { L.set(l, o); R.set(r, o); o += l.length }
    this.port.postMessage({ type: 'captured', sr: sampleRate, channels: [L, R], from: c.from }, [L.buffer, R.buffer])
  }

  /** Copy this block's output into the capture (from its exact first frame). */
  captureBlock(L, R, f0) {
    const c = this.capture
    const n = L.length
    const a = Math.max(0, c.from - f0)
    if (a >= n) return
    c.chunks.push([L.slice(a), R.slice(a)])
    c.frames += n - a
    if (c.until !== Infinity && f0 + n >= c.until) {
      // after the pass: keep going until 0.5 s of silence (the effects' tails), at most maxTail
      let loud = false
      for (let i = Math.max(a, c.until - f0); i < n; i++) if (Math.abs(L[i]) > 1e-4 || Math.abs(R[i]) > 1e-4) { loud = true; break }
      c.quiet = loud ? 0 : c.quiet + n
      if (c.quiet >= 0.5 * sampleRate || f0 + n - c.until >= c.maxTail) this.finishCapture()
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] || new Float32Array(L.length)
    const eng = this.engine
    if (eng.frame !== currentFrame) eng.frame = currentFrame
    const f0 = eng.frame
    eng.process(L, R, L.length)
    if (this.capture) this.captureBlock(L, R, f0)
    // report the voice count when it changes (and every ~50 ms while anything plays)
    const playing = eng.playing
    this.blocks++
    const pos = this.transport.position()
    const tp = this.transport.playing
    if (playing !== this.reported || tp !== this.reportedTp || ((playing > 0 || tp) && this.blocks % 8 === 0)) {
      this.reported = playing
      this.reportedTp = tp
      this.port.postMessage({ type: 'status', playing, triggered: eng.triggered, frame: eng.frame, transport: tp,
        recording: this.transport.recording, tick: pos ? pos.tick : null, pass: pos ? pos.pass : null })
    }
    return true
  }
}

registerProcessor('ripper-engine', RipperEngineProcessor)
