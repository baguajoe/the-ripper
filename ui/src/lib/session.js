// Session files (.ripper): the editor state saved with the audio (the engine writes the file,
// docs/formats.md#sessions). State versions + migrations live here so older sessions always open.
//
//   v1: the pad program alone, as v1.1 kept it ({version: 1, banks: [{slices, mono, chop}], chop})
//   v2 (v1.2): {version: 2, source, program: {banks, seq, master}, editor: {...}, export: {...}}
import { emptyBank, renumberBank, withDefaults, BANK_COUNT } from './program.js'
import { PATTERN_IDS, emptyPattern, emptySeq } from './sequence.js'

export const SESSION_VERSION = 2

/** The state to save from an editor. */
export function sessionState({ program, source = 'mix', editor = {}, exportOptions = null }) {
  return { version: SESSION_VERSION, source, program, editor, export: exportOptions }
}

const MIGRATIONS = {
  // v1 -> v2: wrap the program, add the sequencer / master / editor sections
  1: (s) => ({ version: 2, source: s.source || 'mix', program: { banks: s.banks || [] }, editor: { chop: s.chop }, export: null }),
}

/** Bring any saved state up to the current version and fill every default. */
export function migrate(input) {
  let s = input && typeof input === 'object' ? input : {}
  let v = Number.isInteger(s.version) ? s.version : 1
  if (v > SESSION_VERSION) throw new Error(`This session was saved by a newer version of The Ripper (state ${v})`)
  while (v < SESSION_VERSION) { s = MIGRATIONS[v](s); v = s.version }
  return { ...s, program: normalizeProgram(s.program || {}), editor: s.editor || {} }
}

function normalizeProgram(p) {
  const banks = Array.from({ length: BANK_COUNT }, (_, i) => {
    const b = { ...emptyBank(), ...(p.banks?.[i] || {}) }
    const ordered = b.ordered !== false
    const slices = (b.slices || []).filter((x) => x && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
      .map((x) => withDefaults({ ...x, id: undefined }, x.source || 'mix')) // fresh ids: no clash with this app session's
    return { ...b, ordered, slices: renumberBank(slices, ordered) }
  })
  const seq0 = { ...emptySeq(), ...(p.seq || {}) }
  const patterns = Object.fromEntries(PATTERN_IDS.map((id) => [id, { ...emptyPattern(), ...(seq0.patterns?.[id] || {}) }]))
  return { ...p, banks, seq: { ...seq0, patterns, song: (seq0.song || []).filter((id) => PATTERN_IDS.includes(id)) }, master: p.master ?? null }
}

/** Recent sessions list (newest first, max 8). */
export function addRecent(list, entry) {
  return [entry, ...(list || []).filter((e) => e.path !== entry.path)].slice(0, 8)
}
