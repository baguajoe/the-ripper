// Pitch-shifted copies for keep-length pads (made by the engine with Signalsmith Stretch),
// cached per slice region + pitch so pads, previews and exports share them.
import { api } from '../api.js'
import { pitchedKey, semitones } from '../dsp/params.js'

const cache = new Map() // `${trackId}|${key}` -> Promise<{sr, channels}>

/** Promise of the pitched copy for a keep-length slice, or null when it doesn't need one. */
export function getPitched(trackId, slice) {
  const key = pitchedKey(slice)
  if (!key) return null
  const k = `${trackId}|${key}`
  if (!cache.has(k)) {
    const p = api.pitched(trackId, { start: slice.start, end: slice.end, semitones: semitones(slice), source: slice.source || 'mix' })
    p.catch(() => cache.delete(k))
    cache.set(k, p)
    if (cache.size > 128) cache.delete(cache.keys().next().value)
  }
  return cache.get(k)
}
