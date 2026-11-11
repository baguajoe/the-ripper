import { useMemo, useState } from 'react'
import { createTapTempo } from '../lib/tapTempo.js'

export default function BpmControls({ analysis, onApply, busy }) {
  const [draft, setDraft] = useState(null)
  const tapper = useMemo(() => createTapTempo(), [])
  const bpm = analysis.bpm
  const shown = draft ?? String(Math.round(bpm * 100) / 100)
  const dirty = draft !== null && Number(draft) !== bpm && Number(draft) >= 20 && Number(draft) <= 400

  const apply = (patch) => { setDraft(null); tapper.reset(); onApply(patch) }
  return (
    <div className="bpm-controls">
      <label className="bpm-field">
        <input className="input input-bpm" value={shown} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && apply({ bpm: Number(draft) })}
          data-testid="bpm-input" aria-label="BPM" />
        <span className="muted">BPM</span>
      </label>
      {dirty && <button className="btn btn-small btn-primary" onClick={() => apply({ bpm: Number(draft) })} disabled={busy} data-testid="bpm-apply">Apply</button>}
      <button className="btn btn-small" onClick={() => apply({ bpm: bpm / 2 })} disabled={busy} data-testid="bpm-half" title="Half time">½</button>
      <button className="btn btn-small" onClick={() => apply({ bpm: bpm * 2 })} disabled={busy} data-testid="bpm-double" title="Double time">×2</button>
      <button className="btn btn-small" onClick={() => { const v = tapper.tap(); if (v) setDraft(String(v)) }} data-testid="bpm-tap" title="Tap tempo">TAP</button>
      {analysis.bpm_flag && (
        <span className="hint" data-testid="bpm-flag">{analysis.bpm_flag === 'maybe_double' ? 'Might be double-time' : 'Might be half-time'}</span>
      )}
    </div>
  )
}
