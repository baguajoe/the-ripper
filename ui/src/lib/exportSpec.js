// UI slice -> engine slice (snake_case, seconds, dB). See docs/formats.md#export-request.
export const toApiSlice = (s) => ({
  start: s.start,
  end: s.end,
  name: s.name,
  reverse: !!s.reverse,
  gain: Number(s.gain) || 0,
  fade_in: Number(s.fadeIn) || 0,
  fade_out: Number(s.fadeOut) || 0,
  source: s.source || 'mix',
})

export const DEFAULT_EXPORT = { mode: 'oneshot', sr: 44100, normalize: false, trim_silence: false }

export function dragSpec(trackId, kind, { slices = [], stems = [], options = DEFAULT_EXPORT } = {}) {
  return { trackId, kind, slices: slices.map(toApiSlice), stems, options }
}
