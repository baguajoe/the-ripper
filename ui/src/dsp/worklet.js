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
      case 'traceFires': this.fired = m.on ? [] : null; break
      case 'getFires': this.port.postMessage({ type: 'fires', fires: this.fired || [] }); break
      case 'off': eng.noteOff(m.bank, m.pad, this.frameOf(m.at)); break
      case 'stop': eng.stopAll(this.frameOf(m.at)); break
      default: this.extra?.(m)
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] || new Float32Array(L.length)
    const eng = this.engine
    if (eng.frame !== currentFrame) eng.frame = currentFrame
    eng.process(L, R, L.length)
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
