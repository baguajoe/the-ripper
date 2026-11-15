import { describe, expect, it } from 'vitest'
import { emptyMap, learn, parse, resolve, midiInput } from '../src/lib/midi.js'

describe('MIDI', () => {
  it('parses note on / off (velocity 0 = off) and CC', () => {
    expect(parse([0x99, 36, 100])).toEqual({ type: 'on', num: 36, value: 100 })
    expect(parse([0x90, 36, 0])).toEqual({ type: 'off', num: 36, value: 0 })
    expect(parse([0x80, 40, 64])).toEqual({ type: 'off', num: 40, value: 0 })
    expect(parse([0xb2, 20, 127])).toEqual({ type: 'cc', num: 20, value: 127 })
    expect(parse([0xf8])).toBe(null)
  })
  it('default pad notes 36-51, learn overrides and buttons', () => {
    let m = emptyMap()
    expect(resolve(m, 'note', 36)).toEqual({ kind: 'pad', pad: 0 })
    expect(resolve(m, 'note', 51)).toEqual({ kind: 'pad', pad: 15 })
    expect(resolve(m, 'note', 52)).toBe(null)
    m = learn(m, 'pad:0', 'note', 60)
    expect(resolve(m, 'note', 60)).toEqual({ kind: 'pad', pad: 0 })
    expect(resolve(m, 'note', 36)).toBe(null) // pad 1 moved to note 60
    m = learn(m, 'play', 'cc', 20)
    m = learn(m, 'record', 'note', 61)
    expect(resolve(m, 'cc', 20)).toEqual({ kind: 'button', button: 'play' })
    expect(resolve(m, 'note', 61)).toEqual({ kind: 'button', button: 'record' })
    m = learn(m, 'stop', 'cc', 20) // re-learning a message moves it
    expect(resolve(m, 'cc', 20)).toEqual({ kind: 'button', button: 'stop' })
    expect(m.buttons.play).toBeUndefined()
    expect(learn(m, 'pad:3', 'cc', 9)).toBe(m) // pads need notes
  })
  it('a virtual input delivers messages like a device', () => {
    const got = []
    const off = midiInput.on((m) => got.push(m))
    const dev = midiInput.addVirtualInput('Test pads')
    dev.send([0x90, 38, 77])
    off()
    expect(got.filter((m) => m.type === 'on')).toEqual([{ type: 'on', num: 38, value: 77, device: dev.id }])
    expect(midiInput.list.some((d) => d.name === 'Test pads')).toBe(true)
  })
})
