import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js'
import ZoomPlugin from 'wavesurfer.js/dist/plugins/zoom.esm.js'
import MinimapPlugin from 'wavesurfer.js/dist/plugins/minimap.esm.js'
import { gridLines } from '../lib/grid.js'

const COLORS = ['rgba(255, 92, 57, 0.18)', 'rgba(64, 196, 255, 0.16)']
const SELECTED = 'rgba(255, 196, 0, 0.30)'
const LOOP = 'rgba(120, 255, 140, 0.20)'
const SELECTION = 'rgba(64, 160, 255, 0.20)'
const TIMELINE_H = 22 // timeline plugin row under the waveform

/**
 * wavesurfer 8 + Regions/Timeline/Zoom/Minimap with a beat/bar grid overlay.
 * Slices and the selection are owned by the parent; regions mirror them.
 *   dragMode 'select': dragging on the waveform makes a selection (onSelectionChange)
 *   dragMode 'slice':  dragging makes a slice (onCreate) - Manual chopping
 * Bar numbers are clickable: onBarClick(bar, shiftKey).
 */
const Waveform = forwardRef(function Waveform(
  { audioBuffer, url, bpm, downbeat, slices, selectedId, loop, selection, dragMode = 'select',
    onSliceChange, onSelect, onCreate, onLoopChange, onSelectionChange, onBarClick, onReady, onTime, onPlayState,
    zoom = 0, follow = false },
  ref,
) {
  const container = useRef(null)
  const minimap = useRef(null)
  const ws = useRef(null)
  const regions = useRef(null)
  const overlay = useRef(null)
  const syncing = useRef(false)
  const pendingUser = useRef(null)
  const loopRef = useRef(loop)
  const cbs = useRef({})
  const view = useRef({ zoom, follow })
  const [ready, setReady] = useState(false)
  const [height, setHeight] = useState(0) // waveform px height, from the space the layout gives us

  useEffect(() => { view.current = { zoom, follow } }, [zoom, follow])

  // Size the waveform to its container (the editor layout decides the height, not the content).
  useEffect(() => {
    const el = container.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => {
      const h = Math.max(60, Math.floor(el.clientHeight) - TIMELINE_H)
      setHeight((cur) => (Math.abs(cur - h) >= 2 ? h : cur))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  useEffect(() => { if (ready && height) ws.current?.setOptions({ height }) }, [ready, height])
  useEffect(() => { if (ready) ws.current?.zoom(zoom) }, [ready, zoom])
  // No automatic scrolling unless the user asked to follow the playhead.
  useEffect(() => { if (ready) ws.current?.setOptions({ autoScroll: follow, autoCenter: follow }) }, [ready, follow])

  useEffect(() => { loopRef.current = loop }, [loop])
  const modeRef = useRef(dragMode)
  useEffect(() => { modeRef.current = dragMode }, [dragMode])
  useEffect(() => { cbs.current = { onSliceChange, onSelect, onCreate, onLoopChange, onSelectionChange, onBarClick, onReady, onTime, onPlayState } })

  useImperativeHandle(ref, () => ({
    playPause: () => ws.current?.playPause(),
    play: () => ws.current?.play(),
    pause: () => ws.current?.pause(),
    isPlaying: () => !!ws.current?.isPlaying(),
    getCurrentTime: () => ws.current?.getCurrentTime() ?? 0,
    setTime: (t) => ws.current?.setTime(t),
    zoom: (px) => ws.current?.zoom(px),
  }), [])

  // Create wavesurfer once per audio source.
  useEffect(() => {
    if (!audioBuffer || !url || !container.current) return undefined
    setReady(false)
    const reg = RegionsPlugin.create()
    const peaks = []
    for (let c = 0; c < Math.min(2, audioBuffer.numberOfChannels); c++) peaks.push(audioBuffer.getChannelData(c))
    const w = WaveSurfer.create({
      container: container.current,
      height: Math.max(60, (container.current.clientHeight || 172) - TIMELINE_H),
      waveColor: '#5b6475',
      progressColor: '#ff5c39',
      cursorColor: '#ffd23f',
      cursorWidth: 2,
      normalize: true,
      minPxPerSec: view.current.zoom,
      fillParent: true,
      hideScrollbar: true, // navigate with the minimap / zoom; no scrollbar appearing and vanishing
      autoScroll: view.current.follow,
      autoCenter: view.current.follow,
      dragToSeek: false,
      url,
      peaks,
      duration: audioBuffer.duration,
      plugins: [
        reg,
        TimelinePlugin.create({ height: 16, style: { color: '#7d8597', fontSize: '10px' } }),
        ZoomPlugin.create({ scale: 0.2, maxZoom: 2000 }),
        MinimapPlugin.create({ container: minimap.current, height: 28, waveColor: '#3a4150', progressColor: '#a8442e' }),
      ],
    })
    ws.current = w
    regions.current = reg

    // wavesurfer renders in a Shadow DOM, so app CSS can't reach in: style inline.
    const ov = document.createElement('div')
    ov.className = 'grid-overlay'
    Object.assign(ov.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '10' })
    overlay.current = ov

    w.on('ready', () => {
      w.getWrapper().appendChild(ov)
      setReady(true)
      cbs.current.onReady?.(w)
    })
    w.on('timeupdate', (t) => {
      const lp = loopRef.current
      if (lp?.active && lp.end > lp.start && t >= lp.end && w.isPlaying()) w.setTime(lp.start)
      cbs.current.onTime?.(t)
    })
    w.on('play', () => cbs.current.onPlayState?.(true))
    w.on('pause', () => cbs.current.onPlayState?.(false))
    w.on('finish', () => cbs.current.onPlayState?.(false))
    w.on('seeking', (t) => cbs.current.onTime?.(t))
    reg.on('region-created', (r) => {
      if (syncing.current) return
      pendingUser.current = r // created by drag-select; finalised on region-updated
    })
    reg.on('region-updated', (r) => {
      if (r === pendingUser.current) {
        pendingUser.current = null
        const { start, end } = r
        syncing.current = true
        r.remove()
        syncing.current = false
        if (end - start > 0.02) {
          if (modeRef.current === 'slice') cbs.current.onCreate?.({ start, end })
          else cbs.current.onSelectionChange?.({ start, end })
        }
        return
      }
      if (r.id === '__loop') cbs.current.onLoopChange?.({ start: r.start, end: r.end })
      else if (r.id === '__sel') cbs.current.onSelectionChange?.({ start: r.start, end: r.end })
      else cbs.current.onSliceChange?.(r.id, { start: r.start, end: r.end })
    })
    reg.on('region-clicked', (r, e) => {
      e.stopPropagation()
      if (r.id !== '__loop' && r.id !== '__sel') cbs.current.onSelect?.(r.id, { play: true })
    })

    return () => {
      ov.remove()
      w.destroy()
      ws.current = null
      regions.current = null
    }
  }, [audioBuffer, url])

  // Drag on the waveform: a selection (or, in Manual mode, a new slice).
  useEffect(() => {
    if (!ready || !regions.current || dragMode === 'none') return undefined
    return regions.current.enableDragSelection({ color: dragMode === 'slice' ? 'rgba(255, 210, 63, 0.25)' : SELECTION })
  }, [ready, dragMode])

  // Beat / bar grid overlay (percent positions survive zoom).
  useEffect(() => {
    const ov = overlay.current
    if (!ready || !ov || !audioBuffer) return
    const dur = audioBuffer.duration
    const lines = gridLines(bpm, downbeat, dur)
    const frag = document.createDocumentFragment()
    for (const l of lines) {
      const d = document.createElement('div')
      d.className = l.bar ? 'grid-line grid-bar' : 'grid-line'
      Object.assign(d.style, {
        position: 'absolute', top: '0', bottom: '0', left: `${(l.t / dur) * 100}%`,
        width: l.bar ? '2px' : '1px',
        background: l.bar ? 'rgba(255, 210, 63, 0.75)' : 'rgba(255, 255, 255, 0.22)',
      })
      if (l.bar) {
        const bar = Math.floor(l.index / 4) + 1
        d.dataset.bar = String(bar)
        const tag = document.createElement('span')
        tag.textContent = String(bar)
        tag.dataset.testid = `bar-tag-${bar}`
        tag.title = `Select bar ${bar} (Shift-click another bar to select a range)`
        Object.assign(tag.style, {
          position: 'absolute', top: '1px', left: '2px', font: '600 10px ui-monospace, monospace',
          color: '#ffd23f', textShadow: '0 1px 2px #000', pointerEvents: 'auto', cursor: 'pointer',
          padding: '0 3px', borderRadius: '3px', background: 'rgba(0, 0, 0, 0.35)', userSelect: 'none',
        })
        // own the click: no seek, no drag-select starting from a bar number
        const stop = (e) => { e.stopPropagation(); e.preventDefault() }
        tag.addEventListener('pointerdown', stop)
        tag.addEventListener('mousedown', stop)
        tag.addEventListener('click', (e) => { stop(e); cbs.current.onBarClick?.(bar, e.shiftKey) })
        d.appendChild(tag)
      }
      frag.appendChild(d)
    }
    ov.replaceChildren(frag)
    ov.dataset.lines = String(lines.length)
  }, [ready, bpm, downbeat, audioBuffer])

  // Mirror the selection, slices and loop into regions.
  useEffect(() => {
    const reg = regions.current
    if (!ready || !reg) return
    syncing.current = true
    reg.clearRegions()
    if (selection && selection.end > selection.start) {
      reg.addRegion({ id: '__sel', start: selection.start, end: selection.end, color: SELECTION, drag: true, resize: true })
    }
    slices.forEach((s, i) => {
      const label = document.createElement('span')
      label.className = 'region-label'
      label.textContent = `${i + 1}${s.reverse ? ' ⟲' : ''}`
      Object.assign(label.style, {
        position: 'absolute', bottom: '2px', left: '4px', font: '10px ui-monospace, monospace',
        color: '#fff', opacity: '0.85', pointerEvents: 'none',
      })
      reg.addRegion({
        id: s.id,
        start: s.start,
        end: s.end,
        color: s.id === selectedId ? SELECTED : COLORS[i % 2],
        drag: false,
        resize: true,
        content: label,
      })
    })
    if (loop?.active && loop.end > loop.start) {
      reg.addRegion({ id: '__loop', start: loop.start, end: loop.end, color: LOOP, drag: true, resize: true })
    }
    syncing.current = false
  }, [ready, slices, selectedId, loop, selection])

  return (
    <div className="waveform-wrap">
      <div ref={container} className="waveform" data-testid="waveform" data-ready={ready ? 'true' : 'false'}
        data-selection={selection ? `${selection.start.toFixed(3)}-${selection.end.toFixed(3)}` : ''} />
      <div ref={minimap} className="minimap" />
    </div>
  )
})

export default Waveform
