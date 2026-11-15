import { describe, expect, it } from 'vitest'
import { SESSION_VERSION, addRecent, migrate, sessionState } from '../src/lib/session.js'
import { emptySeq } from '../src/lib/sequence.js'

describe('session state', () => {
  it('round-trips the current version unchanged (with defaults filled)', () => {
    const program = { banks: [{ slices: [{ id: 's1', start: 1, end: 2, pad: 3, tune: 5, fx: { reverb: { on: true } }, name: 'Kick', source: 'mix' }], mono: false, ordered: false, vintage: '12bit', chop: null }],
      seq: { ...emptySeq(), swing: 60, song: ['A', 'B'] }, master: { comp: { on: true } } }
    const s = sessionState({ program, editor: { bank: 1, seqOpts: { loop: false } }, exportOptions: { sr: 48000 } })
    const m = migrate(JSON.parse(JSON.stringify(s)))
    expect(m.version).toBe(SESSION_VERSION)
    expect(m.program.banks).toHaveLength(8)
    const sl = m.program.banks[0].slices[0]
    expect([sl.pad, sl.tune, sl.name, sl.fx]).toEqual([3, 5, 'Kick', { reverb: { on: true } }])
    expect(m.program.banks[0].vintage).toBe('12bit')
    expect(m.program.seq.swing).toBe(60)
    expect(m.program.seq.song).toEqual(['A', 'B'])
    expect(m.program.master).toEqual({ comp: { on: true } })
    expect(m.editor).toEqual({ bank: 1, seqOpts: { loop: false } })
    expect(m.export).toEqual({ sr: 48000 })
  })
  it('opens an older (v1) session: the program alone', () => {
    const v1 = { version: 1, banks: [{ slices: [{ start: 0, end: 1, name: 'slice01' }, { start: 1, end: 2, name: 'my hit' }], mono: true, chop: { id: 'c1' } }], chop: { mode: 'grid' } }
    const m = migrate(v1)
    expect(m.version).toBe(2)
    expect(m.program.banks[0].slices.map((x) => [x.pad, x.name, x.fadeOut])).toEqual([[0, 'slice01', 0.005], [1, 'my hit', 0.005]])
    expect(m.program.seq.patterns.H.steps).toBe(16)
    expect(m.editor.chop).toEqual({ mode: 'grid' })
    expect(migrate({}).program.banks).toHaveLength(8) // no version at all = v1
    expect(() => migrate({ version: 99 })).toThrow(/newer version/)
  })
  it('recent list', () => {
    let r = addRecent([], { path: '/a.ripper' })
    r = addRecent(r, { path: '/b.ripper' })
    r = addRecent(r, { path: '/a.ripper', title: 'again' })
    expect(r.map((e) => e.path)).toEqual(['/a.ripper', '/b.ripper'])
  })
})
