// The pad program: 8 banks (A–H) of up to 16 pads. A chop fills the next empty bank (or
// replaces the current one); a chop with more than 16 slices spans consecutive banks. Each
// bank remembers the chop that made it (region + settings), so changing the settings
// re-chops that bank in place. Pure functions: the editor keeps the history (undo/redo).
import { PADS_PER_BANK } from './pads.js'

export const BANK_COUNT = 8
export const FREE_BANKS = 2 // A and B; C–H need Pro (features.banks_beyond_b)

export const emptyBank = () => ({ slices: [], mono: true, chop: null })
export const emptyProgram = () => ({ banks: Array.from({ length: BANK_COUNT }, emptyBank) })

const DEFAULTS = { gain: 0, fadeIn: 0, fadeOut: 0.005, reverse: false, choke: false, padMode: 'oneshot' }
let nextId = 1
export const newSliceId = () => `s${nextId++}`

const name = (i) => `slice${String(i + 1).padStart(2, '0')}`

/** Default-named slices are numbered slice01.. in time order within their bank; custom names stay. */
export function renumberBank(slices) {
  return [...slices]
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({ ...s, name: !s.name || /^slice\d+$/.test(s.name) ? name(i) : s.name }))
}

const isEmpty = (bank) => bank.slices.length === 0

/** Banks owned by the chop that made bank `b` (consecutive), or [b]. */
export function chopBanks(program, b) {
  const id = program.banks[b]?.chop?.id
  if (!id) return [b]
  return program.banks.map((x, i) => (x.chop?.id === id ? i : -1)).filter((i) => i >= 0)
}

/** First index i >= from with `need` consecutive empty banks among the first `limit`. */
export function nextEmptyBank(program, need = 1, limit = BANK_COUNT, from = 0) {
  for (let i = from; i + need <= limit; i++) {
    let ok = true
    for (let k = i; k < i + need; k++) if (!isEmpty(program.banks[k])) ok = false
    if (ok) return i
  }
  return -1
}

/**
 * Put a chop's slices into the program.
 *   target: bank index to start at; the banks of whatever chop owns `target` are cleared first.
 *   limit:  banks the user may use (2 without Pro).
 * Returns { program, bank, banks: [indices], dropped } — `dropped` slices didn't fit.
 */
export function placeChop(program, slices, { target, limit = BANK_COUNT, chop, source = 'mix' }) {
  const banks = program.banks.map((b) => ({ ...b }))
  for (const i of chopBanks(program, target)) banks[i] = { ...emptyBank(), mono: banks[i].mono }
  const need = Math.max(1, Math.ceil(slices.length / PADS_PER_BANK))
  let span = 0
  while (span < need && target + span < limit && (span === 0 || isEmpty(banks[target + span]))) span++
  const fit = slices.slice(0, span * PADS_PER_BANK)
  const used = []
  for (let k = 0; k < span; k++) {
    const part = fit.slice(k * PADS_PER_BANK, (k + 1) * PADS_PER_BANK)
    if (!part.length && k > 0) break
    banks[target + k] = {
      ...banks[target + k],
      slices: part.map((s, i) => ({ ...DEFAULTS, ...s, source, id: newSliceId(), name: name(i) })),
      chop: chop ? { ...chop, part: k } : null,
    }
    used.push(target + k)
  }
  return { program: { ...program, banks }, bank: target, banks: used, dropped: slices.length - fit.length }
}

export function updateBank(program, b, patch) {
  const banks = program.banks.map((x, i) => (i === b ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x))
  return { ...program, banks }
}

/** Edit the slices of bank b (keeps them time-ordered + numbered). Max 16 per bank. */
export function updateSlices(program, b, fn) {
  return updateBank(program, b, (bank) => ({ slices: renumberBank(fn(bank.slices)).slice(0, PADS_PER_BANK) }))
}

export const withDefaults = (s, source) => ({ ...DEFAULTS, ...s, source, id: s.id ?? newSliceId() })

export function clearBank(program, b) {
  return updateBank(program, b, (bank) => ({ ...emptyBank(), mono: bank.mono }))
}

/** One-line description of the chop that made a bank, e.g. "Even 16 · bars 1.1–5.1". */
export function describeChop(chop) {
  if (!chop) return ''
  const { mode, count, division, cap } = chop.settings
  if (mode === 'even') return `Even ${count}`
  if (mode === 'grid') return `Grid ${division}`
  if (mode === 'transients') return `Transients (max ${cap})`
  return 'Manual'
}
