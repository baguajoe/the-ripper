import { DIVISIONS } from '../lib/grid.js'

export default function ChopControls({ chop, setChop, onChop, busy }) {
  const set = (patch) => setChop({ ...chop, ...patch })
  return (
    <div className="chop-controls">
      <div className="seg" role="tablist">
        {['grid', 'transients', 'manual'].map((m) => (
          <button key={m} className={`seg-btn ${chop.mode === m ? 'seg-on' : ''}`} onClick={() => set({ mode: m })} data-testid={`chop-mode-${m}`}>
            {m === 'grid' ? 'Grid' : m === 'transients' ? 'Transients' : 'Manual'}
          </button>
        ))}
      </div>
      {chop.mode === 'grid' && (
        <select className="input" value={chop.division} onChange={(e) => set({ division: e.target.value })} data-testid="chop-division">
          {DIVISIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      )}
      {chop.mode === 'transients' && (
        <label className="slider-label">Sensitivity
          <input type="range" min="0" max="1" step="0.05" value={chop.sensitivity}
            onChange={(e) => set({ sensitivity: Number(e.target.value) })} data-testid="chop-sensitivity" />
          <span className="muted small">{Math.round(chop.sensitivity * 100)}%</span>
        </label>
      )}
      {chop.mode === 'manual' && <span className="muted small">Press <kbd>S</kbd> to slice at the playhead, or drag on the waveform.</span>}
      <label className="chk"><input type="checkbox" checked={chop.snap} onChange={(e) => set({ snap: e.target.checked })} data-testid="snap-toggle" />Snap</label>
      {chop.snap && (
        <select className="input" value={chop.snapDivision} onChange={(e) => set({ snapDivision: e.target.value })} data-testid="snap-division" title="Snap resolution">
          {DIVISIONS.slice(0, 4).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      )}
      <button className="btn btn-primary" onClick={onChop} disabled={busy} data-testid="chop-apply">
        {chop.mode === 'manual' ? 'Reset slices' : 'Chop'}
      </button>
    </div>
  )
}
