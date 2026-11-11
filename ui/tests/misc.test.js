import { describe, expect, it } from 'vitest'
import { createTapTempo } from '../src/lib/tapTempo.js'
import { detectHost } from '../src/host/index.js'
import { toApiSlice } from '../src/lib/exportSpec.js'
import { juceHost } from '../src/host/juceHost.js'
import { electronHost } from '../src/host/electronHost.js'
import { browserHost } from '../src/host/browserHost.js'

describe('tap tempo', () => {
  it('averages intervals and resets after a gap', () => {
    const t = createTapTempo()
    expect(t.tap(0)).toBeNull()
    expect(t.tap(500)).toBe(120)
    expect(t.tap(1000)).toBe(120)
    expect(t.tap(1520)).toBeCloseTo(118.42, 1)
    expect(t.tap(5000)).toBeNull() // > 2 s gap
    expect(t.tap(5666.67)).toBeCloseTo(90, 0)
  })
})

describe('host adapter', () => {
  it('detects the host at runtime', () => {
    expect(detectHost({ ripper: { isElectron: true } })).toBe('electron')
    expect(detectHost({ __JUCE__: {} })).toBe('juce')
    expect(detectHost({})).toBe('browser')
  })
  it('all hosts expose the same interface', () => {
    const keys = (h) => Object.keys(h).sort()
    const e = electronHost({})
    expect(keys(juceHost({}))).toEqual(keys(e))
    expect(keys(browserHost())).toEqual(keys(e))
  })
  it('juce stub rejects clearly until implemented', async () => {
    await expect(juceHost({}).getEngine()).rejects.toThrow(/not implemented/)
  })
})

describe('export spec', () => {
  it('maps UI slices to the engine schema', () => {
    expect(toApiSlice({ start: 1, end: 2, name: 'k', reverse: 1, gain: '-3', fadeIn: 0.01, fadeOut: 0.02, choke: true }))
      .toEqual({ start: 1, end: 2, name: 'k', reverse: true, gain: -3, fade_in: 0.01, fade_out: 0.02, source: 'mix' })
  })
})
