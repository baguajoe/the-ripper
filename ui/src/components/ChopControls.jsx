import { DIVISIONS, EVEN_COUNTS } from '../lib/grid.js'

const CHOP_MODES = [
  { id: 'even', label: 'Even' },
  { id: 'grid', label: 'Grid' },
  { id: 'transients', label: 'Transients' },
  { id: 'manual', label: 'Manual' },
]
// Grid sizes inside a selection: 1/4 beat … 1 bar
const GRID_SIZES = DIVISIONS.filter((d) => d.beats <= 4)

/**
 * chop: { mode, count, division, sensitivity, cap, snap, snapDivision, replace }
 * setChop(patch): size/mode changes re-chop the current bank right away (Editor).
 */
export default function ChopControls({ chop, setChop, onChop, busy, targetLabel, hasSelection }) {
  return (
    <div className="chop-controls">
      <div className="seg" role="tablist">
        {CHOP_MODES.map((m) => (
          <button key={m.id} className={`seg-btn ${chop.mode === m.id ? 'seg-on' : ''}`} onClick={() => setChop({ mode: m.id })} data-testid={`chop-mode-${m.id}`} title={`Chop mode: ${m.label ?? m.id}`}>
            {m.label}
          </button>
        ))}
      </div>
      {chop.mode === 'even' && (
        <select className="input" value={chop.count} onChange={(e) => setChop({ count: Number(e.target.value) })} data-testid="chop-count" title="Equal slices in the selection">
          {EVEN_COUNTS.map((n) => <option key={n} value={n}>Even {n}</option>)}
        </select>
      )}
      {chop.mode === 'grid' && (
        <select className="input" value={chop.division} onChange={(e) => setChop({ division: e.target.value })} data-testid="chop-division" title="One slice every…">
          {GRID_SIZES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      )}
      {chop.mode === 'transients' && (
        <>
          <label className="slider-label" title="Higher finds more (quieter) hits">Sens
            <input type="range" min="0" max="1" step="0.05" value={chop.sensitivity}
              onChange={(e) => setChop({ sensitivity: Number(e.target.value) })} data-testid="chop-sensitivity" />
            <span className="muted small num-3">{Math.round(chop.sensitivity * 100)}%</span>
          </label>
          <select className="input" value={chop.cap} onChange={(e) => setChop({ cap: Number(e.target.value) })} data-testid="chop-cap" title="Keep at most this many slices (the strongest hits)">
            {[4, 8, 16, 32].map((n) => <option key={n} value={n}>max {n}</option>)}
          </select>
        </>
      )}
      {chop.mode === 'manual' && <span className="muted small">Drag on the waveform to add a slice · <kbd>S</kbd> splits at the playhead</span>}
      <label className="chk" title="Snap selections and slice edges to the grid"><input type="checkbox" checked={chop.snap} onChange={(e) => setChop({ snap: e.target.checked })} data-testid="snap-toggle" />Snap</label>
      {chop.snap && (
        <select className="input" value={chop.snapDivision} onChange={(e) => setChop({ snapDivision: e.target.value })} data-testid="snap-division" title="Snap resolution">
          {DIVISIONS.slice(0, 4).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      )}
      <label className="chk" title="Chop into the bank you're on instead of the next empty one">
        <input type="checkbox" checked={chop.replace} onChange={(e) => setChop({ replace: e.target.checked })} data-testid="chop-replace" />Replace current bank
      </label>
      <button className="btn btn-primary" onClick={onChop} disabled={busy} data-testid="chop-apply"
        title={hasSelection ? 'Chop the selection' : 'No selection: chops 4 bars from the playhead'}>
        {chop.mode === 'manual' ? 'New slice' : 'Chop'} → {targetLabel}
      </button>
    </div>
  )
}
