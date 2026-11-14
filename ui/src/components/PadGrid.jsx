import { useCallback } from 'react'
import { BANKS, PADS_PER_BANK, padKeyLabel } from '../lib/pads.js'
import { useNativeDrag } from '../hooks/useNativeDrag.js'
import { dragSpec } from '../lib/exportSpec.js'

function Pad({ index, slice, active, selected, onTrigger, onRelease, trackId, options }) {
  const getSpec = useCallback(
    () => (slice ? dragSpec(trackId, 'slice', { slices: [slice], options }) : null),
    [slice, trackId, options],
  )
  const drag = useNativeDrag(getSpec)
  return (
    <button
      type="button"
      className={`pad ${slice ? '' : 'pad-empty'} ${active ? 'pad-active' : ''} ${selected ? 'pad-selected' : ''}`}
      data-testid={`pad-${index}`}
      disabled={!slice}
      onMouseDown={(e) => { if (e.button === 0 && slice) onTrigger(index) }}
      onMouseUp={() => slice && onRelease(index)}
      onMouseLeave={() => slice && onRelease(index)}
      title={slice ? `${slice.name}${slice.padMode === 'noteon' ? ' (plays while held)' : ''} — drag to your DAW` : 'Empty'}
      {...(slice ? drag : {})}
    >
      <span className="pad-key">{padKeyLabel(index)}</span>
      <span className="pad-name">{slice ? slice.name : ''}</span>
      {slice?.choke && <span className="pad-flag">CH</span>}
      {slice?.reverse && <span className="pad-flag pad-flag-rev">REV</span>}
      {slice?.padMode === 'noteon' && <span className="pad-flag pad-flag-hold">HOLD</span>}
    </button>
  )
}

/**
 * banks: the program's 8 banks; bank: current index; allowedBanks: how many the plan allows.
 */
export default function PadGrid({ banks, bank, setBank, allowedBanks, activePads, selectedId, onTrigger, onRelease,
  onMono, onChokeAll, onClear, onStop, trackId, options }) {
  const cur = banks[bank]
  const slices = cur.slices
  return (
    <div className="padgrid-wrap">
      <div className="bank-row">
        {banks.map((b, i) => {
          const locked = i >= allowedBanks
          return (
            <button key={i} className={`btn btn-small bank-btn ${i === bank ? 'btn-on' : ''} ${b.slices.length ? 'bank-full' : ''}`}
              onClick={() => setBank(i)} disabled={locked} data-testid={`bank-${i}`} data-count={b.slices.length}
              title={locked ? `Bank ${BANKS[i]} is a Pro feature` : `Bank ${BANKS[i]}: ${b.slices.length} pad(s)`}>
              {BANKS[i]}{locked && <span className="badge badge-pro-lock">PRO</span>}
            </button>
          )
        })}
        <button className="btn btn-small btn-warn" onClick={onStop} title="Stop all playback (Esc)" data-testid="stop-all">■ Stop</button>
      </div>
      <div className="bank-row bank-opts">
        <label className="chk" title="Mono: hitting a pad stops the previous one in this bank (like an MPC). Poly: one-shots ring out.">
          <input type="checkbox" checked={cur.mono} onChange={(e) => onMono(e.target.checked)} data-testid="bank-mono" />
          Mono (chops cut each other)
        </label>
        <button className="btn btn-small" onClick={() => onChokeAll(true)} disabled={!slices.length} data-testid="choke-all" title="Every pad in this bank cuts the others (a choke group)">Choke all</button>
        <button className="btn btn-small" onClick={() => onChokeAll(false)} disabled={!slices.length} data-testid="unchoke-all">Unchoke all</button>
        <button className="btn btn-small btn-ghost" onClick={onClear} disabled={!slices.length} data-testid="bank-clear" title="Empty this bank (undo with Ctrl+Z)">Clear</button>
      </div>
      <div className="padgrid" data-testid="pad-grid" data-bank={bank}>
        {Array.from({ length: PADS_PER_BANK }, (_, i) => {
          const slice = slices[i]
          return (
            <Pad key={i} index={i} slice={slice} active={activePads.has(i)} selected={slice && slice.id === selectedId}
              onTrigger={onTrigger} onRelease={onRelease} trackId={trackId} options={options} />
          )
        })}
      </div>
    </div>
  )
}
