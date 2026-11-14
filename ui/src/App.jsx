import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HashRouter, Route, Routes, Link } from 'react-router-dom'
import { AppContext } from './context.js'
import { getHost } from './host/index.js'
import { api, resetEngine } from './api.js'
import { classifyFiles, isExternalFileDrag } from './lib/importFiles.js'
import { isDraggingOut } from './hooks/useNativeDrag.js'
import Library from './screens/Library.jsx'
import Editor from './screens/Editor.jsx'
import Stems from './screens/Stems.jsx'
import StartupScreen from './components/StartupScreen.jsx'
import AboutDialog from './components/AboutDialog.jsx'

export default function App() {
  const host = useMemo(() => getHost(), [])
  const [health, setHealth] = useState(null)
  const [engineError, setEngineError] = useState(null)
  const [toasts, setToasts] = useState([])
  const [boot, setBoot] = useState(null) // desktop only: engine status from main (starting/ready/restarting/failed)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [engineGen, setEngineGen] = useState(0)
  const [uploads, setUploads] = useState([]) // {id, name, progress}
  const [libraryKick, setLibraryKick] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [elevated, setElevated] = useState(false)
  const lastGen = useRef(0)
  const lastState = useRef(null)

  const notify = useCallback((text, kind = 'info', action = null) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t.slice(-3), { id, text, kind, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000)
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      const h = await api.health()
      setHealth(h)
      setEngineError(null)
      return h
    } catch (e) {
      setEngineError(e.message)
      return null
    }
  }, [])

  // Engine status from the desktop shell. A new `generation` = a (re)started engine: new port
  // and token, so drop the cached address and reload everything.
  useEffect(() => {
    let alive = true
    const onStatus = (s) => {
      if (!alive || !s) return
      setBoot(s)
      const prev = lastState.current
      lastState.current = s.state
      if (s.state === 'restarting' && prev === 'ready') {
        notify('The audio engine stopped unexpectedly — restarting it…', 'error')
      }
      if (s.state === 'ready' && s.generation && s.generation !== lastGen.current) {
        const restarted = lastGen.current > 0
        lastGen.current = s.generation
        resetEngine()
        setEngineGen(s.generation)
        if (restarted) {
          notify('Audio engine restarted', 'success')
          loadHealth()
        }
      }
    }
    host.getEngineStatus().then(onStatus).catch(() => {})
    const off = host.onEngineStatus(onStatus)
    host.appInfo?.().then((i) => alive && setElevated(!!i?.elevated)).catch(() => {})
    return () => { alive = false; off() }
  }, [host, notify, loadHealth])

  useEffect(() => host.onShowAbout?.(() => setAboutOpen(true)), [host])

  // Wait for /health before anything else talks to the engine (the routes below only render
  // once it answered). Retries until it does; demucs availability is probed in the background.
  useEffect(() => {
    let alive = true
    let timer
    const load = async () => {
      const h = await loadHealth()
      if (!alive) return
      if (!h) timer = setTimeout(load, 2000)
      else if (h.demucs_available === null) timer = setTimeout(load, 1500)
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [loadHealth])

  useEffect(() => host.onError((msg) => notify(msg, 'error')), [host, notify])

  // --- importing files (drop anywhere, or Browse…) --------------------------------------------
  const importFiles = useCallback(async (files) => {
    const { accepted, rejected } = classifyFiles(files)
    rejected.forEach((r) => notify(r.reason, 'error'))
    if (accepted.length && window.location.hash && !/^#\/?$/.test(window.location.hash)) window.location.hash = '#/'
    for (const file of accepted) {
      const entry = { id: Math.random().toString(36).slice(2), name: file.name, progress: 0 }
      setUploads((u) => [...u, entry])
      try {
        await api.upload(file, (p) => setUploads((u) => u.map((x) => (x.id === entry.id ? { ...x, progress: p } : x))))
        setLibraryKick((k) => k + 1)
      } catch (e) {
        notify(`${file.name}: ${e.message}`, 'error')
      } finally {
        setUploads((u) => u.filter((x) => x.id !== entry.id))
      }
    }
  }, [notify])

  const ready = !!health
  useEffect(() => {
    let depth = 0
    const enter = (e) => {
      if (!isExternalFileDrag(e.dataTransfer, isDraggingOut())) return
      e.preventDefault()
      depth++
      setDragOver(true)
    }
    const over = (e) => {
      e.preventDefault() // never let the window navigate to a dropped file
      if (isExternalFileDrag(e.dataTransfer, isDraggingOut())) e.dataTransfer.dropEffect = ready ? 'copy' : 'none'
    }
    const leave = (e) => {
      if (!isExternalFileDrag(e.dataTransfer, isDraggingOut())) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const drop = (e) => {
      e.preventDefault()
      depth = 0
      setDragOver(false)
      if (!isExternalFileDrag(e.dataTransfer, isDraggingOut())) return
      if (!ready) return notify('The audio engine is still starting — drop the file again in a moment.', 'error')
      importFiles(Array.from(e.dataTransfer.files || []))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [ready, importFiles, notify])

  const engineUp = boot ? boot.state === 'ready' : !!health && !engineError
  const ctx = useMemo(() => ({ host, health, notify, engineUp, engineGen, importFiles, uploads, libraryKick }),
    [host, health, notify, engineUp, engineGen, importFiles, uploads, libraryKick])

  // Never a blank window: until the engine answers, show the start-up screen (or its error).
  const starting = !health && (boot ? true : !engineError)
  if (starting) {
    return <StartupScreen status={boot} host={host} onRetry={() => host.retryEngine?.()} />
  }

  const ok = !!health && engineUp
  const dotTitle = ok ? `Engine ${health.version}` : boot?.state === 'restarting' ? 'Engine restarting…' : 'Engine offline'
  return (
    <AppContext.Provider value={ctx}>
      <HashRouter>
        <div className="app">
          <header className="topbar">
            <Link to="/" className="brand" data-testid="nav-home">
              <span className="brand-mark">◢◤</span> THE RIPPER
            </Link>
            <div className="topbar-right">
              {health && (
                <span className={`badge ${health.pro ? 'badge-pro' : ''}`} data-testid="plan-badge">
                  {health.pro ? 'PRO' : 'FREE'}
                </span>
              )}
              <button className="btn btn-small btn-ghost" onClick={() => setAboutOpen(true)} title="About The Ripper" data-testid="about-open">About</button>
              <span className={`dot ${ok ? 'dot-ok' : 'dot-bad'}`} title={dotTitle} data-testid="engine-status" data-ok={ok ? 'true' : 'false'} data-state={boot?.state || (ok ? 'ready' : 'down')} />
            </div>
          </header>
          {engineError && !health && <div className="banner banner-error" data-testid="engine-error">Engine not reachable: {engineError}</div>}
          {boot?.state === 'restarting' && <div className="banner banner-warn" data-testid="engine-restarting">The audio engine stopped — restarting it…</div>}
          {boot?.state === 'failed' && (
            <div className="banner banner-error" data-testid="engine-failed">
              The audio engine stopped and could not be restarted{boot.error?.message ? ` (${boot.error.message})` : ''}.{' '}
              <button className="btn btn-small" onClick={() => host.retryEngine?.()} data-testid="engine-retry">Restart engine</button>
              {host.capabilities.diagnostics && <button className="btn btn-small btn-ghost" onClick={() => host.copyDiagnostics().then(() => notify('Diagnostics copied', 'success'))}>Copy diagnostics</button>}
            </div>
          )}
          {elevated && (
            <div className="banner banner-warn" data-testid="elevated-warning">
              The Ripper is running as administrator, so Windows blocks dragging files in from Explorer. Close it and start it normally from the Start menu.
            </div>
          )}
          <main className="content">
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/track/:id" element={<Editor />} />
              <Route path="/track/:id/stems" element={<Stems />} />
            </Routes>
          </main>
          {dragOver && (
            <div className="drop-overlay" data-testid="drop-overlay">
              <div className="drop-overlay-inner">
                <div className="dropzone-icon">⇣</div>
                <div><strong>Drop to import</strong></div>
                <div className="muted small">WAV or MP3 (max 200 MB) · MP4, MOV, M4V, WEBM, MKV video (max 500 MB, audio only is kept)</div>
              </div>
            </div>
          )}
          {aboutOpen && <AboutDialog host={host} health={health} onClose={() => setAboutOpen(false)} />}
          <div className="toasts" data-testid="toasts">
            {toasts.map((t) => (
              <div key={t.id} className={`toast toast-${t.kind}`} data-testid={`toast-${t.kind}`}>
                <span>{t.text}</span>
                {t.action && <button className="btn btn-small" onClick={t.action.run} data-testid="toast-action">{t.action.label}</button>}
              </div>
            ))}
          </div>
        </div>
      </HashRouter>
    </AppContext.Provider>
  )
}
