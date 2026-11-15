// Pad sound-shaping parameters: defaults, ranges and the small pure functions the engine,
// the UI and the exporters share. A pad whose shaping is all defaults sounds (and exports)
// exactly like a v1.1 slice: cut, reverse, gain, fades.

export const CUT_FADE = 0.005 // seconds: de-click ramp when a voice is cut (mono / choke / stop)
export const FULL_VELOCITY = 127
export const DEFAULT_VELOCITY = 100 // sequencer steps; accented steps play at FULL_VELOCITY

export const TUNE_RANGE = 24 // semitones either way
export const FINE_RANGE = 50 // cents either way
export const FILTER_TYPES = ['off', 'lp', 'hp', 'bp']
export const FILTER_MIN_HZ = 20
export const FILTER_MAX_HZ = 20000
export const VEL_FILTER_OCTAVES = 4 // velocity -> filter at amount 1: up to 4 octaves lower at velocity 0

export const DEFAULT_ENV = Object.freeze({ a: 0, d: 0, s: 1, r: 0 })
export const DEFAULT_FILTER = Object.freeze({ type: 'off', cutoff: FILTER_MAX_HZ, res: 0 })

/** Every shaping field with its default. */
export const DEFAULT_SHAPING = Object.freeze({
  tune: 0, // semitones
  fine: 0, // cents
  keepLength: false, // tune by time-stretching (length stays) instead of by speed
  env: DEFAULT_ENV,
  filter: DEFAULT_FILTER,
  velVol: 1, // 0..1: how much velocity changes the level
  velFilter: 0, // 0..1: how much velocity closes the filter
  pan: 0, // -1 (left) .. 1 (right)
})

export const PAD_COLORS = ['#ff5c39', '#ffd23f', '#7bd88f', '#40c4ff', '#b18cff', '#ff7ab6', '#9aa4b8', '#ff9f43']

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

/** A slice's shaping with defaults filled in and every value clamped to its range. */
export function shaping(s = {}) {
  const env = { ...DEFAULT_ENV, ...(s.env || {}) }
  const filter = { ...DEFAULT_FILTER, ...(s.filter || {}) }
  return {
    tune: clamp(Math.round(num(s.tune, 0)), -TUNE_RANGE, TUNE_RANGE),
    fine: clamp(num(s.fine, 0), -FINE_RANGE, FINE_RANGE),
    keepLength: !!s.keepLength,
    env: {
      a: clamp(num(env.a, 0), 0, 10),
      d: clamp(num(env.d, 0), 0, 10),
      s: clamp(num(env.s, 1), 0, 1),
      r: clamp(num(env.r, 0), 0, 10),
    },
    filter: {
      type: FILTER_TYPES.includes(filter.type) ? filter.type : 'off',
      cutoff: clamp(num(filter.cutoff, FILTER_MAX_HZ), FILTER_MIN_HZ, FILTER_MAX_HZ),
      res: clamp(num(filter.res, 0), 0, 1),
    },
    velVol: clamp(num(s.velVol, 1), 0, 1),
    velFilter: clamp(num(s.velFilter, 0), 0, 1),
    pan: clamp(num(s.pan, 0), -1, 1),
  }
}

/** Semitones (tune + fine) of a slice. */
export const semitones = (s) => {
  const sh = shaping(s)
  return sh.tune + sh.fine / 100
}

/** Playback-speed ratio for pitch (1 = original). Keep-length pads play at speed 1 from a pitched copy. */
export const pitchRatio = (st) => Math.pow(2, st / 12)

/** Level from velocity (1..127) and the pad's velocity->volume amount. */
export function velocityGain(vel, amount) {
  const v = clamp(num(vel, FULL_VELOCITY), 0, FULL_VELOCITY) / FULL_VELOCITY
  return (1 - amount) + amount * v
}

/** Filter cutoff after velocity: full velocity leaves it alone, softer hits lower it. */
export function velocityCutoff(cutoff, vel, amount) {
  const v = clamp(num(vel, FULL_VELOCITY), 0, FULL_VELOCITY) / FULL_VELOCITY
  return clamp(cutoff * Math.pow(2, -amount * VEL_FILTER_OCTAVES * (1 - v)), FILTER_MIN_HZ, FILTER_MAX_HZ)
}

/** Resonance 0..1 -> filter Q (0 = a flat Butterworth response). */
export const resToQ = (res) => Math.SQRT1_2 + clamp(res, 0, 1) * (12 - Math.SQRT1_2)

const near = (a, b) => Math.abs(a - b) < 1e-9

/** True when the slice's sound is changed by any shaping field (it then exports via a rendered clip). */
export function isShaped(s = {}) {
  const sh = shaping(s)
  return !(sh.tune === 0 && near(sh.fine, 0)
    && near(sh.env.a, 0) && near(sh.env.d, 0) && near(sh.env.s, 1) && near(sh.env.r, 0)
    && sh.filter.type === 'off' && near(sh.pan, 0) && !hasFx(s))
}

/** Per-pad effects (v1.2 phase 3) — any switched on? */
export const hasFx = (s = {}) => !!s.fx && Object.values(s.fx).some((f) => f && f.on && Number(f.mix ?? 1) > 0)

/** The pitch-shifted copy a keep-length pad plays from, or null (key used for caching). */
export function pitchedKey(s) {
  const st = semitones(s)
  if (!s.keepLength || near(st, 0)) return null
  return `${(s.source || 'mix')}:${Number(s.start).toFixed(6)}:${Number(s.end).toFixed(6)}:${st.toFixed(4)}`
}

/** Envelope gain at time t (s) for a gate that closed at tOff (Infinity = still held). */
export function envelopeAt(env, t, tOff = Infinity) {
  const held = (x) => {
    if (x < 0) return 0
    if (env.a > 0 && x < env.a) return x / env.a
    const y = x - env.a
    if (env.d > 0 && y < env.d) return 1 - (1 - env.s) * (y / env.d)
    return env.s
  }
  if (t < tOff) return held(t)
  const at = held(tOff)
  if (env.r <= 0) return 0
  return Math.max(0, at * (1 - (t - tOff) / env.r))
}
