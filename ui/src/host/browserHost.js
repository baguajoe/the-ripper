import { sharedAudioContext } from './audioContext.js'

/**
 * Dev-only fallback when the UI is opened in a plain browser (e.g. debugging the Vite
 * server). Not a product surface: no native drag, no folders. Engine from
 * VITE_ENGINE_URL / VITE_ENGINE_TOKEN.
 */
export function browserHost() {
  const unsupported = (what) => () => Promise.reject(new Error(`${what} needs the desktop app`))
  return {
    name: 'browser',
    capabilities: { nativeDrag: false, folders: false, diagnostics: false },
    getEngine: async () => ({
      baseUrl: import.meta.env?.VITE_ENGINE_URL || 'http://127.0.0.1:8765',
      token: import.meta.env?.VITE_ENGINE_TOKEN || '',
      version: 'dev',
    }),
    prepareDrag: async () => ({ files: [] }),
    startDrag: () => {},
    pickFolder: async () => null,
    exportToFolder: unsupported('Export to folder'),
    download: unsupported('Saving files'),
    showItemInFolder: () => {},
    getSetting: async (k) => { try { return JSON.parse(localStorage.getItem(`ripper:${k}`)) } catch { return null } },
    setSetting: async (k, v) => { try { localStorage.setItem(`ripper:${k}`, JSON.stringify(v)) } catch { /* ignore */ } },
    onError: () => () => {},
    getEngineStatus: async () => null, // no start-up status: the UI just waits for /health
    onEngineStatus: () => () => {},
    retryEngine: async () => {},
    appInfo: async () => null,
    copyDiagnostics: unsupported('Copying diagnostics'),
    openLogFolder: unsupported('Opening the log folder'),
    onShowAbout: () => () => {},
    audio: { getContext: sharedAudioContext },
  }
}
