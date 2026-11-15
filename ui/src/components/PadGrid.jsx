import { useCallback, useEffect, useRef, useState } from 'react'
import { BANKS, PADS_PER_BANK, padKeyLabel } from '../lib/pads.js'
import { isDraggingOut, useNativeDrag } from '../hooks/useNativeDrag.js'
import { dragSpec } from '../lib/exportSpec.js'
import { padSlice } from '../lib/program.js'
import { PAD_COLORS, isShaped } from '../dsp/params.js'

const PAD_MIME = 'application/x-ripper-pad'
let lastDragPad = -1 // pad dragged out to the DAW (an OS drag that may come back over a pad)

function Pad({ index, slice, active, selected, onTrigger, onRelease, onSelectPad, onSwap, onMenu, onTrim, trackId, options, bankInfo }) {
  const getSpec = useCallback(
    () => (slice ? dragSpec(trackId, 'slice', { slices: [{ ...slice, ...bankInfo }], options }) : null),
    [slice, trackId, options, bankInfo],
  )
  const drag = useNativeDrag(getSpec)
  const [over, setOver] = useState(false)
  const dragProps = slice ? {
    ...drag,
    onDragStart: (e) => {
      if (e.altKey) { // Alt-drag: move/swap pads inside the app
        e.dataTransfer.setData(PAD_MIME, String(index))
        e.dataTransfer.effectAllowed = 'move'
        return
      }
      lastDragPad = index
      drag.onDragStart(e)
    },
  } : {}
  const accepts = (e) => e.dataTransfer?.types?.includes(PAD_MIME) || (isDraggingOut() && lastDragPad >= 0)
  return (
    <button
      type="button"
      className={`pad ${slice ? '' : 'pad-empty'} ${active ? 'pad-active' : ''} ${selected ? 'pad-selected' : ''} ${over ? 'pad-drop' : ''}`}
      data-testid={`pad-${index}`}
      data-slice={slice?.id ?? ''}
      style={slice?.color ? { '--pad-color': slice.color } : undefined}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        onSelectPad(index)
        if (slice) onTrigger(index, e)
      }}
      onMouseUp={() => slice && onRelease(index)}
      onMouseLeave={() => slice && onRelease(index)}
      onDoubleClick={() => slice && onTrim(index)}
      onContextMenu={(e) => { e.preventDefault(); onSelectPad(index); onMenu(index, e.currentTarget.getBoundingClientRect()) }}
      onDragOver={(e) => { if (accepts(e)) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const internal = e.dataTransfer?.getData(PAD_MIME)
        const from = internal !== '' && internal != null ? Number(internal) : (isDraggingOut() ? lastDragPad : -1)
        if (from < 0) return
        e.preventDefault()
        e.stopPropagation()
        lastDragPad = -1
        if (from !== index) onSwap(from, index)
      }}
      title={slice ? `${slice.name}${slice.padMode === 'noteon' ? ' (plays while held)' : ''} — drag to your DAW · Alt-drag onto a pad to swap · double-click to trim · right-click for name, color, copy/paste` : 'Empty pad — right-click to paste'}
      {...dragProps}
    >
      <span className="pad-key">{padKeyLabel(index)}</span>
      <span className="pad-name">{slice ? slice.name : ''}</span>
      {slice?.choke && <span className="pad-flag">CH</span>}
      {slice?.reverse && <span className="pad-flag pad-flag-rev">REV</span>}
      {slice?.padMode === 'noteon' && <span className="pad-flag pad-flag-hold">HOLD</span>}
      {slice && isShaped(slice) && <span className="pad-flag pad-flag-shaped" title="Sound shaped">◆</span>}
    </button>
  )
}

/** Right-click menu on a pad: rename, color, copy / paste, trim, clear. */
export function PadMenu({ at, slice, canPaste, onRename, onColor, onCopy, onPaste, onTrim, onClear, onClose }) {
  const [name, setName] = useState(slice?.name ?? '')
  const ref = useRef(null)
  useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', esc, true) }
  }, [onClose])
  const left = Math.min(at.left, window.innerWidth - 230)
  const top = Math.min(at.bottom + 4, window.innerHeight - 190)
  return (
    <div ref={ref} className="pad-menu" style={{ left, top }} data-testid="pad-menu" onKeyDown={(e) => e.stopPropagation()}>
      {slice && (
        <>
          <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} data-testid="pad-rename"
            onKeyDown={(e) => { if (e.key === 'Enter') { onRename(name.trim() || slice.name); onClose() } }}
            onBlur={() => name.trim() && name !== slice.name && onRename(name.trim())} aria-label="Pad name" title="Rename (Enter)" />
          <div className="pad-colors">
            {PAD_COLORS.map((c, i) => (
              <button key={c} className={`pad-color ${slice.color === c ? 'pad-color-on' : ''}`} style={{ background: c }}
                onClick={() => onColor(c)} data-testid={`pad-color-${i}`} title="Pad color" />
            ))}
            <button className="pad-color pad-color-none" onClick={() => onColor(null)} data-testid="pad-color-none" title="No color">✕</button>
          </div>
        </>
      )}
      <div className="pad-menu-row">
        <button className="btn btn-small" onClick={() => { onCopy(); onClose() }} disabled={!slice} data-testid="pad-copy" title="Copy this pad (Ctrl+C)">Copy</button>
        <button className="btn btn-small" onClick={() => { onPaste(); onClose() }} disabled={!canPaste} data-testid="pad-paste" title="Paste onto this pad (Ctrl+V)">Paste</button>
        <button className="btn btn-small" onClick={() => { onTrim(); onClose() }} disabled={!slice} data-testid="pad-trim" title="Trim this pad (double-click)">Trim…</button>
        <button className="btn btn-small btn-ghost" onClick={() => { onClear(); onClose() }} disabled={!slice} data-testid="pad-clear" title="Empty this pad">Clear</button>
      </div>
    </div>
  )
}

/**
 * banks: the program's 8 banks; bank: current index; allowedBanks: how many the plan allows.
 */
export default function PadGrid({ banks, bank, setBank, allowedBanks, activePads, selectedPad, onTrigger, onRelease,
  onMono, onChokeAll, onClear, onStop, trackId, options, onSelectPad, onSwap, onMenu, onTrim, bankInfo, children }) {
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
        <label className="chk" title="Mono: hitting a pad stops the previous one in this bank (classic sampler style). Poly: one-shots ring out.">
          <input type="checkbox" checked={cur.mono} onChange={(e) => onMono(e.target.checked)} data-testid="bank-mono" />
          Mono (chops cut each other)
        </label>
        <button className="btn btn-small" onClick={() => onChokeAll(true)} disabled={!slices.length} data-testid="choke-all" title="Every pad in this bank cuts the others (a choke group)">Choke all</button>
        <button className="btn btn-small" onClick={() => onChokeAll(false)} disabled={!slices.length} data-testid="unchoke-all">Unchoke all</button>
        <button className="btn btn-small btn-ghost" onClick={onClear} disabled={!slices.length} data-testid="bank-clear" title="Empty this bank (undo with Ctrl+Z)">Clear</button>
        {children}
      </div>
      <div className="padgrid" data-testid="pad-grid" data-bank={bank}>
        {Array.from({ length: PADS_PER_BANK }, (_, i) => {
          const slice = padSlice(cur, i)
          return (
            <Pad key={i} index={i} slice={slice} active={activePads.has(i)} selected={i === selectedPad}
              onTrigger={onTrigger} onRelease={onRelease} onSelectPad={onSelectPad} onSwap={onSwap} onMenu={onMenu} onTrim={onTrim}
              trackId={trackId} options={options} bankInfo={bankInfo} />
          )
        })}
      </div>
    </div>
  )
}
