// Step sequencer model + timing. Pure functions; the same event list drives the live engine,
// offline renders and the MIDI export, so they can't disagree.
//
// Time is in ticks, PPQ = 960 (a 16th = 240 ticks). Swing moves every second 16th of each 8th
// pair: at S% it starts at S% of the pair (50% straight, 66.7% triplet feel, 75% hardest).
// Positions in between are warped linearly, so 32nds and note repeats swing too. Swung ticks are
// rounded to whole ticks — the exact values the MIDI file gets.

export const PPQ = 960
export const STEP = PPQ / 4 // a 16th
export const PAIR = 2 * STEP // an 8th: the swing unit
export const PATTERN_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
export const FREE_PATTERNS = 2 // A and B without Pro (features.patterns_beyond_b)
export const LENGTHS = [16, 32, 64] // steps: 1, 2 or 4 bars
export const DEFAULT_VEL = 100
export const ACCENT_VEL = 127
export const SWING_MIN = 50
export const SWING_MAX = 75
export const REPEAT_RATES = { '1/8': PAIR, '1/16': STEP, '1/32': STEP / 2, '1/8T': (PAIR * 2) / 3, '1/16T': (STEP * 2) / 3 }
export const QUANTIZE = { off: 0, '1/8': PAIR, '1/16': STEP, '1/32': STEP / 2 }
export const MIDI_BASE_NOTE = 36 // C1: bank A pad 1

export const emptyPattern = (steps = 16) => ({ steps, notes: [], accents: [] })
export const emptySeq = () => ({
  patterns: Object.fromEntries(PATTERN_IDS.map((id) => [id, emptyPattern()])),
  current: 'A',
  song: [],
  mode: 'pattern', // 'pattern' | 'song'
  swing: SWING_MIN,
})

const clampSwing = (s) => Math.min(SWING_MAX, Math.max(SWING_MIN, Number(s) || SWING_MIN))

/** Swung position of a straight tick (whole ticks). */
export function swingTick(tick, swing) {
  const s = clampSwing(swing)
  if (s === SWING_MIN) return tick
  const base = Math.floor(tick / PAIR) * PAIR
  const pos = tick - base
  const mid = (s / 100) * PAIR
  const w = pos <= STEP ? (pos / STEP) * mid : mid + ((pos - STEP) / STEP) * (PAIR - mid)
  return base + Math.round(w)
}

/** Straight tick for a swung (played) position — recording undoes the swing before quantizing. */
export function unswingTick(tick, swing) {
  const s = clampSwing(swing)
  if (s === SWING_MIN) return tick
  const base = Math.floor(tick / PAIR) * PAIR
  const pos = tick - base
  const mid = (s / 100) * PAIR
  return base + (pos <= mid ? (pos / mid) * STEP : STEP + ((pos - mid) / (PAIR - mid)) * STEP)
}

export function quantizeTick(tick, q) {
  const g = typeof q === 'number' ? q : QUANTIZE[q] || 0
  return g ? Math.round(tick / g) * g : Math.round(tick)
}

export const patternTicks = (p) => (p?.steps || 16) * STEP
export const ticksToSeconds = (ticks, bpm) => (ticks * 60) / (bpm * PPQ)
export const secondsToTicks = (sec, bpm) => (sec * bpm * PPQ) / 60

/** Velocity a note plays at (accented steps play at full velocity). */
export function noteVelocity(p, n) {
  const step = Math.round(n.tick / STEP)
  return (p.accents || []).includes(step) ? ACCENT_VEL : n.vel ?? DEFAULT_VEL
}

/**
 * Note events of one pass through a pattern or the song: [{tick, offTick, bank, pad, vel, pattern}],
 * tick = swung whole ticks from the start of the pass. Returns {events, length (ticks)}.
 */
export function passEvents(seq, mode = seq.mode) {
  const order = mode === 'song' && seq.song.length ? seq.song : [seq.current]
  const events = []
  let at = 0
  for (const id of order) {
    const p = seq.patterns[id]
    if (!p) continue
    const len = patternTicks(p)
    for (const n of p.notes) {
      if (n.tick < 0 || n.tick >= len) continue
      const on = swingTick(n.tick, seq.swing)
      const off = Math.max(on + 1, swingTick(n.tick + Math.max(1, n.len ?? STEP), seq.swing))
      events.push({ tick: at + on, offTick: at + off, bank: n.bank, pad: n.pad, vel: noteVelocity(p, n), pattern: id })
    }
    at += len
  }
  events.sort((a, b) => a.tick - b.tick || a.bank - b.bank || a.pad - b.pad)
  return { events, length: at }
}

/** Events with frames at sample rate sr (frame = round(seconds * sr)). */
export function eventFrames(pass, bpm, sr) {
  const f = (t) => Math.round(ticksToSeconds(t, bpm) * sr)
  return { length: f(pass.length), events: pass.events.map((e) => ({ ...e, frame: f(e.tick), offFrame: f(e.offTick) })) }
}

// --- pattern edits (immutable) ---------------------------------------------------------------
const stepOf = (tick) => Math.round(tick / STEP)

/** Notes of pad (bank, pad) at a grid step. */
export const notesAt = (p, bank, pad, step) => p.notes.filter((n) => n.bank === bank && n.pad === pad && stepOf(n.tick) === step)

export function toggleStep(p, bank, pad, step, vel = DEFAULT_VEL) {
  if (notesAt(p, bank, pad, step).length) {
    return { ...p, notes: p.notes.filter((n) => !(n.bank === bank && n.pad === pad && stepOf(n.tick) === step)) }
  }
  return { ...p, notes: [...p.notes, { bank, pad, tick: step * STEP, vel, len: STEP }] }
}

export function setStepVelocity(p, bank, pad, step, vel) {
  const v = Math.max(1, Math.min(127, Math.round(vel)))
  return { ...p, notes: p.notes.map((n) => (n.bank === bank && n.pad === pad && stepOf(n.tick) === step ? { ...n, vel: v } : n)) }
}

export function toggleAccent(p, step) {
  const a = p.accents || []
  return { ...p, accents: a.includes(step) ? a.filter((x) => x !== step) : [...a, step].sort((x, y) => x - y) }
}

/** Change the length; notes past the new end are kept but don't play (they come back if it grows). */
export const setLength = (p, steps) => ({ ...p, steps })

/** Add a recorded hit (straight tick, already un-swung) with quantize. */
export function addHit(p, { bank, pad, tick, vel, len = STEP }, q = 'off') {
  const L = patternTicks(p)
  const t = ((quantizeTick(tick, q) % L) + L) % L
  // a hit on top of an identical note replaces it (no doubled notes when overdubbing a loop)
  const notes = p.notes.filter((n) => !(n.bank === bank && n.pad === pad && Math.abs(n.tick - t) < 1))
  return { ...p, notes: [...notes, { bank, pad, tick: t, vel: Math.max(1, Math.min(127, Math.round(vel))), len: Math.max(1, Math.round(len)) }] }
}

export const clearPattern = (p) => ({ ...p, notes: [], accents: [] })

// --- MIDI file (type 1, PPQ 960) -------------------------------------------------------------
const vlq = (n) => {
  const out = [n & 0x7f]
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80)
  return out
}
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const text = (s) => [...new TextEncoder().encode(s.slice(0, 60))]

/** MIDI note for a pad: C1 (36) for bank A pad 1, upward through the banks. */
export const padNote = (bank, pad) => Math.min(127, MIDI_BASE_NOTE + bank * 16 + pad)

/** A pass as a Standard MIDI File (Uint8Array): the exact ticks the sequencer plays. */
export function buildMidi(pass, bpm, name = 'The Ripper beat') {
  const tempo = Math.round(60_000_000 / bpm)
  const meta = [
    0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255,
    0, 0xff, 0x58, 4, 4, 2, 24, 8,
    0, 0xff, 0x03, ...vlq(text(name).length), ...text(name),
    ...vlq(Math.max(0, pass.length)), 0xff, 0x2f, 0,
  ]
  const ev = []
  for (const e of pass.events) {
    const note = padNote(e.bank, e.pad)
    ev.push([e.tick, 1, [0x99, note, e.vel]]) // channel 10
    ev.push([e.offTick, 0, [0x89, note, 0]])
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const notes = [0, 0xff, 0x03, 4, ...text('Pads')]
  let last = 0
  for (const [t, , msg] of ev) { notes.push(...vlq(t - last), ...msg); last = t }
  notes.push(...vlq(Math.max(0, pass.length - last)), 0xff, 0x2f, 0)
  const chunk = (id, body) => [...text(id), ...u32(body.length), ...body]
  return new Uint8Array([
    ...chunk('MThd', [0, 1, 0, 2, (PPQ >> 8) & 255, PPQ & 255]),
    ...chunk('MTrk', meta),
    ...chunk('MTrk', notes),
  ])
}

/** Parse note-ons back out of a MIDI file (tests + import): [{tick, note, vel}], ppq, tempo. */
export function parseMidi(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let o = 0
  const rd32 = () => { const v = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]; o += 4; return v >>> 0 }
  const id = () => String.fromCharCode(d[o++], d[o++], d[o++], d[o++])
  if (id() !== 'MThd') throw new Error('not a MIDI file')
  rd32()
  o += 4
  const ppq = (d[o] << 8) | d[o + 1]
  o += 2
  const notes = []
  let tempo = 500000
  while (o < d.length) {
    const cid = id()
    const len = rd32()
    const end = o + len
    if (cid !== 'MTrk') { o = end; continue }
    let t = 0
    let status = 0
    while (o < end) {
      let dt = 0
      let b
      do { b = d[o++]; dt = (dt << 7) | (b & 0x7f) } while (b & 0x80)
      t += dt
      if (d[o] & 0x80) status = d[o++]
      if (status === 0xff) {
        const type = d[o++]
        let l = 0
        do { b = d[o++]; l = (l << 7) | (b & 0x7f) } while (b & 0x80)
        if (type === 0x51) tempo = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]
        o += l
      } else if ((status & 0xf0) === 0x90 || (status & 0xf0) === 0x80) {
        const note = d[o++]
        const vel = d[o++]
        if ((status & 0xf0) === 0x90 && vel > 0) notes.push({ tick: t, note, vel })
      } else {
        o += (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2
      }
    }
    o = end
  }
  return { ppq, tempo, notes }
}
