import { useCallback, useEffect, useMemo, useState } from 'react'
import { HashRouter, Route, Routes, Link } from 'react-router-dom'
import { AppContext } from './context.js'
import { getHost } from './host/index.js'
import { api } from './api.js'
import Library from './screens/Library.jsx'
import Editor from './screens/Editor.jsx'
import Stems from './screens/Stems.jsx'

export default function App() {
  const host = useMemo(() => getHost(), [])
  const [health, setHealth] = useState(null)
  const [engineError, setEngineError] = useState(null)
  const [toasts, setToasts] = useState([])

  const notify = useCallback((text, kind = 'info', action = null) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t.slice(-3), { id, text, kind, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 5000)
  }, [])

  useEffect(() => {
    let alive = true
    let timer
    const load = async () => {
      try {
        const h = await api.health()
        if (!alive) return
        setHealth(h)
        setEngineError(null)
        // torch import is probed in the background; re-check until it settles
        if (h.demucs_available === null) timer = setTimeout(load, 1500)
      } catch (e) {
        if (!alive) return
        setEngineError(e.message)
        timer = setTimeout(load, 2000)
      }
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  useEffect(() => host.onError((msg) => notify(msg, 'error')), [host, notify])

  const ctx = useMemo(() => ({ host, health, notify }), [host, health, notify])

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
              <span className={`dot ${health ? 'dot-ok' : 'dot-bad'}`} title={health ? `Engine ${health.version}` : 'Engine offline'} data-testid="engine-status" data-ok={health ? 'true' : 'false'} />
            </div>
          </header>
          {engineError && !health && <div className="banner banner-error" data-testid="engine-error">Engine not reachable: {engineError}</div>}
          <main className="content">
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/track/:id" element={<Editor />} />
              <Route path="/track/:id/stems" element={<Stems />} />
            </Routes>
          </main>
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
