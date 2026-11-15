// RBJ "Audio EQ Cookbook" biquads (the same formulas as Web Audio's BiquadFilterNode),
// transposed direct form II, one state pair per channel. Doubles throughout.

/** Coefficients {b0,b1,b2,a1,a2} (normalised by a0) for type 'lp' | 'hp' | 'bp'. */
export function biquadCoeffs(type, freq, q, sr) {
  const f = Math.min(Math.max(freq, 1), sr * 0.49)
  const w0 = (2 * Math.PI * f) / sr
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.max(q, 1e-4))
  let b0
  let b1
  let b2
  if (type === 'hp') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2
  } else if (type === 'bp') {
    b0 = alpha; b1 = 0; b2 = -alpha // constant 0 dB peak gain
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2
  }
  const a0 = 1 + alpha
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
}

export class Biquad {
  constructor(c, channels = 2) {
    this.c = c
    this.z1 = new Float64Array(channels)
    this.z2 = new Float64Array(channels)
  }

  set(c) { this.c = c }

  reset() { this.z1.fill(0); this.z2.fill(0) }

  /** One sample of channel ch. */
  tick(x, ch) {
    const { b0, b1, b2, a1, a2 } = this.c
    const y = b0 * x + this.z1[ch]
    this.z1[ch] = b1 * x - a1 * y + this.z2[ch]
    this.z2[ch] = b2 * x - a2 * y
    return y
  }
}

/** One-pole smoother / DC-safe lowpass coefficient for a time constant in seconds. */
export const onePole = (seconds, sr) => (seconds <= 0 ? 0 : Math.exp(-1 / (seconds * sr)))
