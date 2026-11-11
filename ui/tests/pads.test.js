import { describe, expect, it } from 'vitest'
import { PAD_KEYS, bankCount, keyToPad, padKeyLabel, padToSlice } from '../src/lib/pads.js'

describe('pad key mapping', () => {
  it('maps 1234 / QWER / ASDF / ZXCV to pads 0..15 in rows', () => {
    const rows = ['1234', 'qwer', 'asdf', 'zxcv']
    rows.forEach((row, r) => [...row].forEach((k, c) => expect(keyToPad(k)).toBe(r * 4 + c)))
    expect(PAD_KEYS).toHaveLength(16)
  })
  it('accepts upper case and KeyboardEvent.code', () => {
    expect(keyToPad('Q')).toBe(4)
    expect(keyToPad('KeyV')).toBe(15)
    expect(keyToPad('Digit3')).toBe(2)
  })
  it('ignores other keys', () => {
    for (const k of ['5', 't', 'g', 'b', ' ', 'Enter', '', null]) expect(keyToPad(k)).toBe(-1)
  })
  it('labels and banks', () => {
    expect(padKeyLabel(8)).toBe('A')
    expect(padToSlice(3, 0)).toBe(3)
    expect(padToSlice(3, 1)).toBe(19)
    expect(bankCount(0)).toBe(1)
    expect(bankCount(16)).toBe(1)
    expect(bankCount(17)).toBe(2)
  })
})
