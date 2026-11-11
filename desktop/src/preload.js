// Preload: the ONLY bridge between the sandboxed renderer and the main process.
// Exposes a fixed set of functions on window.ripper; no raw ipcRenderer access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ripper', {
  isElectron: true,
  platform: process.platform,
  getEngine: () => ipcRenderer.invoke('engine:get'),
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
