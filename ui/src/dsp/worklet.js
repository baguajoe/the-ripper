// AudioWorklet host for the pad engine: the live side of the same DSP the exports render with.
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */
import { Engine } from './engine.js'

class RipperEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.engine = new Engine(sampleRate)
    this.engine.frame = currentFrame
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
      case 'on': eng.noteOn({ ...m, frame: this.frameOf(m.at) }); break
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
    if (playing !== this.reported || (playing > 0 && this.blocks % 16 === 0)) {
      this.reported = playing
      this.port.postMessage({ type: 'status', playing, triggered: eng.triggered, frame: eng.frame })
    }
    return true
  }
}

registerProcessor('ripper-engine', RipperEngineProcessor)
