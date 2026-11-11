import { sharedAudioContext } from './audioContext.js'

/**
 * JUCE plugin implementation — STUB with the same interface as electronHost.
 *
 * The plugin will embed this UI in a juce::WebBrowserComponent and expose native
 * functions via withNativeFunction(); they're reached through window.__JUCE__.backend.
 * Each method below maps 1:1 to a native function of the same name, so the C++ side only
 * has to implement: getEngine, prepareDrag, startDrag (juce::DragAndDropContainer::
 * performExternalDragDropOfFiles), pickFolder (juce::FileChooser), exportToFolder,
 * download, showItemInFolder, getSetting/setSetting, and audio playback.
 */
export function juceHost(juce) {
  const call = (name, ...args) => {
    const fn = juce?.backend?.[name] ?? globalThis.window?.__JUCE__?.nativeFunctions?.[name]
    if (typeof fn !== 'function') return Promise.reject(new Error(`JUCE host: ${name} not implemented yet`))
    return Promise.resolve(fn(...args))
  }
  return {
    name: 'juce',
    capabilities: { nativeDrag: true, folders: true },
    getEngine: () => call('getEngine'),
    prepareDrag: (spec) => call('prepareDrag', spec),
    startDrag: (spec) => { call('startDrag', spec).catch(() => {}) },
    pickFolder: () => call('pickFolder'),
    exportToFolder: (spec) => call('exportToFolder', spec),
    download: (req) => call('download', req),
    showItemInFolder: (p) => { call('showItemInFolder', p).catch(() => {}) },
    getSetting: (k) => call('getSetting', k),
    setSetting: (k, v) => call('setSetting', k, v),
    onError: () => () => {},
    // TODO(plugin): route pad playback to the plugin's audio thread instead of Web Audio.
    audio: { getContext: sharedAudioContext },
  }
}
