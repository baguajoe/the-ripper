import { useCallback, useEffect, useRef, useState } from 'react'
import { formatSeconds, monoOf, moveEdge, nudgeStep, parseTime, setRange, snapEdge, snapZero } from '../lib/trim.js'
import { BANKS } from '../lib/pads.js'

const H = 200

/** Zoomed trim view of one slice: drag / nudge / type its start and end. */
export default function TrimEditor({ slice, slices, bank, src, ctx, opts, setOpts, onApply, audition, setAudition, onClose }) {
  const canvas = useRef(null)
  const wrap = useRef(null)
  const [active, setActive] = useState('start')
  const [pad, setPadding] = useState(0.5) // context either side, as a fraction of the slice length
  const [width, setWidth] = useState(800)
  const drag = useRef(null)
  const [edit, setEdit] = useState({ start: null, end: null }) // text being typed (null = show the slice's time)
  const text = { start: edit.start ?? formatSeconds(slice.start), end: edit.end ?? formatSeconds(slice.end) }

  const len = slice.end - slice.start
  const margin = Math.max(0.05, len * pad)
  const vs = Math.max(0, slice.start - margin)
  const ve = Math.min(ctx.duration, slice.end + margin)
  const toX = useCallback((t) => ((t - vs) / (ve - vs)) * width, [vs, ve, width])
  const toT = useCallback((x) => vs + (x / width) * (ve - vs), [vs, ve, width])

  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // draw: min/max per pixel column of the mono mix, the slice highlighted, neighbours dimmed
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = H * dpr
    const g = c.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    g.fillStyle = '#12151b'
    g.fillRect(0, 0, width, H)
    for (const s of slices) {
      if (s.id === slice.id || s.end < vs || s.start > ve) continue
      g.fillStyle = 'rgba(64, 196, 255, 0.10)'
      g.fillRect(toX(s.start), 0, toX(s.end) - toX(s.start), H)
    }
    g.fillStyle = 'rgba(255, 196, 0, 0.16)'
    g.fillRect(toX(slice.start), 0, toX(slice.end) - toX(slice.start), H)
    const d = monoOf(src)
    const a = Math.floor(vs * src.sr)
    const per = ((ve - vs) * src.sr) / width
    g.strokeStyle = '#8a93a6'
    g.beginPath()
    for (let x = 0; x < width; x++) {
      const i0 = a + Math.floor(x * per)
      const i1 = Math.max(i0 + 1, a + Math.floor((x + 1) * per))
      let lo = 1
      let hi = -1
      for (let i = i0; i < i1 && i < d.length; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i] }
      if (hi < lo) { lo = 0; hi = 0 }
      g.moveTo(x + 0.5, H / 2 - hi * (H / 2 - 4))
      g.lineTo(x + 0.5, H / 2 - lo * (H / 2 - 4) + 1)
    }
    g.stroke()
    g.strokeStyle = 'rgba(255,255,255,0.15)'
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(width, H / 2); g.stroke()
    for (const [edge, t] of [['start', slice.start], ['end', slice.end]]) {
      const x = Math.round(toX(t)) + 0.5
      g.strokeStyle = edge === active ? '#ffd23f' : '#ff5c39'
      g.lineWidth = 2
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke()
      g.fillStyle = g.strokeStyle
      g.fillRect(edge === 'start' ? x : x - 10, 0, 10, 14)
      g.lineWidth = 1
    }
  }, [src, slice, slices, vs, ve, width, active, toX])

  const apply = useCallback((list, coalesce) => onApply(list, coalesce), [onApply])

  const moveTo = useCallback((edge, t, coalesce) => {
    apply(moveEdge(slices, slice.id, edge, t, { link: opts.link, duration: ctx.duration }), coalesce)
  }, [apply, slices, slice.id, opts.link, ctx.duration])

  const onPointerDown = (e) => {
    const r = canvas.current.getBoundingClientRect()
    const x = e.clientX - r.left
    const ds = Math.abs(x - toX(slice.start))
    const de = Math.abs(x - toX(slice.end))
    const edge = ds <= de ? 'start' : 'end'
    setActive(edge)
    drag.current = { edge, id: `trim-drag-${Date.now()}` }
    try { canvas.current.setPointerCapture(e.pointerId) } catch { /* not a live pointer */ }
    moveTo(edge, snapEdge(toT(x), opts, ctx), drag.current.id)
  }
  const onPointerMove = (e) => {
    if (!drag.current) return
    const r = canvas.current.getBoundingClientRect()
    moveTo(drag.current.edge, snapEdge(toT(e.clientX - r.left), opts, ctx), drag.current.id)
  }
  const onPointerUp = () => { drag.current = null }

  const nudge = useCallback((e, dir) => {
    const cur = active === 'start' ? slice.start : slice.end
    let t = cur + dir * nudgeStep(e, ctx.bpm)
    if (opts.zero && !(e.ctrlKey || e.metaKey)) t = snapZero(src, t, { dir, after: cur, window: Math.max(0.005, Math.abs(t - cur)) })
    moveTo(active, t, `nudge-${active}`)
  }, [active, slice.start, slice.end, ctx.bpm, opts.zero, src, moveTo])

  const commitText = (edge) => {
    if (edit[edge] == null) return // nothing typed
    const v = parseTime(edit[edge])
    setEdit((x) => ({ ...x, [edge]: null }))
    if (v == null) return
    const [s, e] = edge === 'start' ? [v, slice.end] : [slice.start, v]
    apply(setRange(slices, slice.id, s, e, { link: opts.link, duration: ctx.duration }))
  }

  // keys: arrows nudge the active marker; [ / ] pick start / end; Esc closes; Space auditions
  const keys = useRef({})
  useEffect(() => { keys.current = { nudge, onClose, setAudition, audition } })
  useEffect(() => {
    const down = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); keys.current.onClose(); return }
      if (e.target?.tagName === 'INPUT' && e.target.type === 'text') return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); keys.current.nudge(e, e.key === 'ArrowLeft' ? -1 : 1) }
      else if (e.key === '[') { e.preventDefault(); e.stopPropagation(); setActive('start') }
      else if (e.key === ']') { e.preventDefault(); e.stopPropagation(); setActive('end') }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); keys.current.onClose() }
      else if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); keys.current.setAudition(!keys.current.audition) }
      else if (!(e.ctrlKey || e.metaKey)) e.stopPropagation() // pads and transport keys stay out of the way (undo still works)
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal trim-editor" data-testid="trim-editor" role="dialog" aria-label="Trim slice">
        <div className="modal-head">
          <b>Trim · {BANKS[bank]}{String((slice.pad ?? 0) + 1).padStart(2, '0')} · {slice.name}</b>
          <span className="muted small">length {formatSeconds(len)} s · drag the markers, ←/→ nudge 1 ms (Shift 10 ms, Ctrl 1 beat), [ / ] pick start / end</span>
          <button className="btn btn-small" onClick={onClose} data-testid="trim-close" title="Close (Esc)">Done</button>
        </div>
        <div ref={wrap} className="trim-canvas-wrap">
          <canvas ref={canvas} style={{ width: `${width}px`, height: `${H}px` }} data-testid="trim-canvas"
            data-view={`${vs.toFixed(4)}-${ve.toFixed(4)}`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
        </div>
        <div className="trim-controls">
          {['start', 'end'].map((edge) => (
            <label key={edge} className={`num trim-time ${active === edge ? 'trim-active' : ''}`} title={`Exact ${edge} time in seconds (Enter to apply)`}>
              {edge === 'start' ? 'Start' : 'End'}
              <input type="text" className="input input-time" value={text[edge]} onFocus={() => setActive(edge)}
                onChange={(e) => setEdit((t) => ({ ...t, [edge]: e.target.value }))}
                onBlur={() => commitText(edge)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(edge) } }}
                data-testid={`trim-${edge}`} />s
            </label>
          ))}
          <div className="seg seg-small" title="Pick which marker the arrow keys move">
            <button className="seg-btn" onClick={(e) => nudge(e, -1)} data-testid="trim-nudge-left" title="Nudge the active marker left (←)">◀</button>
            <button className="seg-btn" onClick={(e) => nudge(e, 1)} data-testid="trim-nudge-right" title="Nudge the active marker right (→)">▶</button>
          </div>
          <label className="chk" title="Snap markers to the nearest zero crossing (no clicks)">
            <input type="checkbox" checked={opts.zero} onChange={(e) => setOpts({ ...opts, zero: e.target.checked })} data-testid="trim-zero" />Zero-crossing
          </label>
          <select className="input" value={opts.snap} onChange={(e) => setOpts({ ...opts, snap: e.target.value })} data-testid="trim-snap" title="Also snap dragged markers to…">
            <option value="off">No snap</option>
            <option value="transient">Nearest transient</option>
            <option value="grid">Grid</option>
          </select>
          <label className="chk" title="Moving an edge also moves the touching edge of the slice next to it, so slices stay contiguous">
            <input type="checkbox" checked={opts.link} onChange={(e) => setOpts({ ...opts, link: e.target.checked })} data-testid="trim-link" />Link neighbors
          </label>
          <label className="chk" title="Loop this slice while trimming; it restarts on every change (Space)">
            <input type="checkbox" checked={audition} onChange={(e) => setAudition(e.target.checked)} data-testid="trim-audition" />Loop audition
          </label>
          <div className="seg seg-small" title="Zoom">
            <button className="seg-btn" onClick={() => setPadding((p) => Math.min(4, p * 2))} data-testid="trim-zoom-out" title="Zoom out">−</button>
            <button className="seg-btn" onClick={() => setPadding((p) => Math.max(0.05, p / 2))} data-testid="trim-zoom-in" title="Zoom in">+</button>
          </div>
        </div>
      </div>
    </div>
  )
}
