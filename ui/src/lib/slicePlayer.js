// Zero-latency pad playback with Web Audio AudioBuffers.
// Same per-slice DSP as the exporter (reverse, gain dB, linear fades) so what you hear on
// a pad is what lands in the DAW.
//
// Like an MPC:
//   * Mono bank (default): hitting a pad cuts whatever that bank is playing (5 ms fade).
//   * Poly bank: pads ring out over each other (one-shots).
//   * Choke flag: choked pads cut each other in any bank (a choke group).
//   * Pad mode "noteon": the pad plays only while held; release() fades it out.

export const CUT_FADE = 0.005 // seconds: de-click fade when a voice is cut

const dbToGain = (db) => Math.pow(10, (Number(db) || 0) / 20)

export class SlicePlayer {
  constructor(ctx) {
    this.ctx = ctx
    this.buffer = null
    this.reversed = new Map()
    this.voices = new Set()
    this.out = ctx.createGain()
    this.out.connect(ctx.destination)
    this.triggered = 0
  }

  setBuffer(buffer) {
    this.stopAll()
    this.buffer = buffer
    this.reversed.clear()
  }

  _reversedSegment(start, end) {
    const key = `${start.toFixed(6)}:${end.toFixed(6)}`
    let buf = this.reversed.get(key)
    if (buf) return buf
    const src = this.buffer
    const a = Math.max(0, Math.round(start * src.sampleRate))
    const b = Math.min(src.length, Math.round(end * src.sampleRate))
    const n = Math.max(1, b - a)
    buf = this.ctx.createBuffer(src.numberOfChannels, n, src.sampleRate)
    for (let c = 0; c < src.numberOfChannels; c++) {
      const from = src.getChannelData(c).subarray(a, b)
      const to = buf.getChannelData(c)
      for (let i = 0; i < from.length; i++) to[i] = from[from.length - 1 - i]
    }
    if (this.reversed.size > 64) this.reversed.delete(this.reversed.keys().next().value)
    this.reversed.set(key, buf)
    return buf
  }

  /**
   * Trigger a slice. opts: { bank, pad, mono, when (ctx time; default now), onEnded }.
   * Returns the voice ({ stop(when?) }).
   */
  play(slice, { bank = 0, pad = -1, mono = false, when, onEnded } = {}) {
    if (!this.buffer || !slice) return null
    const live = typeof this.ctx.startRendering !== 'function' // an OfflineAudioContext renders on demand
    if (live && this.ctx.state !== 'running') this.ctx.resume()
    const t0 = when ?? this.ctx.currentTime
    for (const v of this.voices) {
      if ((mono && v.bank === bank) || (slice.choke && v.choke)) v.stop(t0)
    }

    const dur = Math.max(0.001, slice.end - slice.start)
    const src = this.ctx.createBufferSource()
    let offset = slice.start
    if (slice.reverse) {
      src.buffer = this._reversedSegment(slice.start, slice.end)
      offset = 0
    } else {
      src.buffer = this.buffer
    }
    const g = this.ctx.createGain()
    const level = dbToGain(slice.gain)
    const fi = Math.min(dur, Math.max(0, slice.fadeIn || 0))
    const fo = Math.min(dur, Math.max(0, slice.fadeOut || 0))
    g.gain.setValueAtTime(fi > 0 ? 0 : level, t0)
    if (fi > 0) g.gain.linearRampToValueAtTime(level, t0 + fi)
    if (fo > 0) {
      g.gain.setValueAtTime(level, t0 + dur - fo)
      g.gain.linearRampToValueAtTime(0, t0 + dur)
    }
    /** The gain this voice's envelope has at time t (fade in / hold / fade out). */
    const envelopeAt = (t) => {
      if (fi > 0 && t < t0 + fi) return level * Math.max(0, t - t0) / fi
      if (fo > 0 && t > t0 + dur - fo) return level * Math.max(0, t0 + dur - t) / fo
      return level
    }
    src.connect(g).connect(this.out)
    src.start(t0, offset, dur)
    this.triggered++

    const voice = {
      bank,
      pad,
      choke: !!slice.choke,
      noteOn: slice.padMode === 'noteon',
      stopping: false,
      /** Fade out over CUT_FADE from `at` (default now), then stop. */
      stop: (at) => {
        if (voice.stopping) return
        voice.stopping = true
        const t = Math.max(at ?? this.ctx.currentTime, t0)
        try {
          // Pin the envelope's value at t, then ramp to 0. (A ramp starts at the PREVIOUS
          // automation event, so without the pin it would fade from the voice's start.)
          g.gain.cancelScheduledValues(t)
          g.gain.setValueAtTime(envelopeAt(t), t)
          g.gain.linearRampToValueAtTime(0, t + CUT_FADE)
          src.stop(t + CUT_FADE + 0.001)
        } catch { /* already stopped */ }
      },
    }
    this.voices.add(voice)
    src.onended = () => {
      this.voices.delete(voice)
      onEnded?.()
    }
    if (typeof window !== 'undefined' && live) {
      window.__ripperDebug = { ...(window.__ripperDebug || {}), padsTriggered: this.triggered, audioState: this.ctx.state }
      window.__ripperTest = { ...(window.__ripperTest || {}), player: this } // e2e: voices still playing
    }
    return voice
  }

  /** Pad released: fade out its note-on voices. */
  release(bank, pad, when) {
    for (const v of this.voices) if (v.noteOn && v.bank === bank && v.pad === pad) v.stop(when)
  }

  /** Stop everything (Esc / Stop), with the short de-click fade. */
  stopAll(when) {
    for (const v of [...this.voices]) v.stop(when)
    this.voices.clear()
  }

  get playing() {
    return [...this.voices].filter((v) => !v.stopping).length
  }
}

// e2e: the mono-choke test renders this exact class in an OfflineAudioContext.
if (typeof window !== 'undefined') window.__ripperTest = { ...(window.__ripperTest || {}), SlicePlayer }
