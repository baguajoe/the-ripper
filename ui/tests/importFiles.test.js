import { describe, expect, it } from 'vitest'
import { classifyFiles, extOf, isExternalFileDrag } from '../src/lib/importFiles.js'

const f = (name, mb = 1) => ({ name, size: mb * 1024 * 1024 })

describe('classifyFiles', () => {
  it('accepts audio and the five video formats, case-insensitively', () => {
    const files = ['a.wav', 'b.MP3', 'c.mp4', 'd.MOV', 'e.m4v', 'f.webm', 'g.mkv'].map((n) => f(n))
    const { accepted, rejected } = classifyFiles(files)
    expect(accepted.map((x) => x.name)).toEqual(files.map((x) => x.name))
    expect(rejected).toEqual([])
  })
  it('rejects unsupported types with a helpful message', () => {
    const { accepted, rejected } = classifyFiles([f('notes.txt'), f('song.flac'), f('noext')])
    expect(accepted).toEqual([])
    expect(rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining('unsupported file type (.txt)'),
      expect.stringContaining('unsupported file type (.flac)'),
      expect.stringContaining('noext: unsupported file type.'),
    ])
    expect(rejected[0].reason).toContain('MP4, MOV, M4V, WEBM or MKV')
  })
  it('applies 200 MB to audio and 500 MB to video', () => {
    const { accepted, rejected } = classifyFiles([f('big.wav', 201), f('ok.wav', 199), f('ok.mp4', 499), f('big.mkv', 501)])
    expect(accepted.map((x) => x.name)).toEqual(['ok.wav', 'ok.mp4'])
    expect(rejected.map((r) => r.reason)).toEqual(['big.wav: audio files can be at most 200 MB.', 'big.mkv: videos can be at most 500 MB.'])
  })
  it('handles names with spaces, periods and non-ASCII', () => {
    expect(extOf('J. Gallop – mix v2.final.MP3')).toBe('.mp3')
    expect(classifyFiles([f('ユーザー. 曲.wav')]).accepted).toHaveLength(1)
  })
})

describe('isExternalFileDrag', () => {
  it('only reacts to file drags from outside', () => {
    expect(isExternalFileDrag({ types: ['Files'] })).toBe(true)
    expect(isExternalFileDrag({ types: ['text/plain'] })).toBe(false)
    expect(isExternalFileDrag({ types: ['Files'] }, true)).toBe(false) // our own drag-out
    expect(isExternalFileDrag(null)).toBe(false)
  })
})
