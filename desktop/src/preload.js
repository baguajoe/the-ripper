// Preload: the ONLY bridge between the sandboxed renderer and the main process.
// Exposes a fixed set of functions on window.ripper; no raw ipcRenderer access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ripper', {
  isElectron: true,
  platform: process.platform,
  getEngine: () => ipcRenderer.invoke('engine:get'),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),
  retryEngine: () => ipcRenderer.invoke('engine:retry'),
  onEngineStatus: (cb) => {
    const fn = (_e, s) => cb(s)
    ipcRenderer.on('engine:status', fn)
    return () => ipcRenderer.removeListener('engine:status', fn)
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  copyDiagnostics: () => ipcRenderer.invoke('diag:copy'),
  openLogFolder: () => ipcRenderer.invoke('diag:openLogs'),
  onShowAbout: (cb) => {
    const fn = () => cb()
    ipcRenderer.on('app:showAbout', fn)
    return () => ipcRenderer.removeListener('app:showAbout', fn)
  },
  prepareDrag: (spec) => ipcRenderer.invoke('drag:prepare', spec),
  startDrag: (spec) => ipcRenderer.send('drag:start', spec),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  exportToFolder: (spec) => ipcRenderer.invoke('export:toFolder', spec),
  download: (req) => ipcRenderer.invoke('export:download', req),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  onError: (cb) => {
    const fn = (_e, msg) => cb(msg)
    ipcRenderer.on('host:error', fn)
    return () => ipcRenderer.removeListener('host:error', fn)
  },
})
