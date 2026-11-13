import { useEffect, useState } from 'react'

const SOURCE = { bundled: 'built-in', path: 'system', env: 'custom' }

function toolText(source) {
  return source ? `OK (${SOURCE[source] || source})` : 'missing'
}

/** About / settings panel: app + engine versions, helper tools, tester helpers. */
export default function AboutDialog({ host, health, onClose }) {
  const [info, setInfo] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    host.appInfo?.().then(setInfo).catch(() => {})
  }, [host])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const js = health?.tools?.js_runtime
  const copy = async () => {
    await host.copyDiagnostics()
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="about-dialog">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About The Ripper">
        <div className="modal-head">
          <div className="startup-brand"><span className="brand-mark">◢◤</span> THE RIPPER</div>
          <button className="btn btn-small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <dl className="about-grid">
          <dt>Version</dt>
          <dd data-testid="about-version">{info?.version || health?.version || '—'}</dd>
          <dt>Engine</dt>
          <dd>{health ? `${health.version}${health.pro ? ' · Pro' : ''}` : 'offline'}</dd>
          <dt>Audio import (ffmpeg)</dt>
          <dd data-testid="about-ffmpeg">{health ? toolText(health.tools?.ffmpeg ?? (health.ffmpeg ? 'path' : null)) : '—'}</dd>
          <dt>Link import runtime</dt>
          <dd data-testid="about-js">{health ? (js ? `${js.name} ${js.version} (${SOURCE[js.source] || js.source})` : 'missing — some sites won’t import') : '—'}</dd>
          <dt>AI stems</dt>
          <dd>{health ? (health.demucs_available ? `available (${health.device})` : 'not installed') : '—'}</dd>
          {info?.logDir && (<><dt>Logs</dt><dd><code>{info.logDir}</code></dd></>)}
        </dl>
        {host.capabilities.diagnostics && (
          <div className="startup-actions">
            <button className="btn" onClick={copy} data-testid="about-copy-diagnostics">{copied ? 'Copied ✓' : 'Copy diagnostics'}</button>
            <button className="btn" onClick={() => host.openLogFolder()}>Open log folder</button>
          </div>
        )}
      </div>
    </div>
  )
}
