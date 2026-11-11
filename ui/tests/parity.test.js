// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gridBeats, gridSlices, snap, transientSlices } from '../src/lib/grid.js'
import { buildFilename } from '../src/lib/filenames.js'

// Generated from the Python engine (python -m engine.tests.parity_cases > docs/parity.json).
const parity = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/parity.json', import.meta.url)), 'utf8'))

const close = (a, b) => expect(Math.abs(a - b)).toBeLessThan(1e-6)
const sameSlices = (js, py) => {
  expect(js.length).toBe(py.length)
  js.forEach((s, i) => { close(s.start, py[i].start); close(s.end, py[i].end); expect(s.name).toBe(py[i].name) })
}

describe('JS matches the Python engine', () => {
  it.each(parity.grid)('gridSlices $args', ({ args, slices }) => sameSlices(gridSlices(...args), slices))
  it.each(parity.beats)('gridBeats $args', ({ args, beats }) => {
    const js = gridBeats(...args)
    expect(js.length).toBe(beats.length)
    js.forEach((b, i) => close(b, beats[i]))
  })
  it.each(parity.snap)('snap $args', ({ args, t }) => close(snap(...args), t))
  it.each(parity.transient)('transientSlices $args', ({ args, slices }) => sameSlices(transientSlices(...args), slices))
  it.each(parity.filenames)('buildFilename $args', ({ args, name }) => expect(buildFilename(...args)).toBe(name))
})
