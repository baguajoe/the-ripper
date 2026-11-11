let ctx = null

/** Shared low-latency AudioContext used by hosts that play through Web Audio. */
export function sharedAudioContext() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' })
  return ctx
}
