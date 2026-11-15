// Offline rendering with the same engine the pads play through (exports, resample, tests).
import { Engine } from './engine.js'
import { Voice } from './voice.js'
import { Transport } from './transport.js'
import { applyProgram } from './program.js'

/** Output frames a slice plays for (tune changes speed; keep-length pads keep their length). */
export function voiceFrames(source, slice, sr, pitched = null) {
  const v = new Voice({ src: source, slice: { ...slice, padMode: 'oneshot' }, outSr: sr, pitched })
  return Math.ceil(v.lengthOut - 1e-9)
}

/**
 * One pad as it exports: the whole slice as a one-shot at full velocity (the gate stays open,
 * a release fits inside the end), with its shaping, bank processing and effects tail.
 * source: {channels, sr}. Returns [L, R] Float32Arrays at `sr` (default: the source's rate).
 */
export function renderPad(source, slice, { sr = source.sr, vel = 127, pitched = null, bankFx = null, tail = 0, bank = 0, bpm = 120 } = {}) {
  const eng = new Engine(sr)
  eng.bpm = bpm
  eng.setSource('main', source.channels, source.sr)
  if (pitched) eng.setSource('pitched', pitched.channels, pitched.sr)
  if (bankFx) eng.bankFx[bank] = bankFx
  eng.noteOn({ slice: { ...slice, padMode: 'oneshot' }, bank, pad: 0, vel, frame: 0, pitched: pitched ? 'pitched' : null })
  return eng.render(voiceFrames(source, slice, sr, pitched) + Math.max(0, Math.round(tail * sr)))
}

/** Planar float32 bytes (channel 0 then 1) for uploading a render as a clip. */
export function planarBytes([L, R]) {
  const out = new Float32Array(L.length * 2)
  out.set(L, 0)
  out.set(R, L.length)
  return out.buffer
}

/**
 * The beat, offline: one pass (lib/sequence.js passEvents + bpm + swing) through the program,
 * no loop. sources: {id: {channels, sr}} ('main' = the track). solo: only these "bank:pad" keys.
 * Returns [L, R] of the pass length + tail seconds.
 */
export function renderBeat(sources, prog, pass, { sr = sources.main.sr, tail = 0, solo = null } = {}) {
  const eng = new Engine(sr)
  for (const [id, s] of Object.entries(sources)) eng.setSource(id, s.channels, s.sr)
  const tr = new Transport(eng)
  applyProgram(eng, tr, prog)
  if (solo) eng.solo = new Set(solo) // every pad still triggers (mono / choke cuts happen); only these are heard
  tr.setPass(pass, false)
  tr.play(0)
  return eng.render(tr.passFrames + Math.max(0, Math.round(tail * sr)))
}
