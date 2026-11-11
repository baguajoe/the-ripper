import { useCallback } from 'react'
import { BANKS, PADS_PER_BANK, bankCount, padKeyLabel, padToSlice } from '../lib/pads.js'
import { useNativeDrag } from '../hooks/useNativeDrag.js'
import { dragSpec } from '../lib/exportSpec.js'

function Pad({ index, slice, active, selected, onTrigger, trackId, options }) {
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
      title={slice ? `${slice.name} — drag to your DAW` : 'Empty'}
      {...(slice ? drag : {})}
    >
      <span className="pad-key">{padKeyLabel(index)}</span>
      <span className="pad-name">{slice ? slice.name : ''}</span>
      {slice?.choke && <span className="pad-flag">CH</span>}
      {slice?.reverse && <span className="pad-flag pad-flag-rev">REV</span>}
    </button>
  )
}

export default function PadGrid({ slices, bank, setBank, activePads, selectedId, onTrigger, trackId, options }) {
  const banks = bankCount(slices.length)
  return (
    <div className="padgrid-wrap">
      <div className="bank-row">
        {Array.from({ length: banks }, (_, b) => (
          <button key={b} className={`btn btn-small ${b === bank ? 'btn-on' : ''}`} onClick={() => setBank(b)} data-testid={`bank-${b}`}>
            Bank {BANKS[b] ?? b + 1}
          </button>
        ))}
        <span className="muted small">Keys 1234 / QWER / ASDF / ZXCV · drag a pad into your DAW</span>
      </div>
      <div className="padgrid" data-testid="pad-grid">
        {Array.from({ length: PADS_PER_BANK }, (_, i) => {
          const slice = slices[padToSlice(i, bank)]
          return (
            <Pad key={i} index={i} slice={slice} active={activePads.has(i)} selected={slice && slice.id === selectedId}
              onTrigger={onTrigger} trackId={trackId} options={options} />
          )
        })}
      </div>
    </div>
  )
}
