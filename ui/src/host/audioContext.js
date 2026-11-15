// The app's AudioContext + its settings (output device, buffer size). Changing the device
// re-routes the running context (setSinkId); changing the buffer size makes a new context and
// tells listeners (the editor moves its pad engine over) — never an app restart.
let ctx = null
let opts = { buffer: 'interactive', sinkId: '' } // buffer: 'interactive' | frames (128, 256, 512, 1024)
const listeners = new Set()

const NOMINAL_SR = 48000
const hint = () => (opts.buffer === 'interactive' ? 'interactive' : Number(opts.buffer) / NOMINAL_SR)

function make() {
  const c = new AudioContext({ latencyHint: hint() })
  if (opts.sinkId && c.setSinkId) c.setSinkId(opts.sinkId).catch(() => {})
  return c
}

/** Shared low-latency AudioContext used by hosts that play through Web Audio. */
export function sharedAudioContext() {
  if (!ctx) ctx = make()
  return ctx
}

export const audioOptions = () => ({ ...opts })

/** Apply {buffer?, sinkId?}. Resolves when done. */
export async function setAudioOptions(next = {}) {
  const prev = opts
  opts = { ...opts, ...next }
  if (!ctx) return
  if (next.buffer !== undefined && String(next.buffer) !== String(prev.buffer)) {
    const old = ctx
    ctx = make()
    for (const fn of listeners) await fn(ctx)
    old.close().catch(() => {})
  } else if (next.sinkId !== undefined && next.sinkId !== prev.sinkId && ctx.setSinkId) {
    await ctx.setSinkId(opts.sinkId)
  }
}

/** (newContext) => void|Promise, called after the buffer size changed. */
export function onAudioContextChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function outputDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audiooutput').map((d, i) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || `Output ${i + 1}` }))
  } catch {
    return []
  }
}

/** Reported latency of the running context, in ms. */
export function latencyInfo(c = sharedAudioContext()) {
  const base = (c.baseLatency || 0) * 1000
  const output = (c.outputLatency || 0) * 1000
  return { sampleRate: c.sampleRate, base, output, total: base + output, sinkId: c.sinkId ?? '' }
}

export const webAudio = { getContext: sharedAudioContext, setOptions: setAudioOptions, options: audioOptions, onChange: onAudioContextChange, devices: outputDevices, info: latencyInfo }
