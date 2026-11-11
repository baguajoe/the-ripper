/**
 * Host adapter. UI components NEVER talk to Electron (or JUCE) directly — every native
 * action goes through the object returned by getHost().
 *
 * Interface (every implementation must provide all of these):
 *   name: 'electron' | 'juce' | 'browser'
 *   capabilities: { nativeDrag: boolean, folders: boolean }
 *   getEngine(): Promise<{ baseUrl: string, token: string, version: string }>
 *   prepareDrag(spec): Promise<{ files: string[] }>   pre-render so dragstart is instant
 *   startDrag(spec): void                             call synchronously inside dragstart
 *   pickFolder(): Promise<string|null>                native folder dialog (remembers last)
 *   exportToFolder(spec): Promise<{ files: string[], folder: string }|null>
 *   download({ path, body, filename }): Promise<{ path: string }>
 *                                                     POST an engine route, save the reply
 *   showItemInFolder(path): void
 *   getSetting(key): Promise<any>, setSetting(key, value): Promise<void>
 *   onError(cb): unsubscribe                          async native errors (e.g. a failed drag)
 *   audio: { getContext(): AudioContext }             playback ("native audio" in JUCE)
 *
 * DragSpec: { trackId, kind: 'slice'|'slices'|'stem'|'kit'|'midi', slices: Slice[],
 *             stems: string[], options: { mode, sr, normalize, trim_silence } }
 */
import { electronHost } from './electronHost.js'
import { juceHost } from './juceHost.js'
import { browserHost } from './browserHost.js'

let cached = null

export function detectHost(win = globalThis.window) {
  if (win?.ripper?.isElectron) return 'electron'
  if (win?.__JUCE__) return 'juce'
  return 'browser'
}

export function getHost() {
  if (cached) return cached
  const kind = detectHost()
  cached = kind === 'electron' ? electronHost(window.ripper) : kind === 'juce' ? juceHost(window.__JUCE__) : browserHost()
  return cached
}

export { sharedAudioContext } from './audioContext.js'
