// Applying the editor's program to an engine (pads per bank, mono, vintage). Shared by the
// AudioWorklet and offline renders.
import { Vintage } from './vintage.js'

/**
 * prog: {banks: [{mono, vintage, pads: [slice|null] x16}]} (slices may carry `pitched`, a source id).
 * Keeps existing vintage processors when their mode didn't change (no clicks while playing).
 */
export function applyProgram(engine, transport, prog) {
  transport?.setProgram(prog)
  prog.banks.forEach((b, i) => {
    const mode = b.vintage && b.vintage !== 'off' ? b.vintage : null
    const cur = engine.bankFx[i]
    if (!mode) engine.bankFx[i] = null
    else if (!(cur instanceof Vintage) || cur.mode !== mode) engine.bankFx[i] = new Vintage(engine.sr, mode)
  })
}
