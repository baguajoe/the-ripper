// Exporting the beat: the full beat WAV, the pattern / song MIDI, one WAV per used pad (all the
// same length from bar 1) and "chops in original position". Audio is rendered by the pad engine
// (offline, at the track's rate), uploaded as clips, and the engine writes the files
// (docs/formats.md#beat-exports).
import { api } from '../api.js'
import { fxTail } from '../dsp/fx.js'
import { planarBytes, renderBeat } from '../dsp/render.js'
import { buildMidi, passEvents } from './sequence.js'
import { BANKS } from './pads.js'
import { padSlice } from './program.js'

const b64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** What the pass is called in file names: "A", "B" or "song". */
export const passLabel = (seq) => (seq.mode === 'song' && seq.song.length ? 'song' : seq.current)

/**
 * The engine program for a beat render. opts: {fx: include pad effects, master: include the master bus}.
 * engineProgram: what the live player got ({bpm, master, banks: [{mono, vintage, pads}]}).
 */
function beatProgram(engineProgram, { fx = true, master = true } = {}) {
  return {
    ...engineProgram,
    master: master ? engineProgram.master : null,
    banks: engineProgram.banks.map((b) => ({ ...b, pads: b.pads.map((s) => (s && !fx ? { ...s, fx: undefined } : s)) })),
  }
}

/** Seconds of tail after the last bar so every file of a beat export has the same length. */
export function beatTail(engineProgram, pass, { fx = true, master = true } = {}) {
  let t = 0
  if (fx) {
    for (const e of pass.events) t = Math.max(t, fxTail(engineProgram.banks[e.bank]?.pads?.[e.pad]?.fx, pass.bpm))
  }
  if (master && engineProgram.master) t += fxTail(engineProgram.master, pass.bpm)
  return Math.min(10, t)
}

/** Pads the pass plays, in order (bank, pad). */
export function usedPads(pass) {
  const seen = new Map()
  for (const e of pass.events) seen.set(`${e.bank}:${e.pad}`, [e.bank, e.pad])
  return [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

const padNumber = (bank, pad) => bank * 16 + pad + 1

async function upload(pcm, sr) {
  return api.uploadClip(planarBytes(pcm), sr, 2)
}

/**
 * Export parts for the engine ({items, midi_items, positioned}) for any of:
 *   what: {beat, midi, stems, chops}; ctx: {program (editor), engineProgram, sources ({main, p:…}), seq, bpm,
 *   duration, fx, master, range: {start, end}, chopSlices: [slices], folders}
 */
export async function beatParts(what, ctx) {
  const { seq, bpm, sources } = ctx
  const pass = { ...passEvents(seq), bpm, swing: seq.swing }
  const sr = sources.main.sr
  const label = passLabel(seq)
  const opts = { fx: ctx.fx !== false, master: ctx.master !== false }
  const prog = beatProgram(ctx.engineProgram, opts)
  const tail = beatTail(ctx.engineProgram, pass, opts)
  const out = { items: [], midi_items: [], positioned: null }
  const loop = tail === 0
  if ((what.beat || what.stems) && !pass.events.length) throw new Error(`Pattern ${label} is empty — add some steps first`)
  if (what.beat) {
    const clip = await upload(renderBeat(sources, prog, pass, { sr, tail }), sr)
    out.items.push({ clip, prefix: 'beat', name: label, folder: 'Beat', loop })
  }
  if (what.stems) {
    const pads = usedPads(pass)
    const width = pads.some(([b, p]) => padNumber(b, p) > 99) ? 3 : 2
    for (const [bank, pad] of pads) {
      const clip = await upload(renderBeat(sources, prog, pass, { sr, tail, solo: [`${bank}:${pad}`] }), sr)
      const s = padSlice(ctx.program.banks[bank], pad)
      out.items.push({ clip, prefix: `pad${String(padNumber(bank, pad)).padStart(width, '0')}`, name: s?.name || `${BANKS[bank]}${pad + 1}`, folder: 'Beat/Pad stems', loop })
    }
  }
  if (what.midi) {
    if (!pass.events.length) throw new Error(`Pattern ${label} is empty — add some steps first`)
    out.midi_items.push({ data_b64: b64(buildMidi(pass, bpm, `${ctx.title || 'The Ripper'} ${label}`)), prefix: 'pattern', name: label, folder: 'MIDI' })
  }
  if (what.allPatterns) { // kits: every pattern with notes, and the song
    for (const [id, p] of Object.entries(seq.patterns)) {
      if (!p.notes.length) continue
      const ps = passEvents({ ...seq, current: id }, 'pattern')
      out.midi_items.push({ data_b64: b64(buildMidi(ps, bpm, `pattern ${id}`)), prefix: 'pattern', name: id, folder: 'MIDI' })
    }
    if (seq.song.length) out.midi_items.push({ data_b64: b64(buildMidi(passEvents(seq, 'song'), bpm, 'song')), prefix: 'pattern', name: 'song', folder: 'MIDI' })
  }
  if (what.chops) {
    const slices = [...(ctx.chopSlices || [])].sort((a, b) => a.start - b.start)
    if (!slices.length) throw new Error('No chops to export')
    const { start, end } = ctx.range ?? { start: 0, end: ctx.duration }
    out.positioned = {
      start, end, folder: 'Chops in place',
      slices: slices.map((s) => ({ start: s.start, end: s.end, name: s.name, source: s.source || 'mix' })),
    }
  }
  return out
}
