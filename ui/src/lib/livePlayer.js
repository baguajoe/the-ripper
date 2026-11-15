// Main-thread side of the live pad engine (src/dsp/worklet.js): sends sources and triggers,
// tracks the voice count the worklet reports. Same API as v1.1's SlicePlayer.
import workletUrl from '../dsp/worklet.js?worker&url'
import { Engine } from '../dsp/engine.js'
import { renderBeat, renderPad } from '../dsp/render.js'

const loaded = new WeakMap() // AudioContext -> Promise (module added)

export class LivePlayer {
  /** Resolves a player on `ctx` (adds the worklet module once per context). */
  static async create(ctx) {
    if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(workletUrl))
    await loaded.get(ctx)
    return new LivePlayer(ctx)
  }

  constructor(ctx) {
    this.ctx = ctx
    this.node = new AudioWorkletNode(ctx, 'ripper-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    this.node.connect(ctx.destination)
    this.status = { playing: 0, triggered: 0, frame: 0 }
    this.triggered = 0
    this.pitched = new Set()
    this.listeners = new Set()
    this.node.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'status') this.status = m
      for (const fn of this.listeners) fn(m)
    }
    if (typeof window !== 'undefined') window.__ripperTest = { ...(window.__ripperTest || {}), player: this }
  }

  post(msg, transfer) { this.node.port.postMessage(msg, transfer || []) }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  /** The source the pads play from: {sr, channels} (copied into the worklet). */
  setSource(src, id = 'main') {
    this.stopAll()
    if (id === 'main') this.mainSrc = src
    const channels = src.channels.map((c) => c.slice())
    this.post({ type: 'source', id, sr: src.sr, channels }, channels.map((c) => c.buffer))
  }

  /** A keep-length pad's pitch-shifted copy, under its cache key. */
  setPitched(key, src) {
    if (this.pitched.has(key)) return
    this.pitched.add(key)
    this.pitchedSrc = { ...(this.pitchedSrc || {}), [`p:${key}`]: src }
    this.setSourceOnly(`p:${key}`, src)
  }

  setSourceOnly(id, src) {
    const channels = src.channels.map((c) => c.slice())
    this.post({ type: 'source', id, sr: src.sr, channels }, channels.map((c) => c.buffer))
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume()
  }

  /** Trigger a slice. opts: {bank, pad, mono, vel, when (ctx time), pitchedKey}. */
  play(slice, { bank = 0, pad = -1, mono = false, vel = 127, when, pitchedKey = null } = {}) {
    if (!slice) return
    this.resume()
    this.triggered++
    this.post({ type: 'on', slice: plain(slice), bank, pad, mono, vel, at: when,
      pitched: pitchedKey && this.pitched.has(pitchedKey) ? `p:${pitchedKey}` : null })
    if (typeof window !== 'undefined') {
      window.__ripperDebug = { ...(window.__ripperDebug || {}), padsTriggered: this.triggered, audioState: this.ctx.state, lastPad: { bank, pad, vel } }
    }
  }

  release(bank, pad, when) { this.post({ type: 'off', bank, pad, at: when }) }

  // --- sequencer transport (src/dsp/transport.js) --------------------------------------------
  /** Pads per bank for the sequencer: {banks: [{mono, vintage, pads: [slice|null] x16}]}. */
  setProgram(prog) {
    this.lastProgram = prog
    this.post({ type: 'program', program: { bpm: prog.bpm, master: prog.master, banks: prog.banks.map((b) => ({ ...b, pads: b.pads.map((s) => (s ? { ...plain(s), pitched: s.pitched || null } : null)) })) } })
  }

  setPass(pass, loop = true) { this.lastPass = pass; this.post({ type: 'pass', pass, loop }) }

  transportPlay({ countIn = false, metronome = false, record = false } = {}) {
    this.resume()
    this.post({ type: 'play', at: this.ctx.currentTime + 0.02, countIn, metronome, record })
  }

  transportStop() { this.post({ type: 'transportStop' }) }

  setRecording(on) { this.post({ type: 'record', on }) }

  setMetronome(on) { this.post({ type: 'metronome', on }) }

  /** Note repeat while a pad is held: {bank, pad, vel, rate (ticks)} or null. */
  setRepeat(r) {
    if (r) this.resume()
    this.post({ type: 'repeat', repeat: r })
  }

  get transport() { return { playing: !!this.status.transport, recording: !!this.status.recording, tick: this.status.tick, pass: this.status.pass } }

  // --- resample -----------------------------------------------------------------------------
  _captured() {
    return new Promise((resolve) => {
      const off = this.on((m) => { if (m.type === 'captured') { off(); resolve({ sr: m.sr, channels: m.channels }) } })
    })
  }

  /** Record everything the pads / sequencer play until stopCapture(); resolves {sr, channels}. */
  startCapture() {
    this.resume()
    const done = this._captured()
    this.post({ type: 'capture', on: true })
    return done
  }

  stopCapture() { this.post({ type: 'capture', on: false }) }

  /** One pass of the pattern / song from its first sample (+ effect tails), recorded. */
  resamplePass({ maxTail = 6 } = {}) {
    this.resume()
    const done = this._captured()
    this.post({ type: 'resample', at: this.ctx.currentTime + 0.05, maxTail })
    return done
  }

  /** Offline render of exactly what resamplePass() records (tests, beat exports). */
  renderPass(opts = {}) {
    return renderBeat({ main: this.mainSrc, ...(this.pitchedSrc || {}) }, this.lastProgram, this.lastPass, { sr: this.ctx.sampleRate, ...opts })
  }

  /** Tests: record the frames the sequencer fires on, then fetch them. */
  traceFires(on) { this.post({ type: 'traceFires', on }) }

  fires() {
    return new Promise((resolve) => {
      const off = this.on((m) => { if (m.type === 'fires') { off(); resolve(m.fires) } })
      this.post({ type: 'getFires' })
    })
  }

  stopAll(when) { this.post({ type: 'stop', at: when }) }

  get playing() { return this.status.playing }

  dispose() {
    this.post({ type: 'stop' })
    this.post({ type: 'removeSource', id: 'main' })
    for (const k of this.pitched) this.post({ type: 'removeSource', id: `p:${k}` })
    try { this.node.disconnect() } catch { /* already */ }
    this.node.port.onmessage = null
    this.listeners.clear()
    this.mainSrc = null
    this.pitchedSrc = null
    if (typeof window !== 'undefined' && window.__ripperTest?.player === this) window.__ripperTest.player = null
  }
}

/** Only the fields the engine reads (no functions / React state). */
export function plain(s) {
  const { start, end, reverse, gain, fadeIn, fadeOut, choke, padMode, tune, fine, keepLength, env, filter, velVol, velFilter, pan, fx } = s
  return { start, end, reverse, gain, fadeIn, fadeOut, choke, padMode, tune, fine, keepLength, env, filter, velVol, velFilter, pan, fx }
}

// e2e: tests render the app's own engine offline (the mono-choke test, shaping renders).
if (typeof window !== 'undefined') window.__ripperTest = { ...(window.__ripperTest || {}), Engine, renderPad, renderBeat }
