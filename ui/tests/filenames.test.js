import { describe, expect, it } from 'vitest'
import { baseName, buildFilename, formatBpm, sanitize, sliceName } from '../src/lib/filenames.js'

describe('filename builder', () => {
  it('follows {track}_{bpm}bpm_{key}_{part}.wav', () => {
    expect(buildFilename('Night Drive', 120, 'Am', 'slice01')).toBe('Night-Drive_120bpm_Am_slice01.wav')
    expect(buildFilename('Night Drive', 120, 'Am', 'drums')).toBe('Night-Drive_120bpm_Am_drums.wav')
    expect(buildFilename('Night Drive', 120, 'Am', 'slices', 'mid')).toBe('Night-Drive_120bpm_Am_slices.mid')
  })
  it('strips unsafe characters and the "_" separator from titles', () => {
    expect(sanitize('a/b\\c:d*?"<>|e')).toBe('a-b-c-d-e')
    expect(sanitize('beat_120')).toBe('beat-120')
    expect(sanitize('   ')).toBe('track')
    expect(sanitize('x'.repeat(100))).toHaveLength(40)
  })
  it('formats bpm with round-half-up to one decimal', () => {
    expect(formatBpm(120)).toBe('120')
    expect(formatBpm(92.5)).toBe('92.5')
    expect(formatBpm(87.25)).toBe('87.3')
    expect(formatBpm(119.96)).toBe('120')
  })
  it('omits a missing key', () => {
    expect(baseName('t', 90, null)).toBe('t_90bpm')
    expect(buildFilename('t', 90, 'F#', 'slice02')).toBe('t_90bpm_F#_slice02.wav')
  })
  it('slice names are zero padded', () => {
    expect(sliceName(0)).toBe('slice01')
    expect(sliceName(11)).toBe('slice12')
  })
})
