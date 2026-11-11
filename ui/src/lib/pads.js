// 4x4 MPC-style pad grid. Rows top->bottom: 1234 / QWER / ASDF / ZXCV.
export const PAD_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v']
export const PADS_PER_BANK = 16
export const BANKS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

/** KeyboardEvent.key (or .code) -> pad index 0..15, or -1. */
export function keyToPad(key) {
  if (!key) return -1
  let k = String(key).toLowerCase()
  if (k.startsWith('digit')) k = k.slice(5)
  else if (k.startsWith('key')) k = k.slice(3)
  return PAD_KEYS.indexOf(k)
}

export const padKeyLabel = (i) => PAD_KEYS[i]?.toUpperCase() ?? ''

/** Slice index for pad i in bank b (slices auto-assigned in time order). */
export const padToSlice = (pad, bank = 0) => bank * PADS_PER_BANK + pad

export const bankCount = (nSlices) => Math.max(1, Math.ceil(nSlices / PADS_PER_BANK))
