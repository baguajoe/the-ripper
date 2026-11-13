import { useEffect, useState } from 'react'
import { startupProgress } from '../lib/startup.js'


const FRIENDLY = {
  timeout: 'The audio engine took too long to start.',
  engine_exited: 'The audio engine stopped while it was starting.',
  spawn_failed: 'The audio engine could not be launched.',
  ffmpeg_missing: "The Ripper's built-in audio tools (ffmpeg) are missing. Reinstalling the app should fix this.",
  unhealthy: 'The audio engine started but is not responding.',
}

/** Full-window splash while the engine boots, or a friendly error if it fails. */
export default function StartupScreen({ status, host, onRetry }) {
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const failed = status?.state === 'failed'

  useEffect(() => {
    if (failed) return undefined
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [failed])

  const copy = async () => {
    try {
      await host.copyDiagnostics()
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch { /* clipboard unavailable */ }
  }

  if (failed) {
    const err = status.error || {}
    return (
      <div className="startup" data-testid="startup-error">
        <div className="startup-card">
          <div className="startup-brand"><span className="brand-mark">◢◤</span> THE RIPPER</div>
          <h1 className="startup-title">The Ripper couldn&apos;t start its audio engine</h1>
          <p className="startup-text">{FRIENDLY[err.code] || 'Something went wrong while starting up.'}</p>
          <p className="startup-text startup-muted">
            Try again — if it keeps happening, click <b>Copy diagnostics</b> and paste the result into your
            message to us. It contains the app version, your OS, which tools were found and the engine log.
          </p>
          <div className="startup-actions">
            <button className="btn btn-primary" onClick={onRetry} data-testid="startup-retry">Try again</button>
            {host.capabilities.diagnostics && (
              <button className="btn" onClick={copy} data-testid="startup-copy-diagnostics">{copied ? 'Copied ✓' : 'Copy diagnostics'}</button>
            )}
            {host.capabilities.diagnostics && <button className="btn" onClick={() => host.openLogFolder()}>Open log folder</button>}
          </div>
          {err.message && (
            <details className="startup-details">
              <summary>Technical details</summary>
              <pre data-testid="startup-error-detail">{err.message}</pre>
            </details>
          )}
        </div>
      </div>
    )
  }

  const elapsed = status ? Math.max(0, now - status.startedAt) : 0
  const pct = Math.round(startupProgress(status?.stage, elapsed) * 100)
  return (
    <div className="startup" data-testid="startup-screen">
      <div className="startup-card">
        <div className="startup-brand"><span className="brand-mark">◢◤</span> THE RIPPER</div>
        <h1 className="startup-title">Starting The Ripper…</h1>
        <div className="startup-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="startup-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="startup-stage" data-testid="startup-stage">
          <span>{status?.stage && status.stage !== 'Starting' ? `${status.stage}…` : 'Getting ready…'}</span>
          <span className="startup-muted">{Math.floor(elapsed / 1000)} s</span>
        </div>
        {elapsed > 8000 && (
          <p className="startup-text startup-muted">
            The first launch can take up to a minute while your computer checks the app. Later launches are much faster.
          </p>
        )}
      </div>
    </div>
  )
}
