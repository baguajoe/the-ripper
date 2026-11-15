// Shaped pads export as "clips": the pad engine renders the pad exactly as it plays (tune,
// envelope, filter, pan, effects, vintage), the clip is uploaded once, and the export slice
// references it. Unshaped slices are cut by the engine as before (identical result).
import { api } from '../api.js'
import { isShaped } from '../dsp/params.js'
import { renderPad, planarBytes } from '../dsp/render.js'
import { getPitched } from './pitched.js'
import { Vintage } from '../dsp/vintage.js'

const sources = new Map() // `${trackId}:${source}` -> {sr, channels}
const cache = new Map() // render key -> {id?: string, promise}

/** The editor registers the audio it plays so exports can render from the same samples. */
export function registerSource(trackId, source, src) {
  sources.set(`${trackId}:${source || 'mix'}`, src)
}

/** Does this (export) slice need a rendered clip? `vintage` is the bank's setting, copied onto the slice. */
export const needsClip = (s) => isShaped(s) || (!!s.vintage && s.vintage !== 'off')

const RENDER_FIELDS = ['source', 'start', 'end', 'reverse', 'gain', 'fadeIn', 'fadeOut', 'tune', 'fine', 'keepLength',
  'env', 'filter', 'velVol', 'velFilter', 'pan', 'fx', 'vintage']
const keyOf = (trackId, s) => JSON.stringify([trackId, ...RENDER_FIELDS.map((k) => s[k] ?? null)])

/** Render hooks the later phases add (bank vintage, effects tails). */
export const renderHooks = {
  bankFx: (s, sr) => (s.vintage && s.vintage !== 'off' ? new Vintage(sr, s.vintage) : null),
  tail: () => 0,
}

async function renderAndUpload(trackId, s) {
  const src = sources.get(`${trackId}:${s.source || 'mix'}`)
  if (!src) throw new Error('The audio for this pad is not loaded yet - try again in a moment')
  const pitched = (await getPitched(trackId, s)) || null
  const out = renderPad(src, s, { pitched, bankFx: renderHooks.bankFx(s, src.sr), tail: renderHooks.tail(s) })
  return api.uploadClip(planarBytes(out), src.sr, 2)
}

/** Clip id for a shaped slice (rendering + uploading it once). */
export function ensureClip(trackId, s) {
  const k = keyOf(trackId, s)
  let e = cache.get(k)
  if (!e) {
    e = { id: null }
    e.promise = renderAndUpload(trackId, s).then((id) => { e.id = id; return id }, (err) => { cache.delete(k); throw err })
    cache.set(k, e)
    if (cache.size > 512) cache.delete(cache.keys().next().value)
  }
  return e.promise
}

/** Clip id if it's already rendered, else undefined. */
export const cachedClip = (trackId, s) => cache.get(keyOf(trackId, s))?.id ?? undefined

/** Await clips for every shaped slice in the list. */
export const ensureClips = (trackId, slices) => Promise.all(slices.filter(needsClip).map((s) => ensureClip(trackId, s)))

/** Forget everything (tests). */
export const clearClips = () => cache.clear()
