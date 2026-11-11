import { sharedAudioContext } from './audioContext.js'

/** Electron implementation: thin wrapper over the preload bridge (window.ripper). */
export function electronHost(bridge) {
  return {
    name: 'electron',
    capabilities: { nativeDrag: true, folders: true },
    getEngine: () => bridge.getEngine(),
    prepareDrag: (spec) => bridge.prepareDrag(spec),
    startDrag: (spec) => bridge.startDrag(spec),
    pickFolder: () => bridge.pickFolder(),
    exportToFolder: (spec) => bridge.exportToFolder(spec),
    download: (req) => bridge.download(req),
    showItemInFolder: (p) => bridge.showItemInFolder(p),
    getSetting: (k) => bridge.getSetting(k),
    setSetting: (k, v) => bridge.setSetting(k, v),
    onError: (cb) => bridge.onError?.(cb) ?? (() => {}),
    audio: { getContext: sharedAudioContext },
  }
}
