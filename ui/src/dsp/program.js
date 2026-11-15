// Applying the editor's program to an engine (pads per bank, mono, vintage). Shared by the
// AudioWorklet and offline renders.
import { Vintage } from './vintage.js'
import { FxChain } from './fx.js'

/**
 * prog: {banks: [{mono, vintage, pads: [slice|null] x16}], bpm, master} (slices may carry `pitched`, a source id).
 * Keeps existing vintage processors when their mode didn't change (no clicks while playing).
 */
export function applyProgram(engine, transport, prog) {
  transport?.setProgram(prog)
  if (prog.bpm) engine.bpm = prog.bpm
  // master effects
  const m = prog.master
  const chain = m ? (engine.master || new FxChain(engine.sr, { master: true })).configure(m, engine.bpm) : null
  engine.master = chain && chain.enabled ? chain : null
  // live tweaks of pads that already have an effects bus
  prog.banks.forEach((b, i) => (b.pads || []).forEach((s, pad) => { if (s) engine.setPadFx(i, pad, s.fx) }))
  prog.banks.forEach((b, i) => {
    const mode = b.vintage && b.vintage !== 'off' ? b.vintage : null
    const cur = engine.bankFx[i]
    if (!mode) engine.bankFx[i] = null
    else if (!(cur instanceof Vintage) || cur.mode !== mode) engine.bankFx[i] = new Vintage(engine.sr, mode)
  })
}
