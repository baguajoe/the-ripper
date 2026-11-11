// Zero-latency pad playback with Web Audio AudioBuffers.
// Same per-slice DSP as the exporter (reverse, gain dB, linear fades) so what you hear on
// a pad is what lands in the DAW.

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

  /** Trigger a slice now. Returns the voice (call .stop()). */
  play(slice, { onEnded } = {}) {
    if (!this.buffer || !slice) return null
    if (this.ctx.state !== 'running') this.ctx.resume()
    if (slice.choke) for (const v of this.voices) if (v.choke) v.stop()

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
    const t0 = this.ctx.currentTime
    const level = dbToGain(slice.gain)
    const fi = Math.min(dur, Math.max(0, slice.fadeIn || 0))
    const fo = Math.min(dur, Math.max(0, slice.fadeOut || 0))
    g.gain.setValueAtTime(fi > 0 ? 0 : level, t0)
    if (fi > 0) g.gain.linearRampToValueAtTime(level, t0 + fi)
    if (fo > 0) {
      g.gain.setValueAtTime(level, t0 + dur - fo)
      g.gain.linearRampToValueAtTime(0, t0 + dur)
    }
    src.connect(g).connect(this.out)
    src.start(t0, offset, dur)
    this.triggered++

    const voice = {
      choke: !!slice.choke,
      stop: () => { try { src.stop() } catch { /* already stopped */ } },
    }
    this.voices.add(voice)
    src.onended = () => {
      this.voices.delete(voice)
      onEnded?.()
    }
    if (typeof window !== 'undefined') {
      window.__ripperDebug = { ...(window.__ripperDebug || {}), padsTriggered: this.triggered, audioState: this.ctx.state }
    }
    return voice
  }

  stopAll() {
    for (const v of [...this.voices]) v.stop()
    this.voices.clear()
  }
}
