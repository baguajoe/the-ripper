// UI slice -> engine slice (snake_case, seconds, dB). See docs/formats.md#export-request.
import { cachedClip, ensureClips, needsClip } from './clips.js'

export const toApiSlice = (s, clip) => ({
  start: s.start,
  end: s.end,
  name: s.name,
  reverse: !!s.reverse,
  gain: Number(s.gain) || 0,
  fade_in: Number(s.fadeIn) || 0,
  fade_out: Number(s.fadeOut) || 0,
  source: s.source || 'mix',
  ...(clip ? { clip } : {}),
})

export const DEFAULT_EXPORT = { mode: 'oneshot', sr: 44100, normalize: false, trim_silence: false }

/** Engine slices for an export, rendering + uploading the clips of shaped pads first. */
export async function apiSlices(trackId, slices) {
  await ensureClips(trackId, slices)
  return slices.map((s) => toApiSlice(s, needsClip(s) ? cachedClip(trackId, s) : undefined))
}

/**
 * DragSpec for the native drag. If a shaped pad's clip isn't rendered yet the spec has a
 * non-enumerable `pending()` (render it); useNativeDrag waits for it on hover.
 */
export function dragSpec(trackId, kind, { slices = [], stems = [], options = DEFAULT_EXPORT, ...extra } = {}) {
  let missing = false
  const api = slices.map((s) => {
    if (!needsClip(s)) return toApiSlice(s)
    const id = cachedClip(trackId, s)
    if (!id) missing = true
    return toApiSlice(s, id)
  })
  const spec = { trackId, kind, slices: api, stems, options, ...extra }
  if (missing) Object.defineProperty(spec, 'pending', { value: () => ensureClips(trackId, slices), enumerable: false })
  return spec
}
