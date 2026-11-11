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

/**
 * wavesurfer 8 + Regions/Timeline/Zoom/Minimap with a beat/bar grid overlay.
 * Slices are the source of truth (owned by the parent); regions mirror them.
 */
const Waveform = forwardRef(function Waveform(
  { audioBuffer, url, bpm, downbeat, slices, selectedId, loop, dragSelect,
    onSliceChange, onSelect, onCreate, onLoopChange, onReady, onTime, onPlayState },
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
  const [ready, setReady] = useState(false)

  useEffect(() => { loopRef.current = loop }, [loop])
  useEffect(() => { cbs.current = { onSliceChange, onSelect, onCreate, onLoopChange, onReady, onTime, onPlayState } })

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
      height: 150,
      waveColor: '#5b6475',
      progressColor: '#ff5c39',
      cursorColor: '#ffd23f',
      cursorWidth: 2,
      normalize: true,
      minPxPerSec: 40,
      autoScroll: true,
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
        if (end - start > 0.02) cbs.current.onCreate?.({ start, end })
        return
      }
      if (r.id === '__loop') cbs.current.onLoopChange?.({ start: r.start, end: r.end })
      else cbs.current.onSliceChange?.(r.id, { start: r.start, end: r.end })
    })
    reg.on('region-clicked', (r, e) => {
      e.stopPropagation()
      if (r.id !== '__loop') cbs.current.onSelect?.(r.id, { play: true })
    })

    return () => {
      ov.remove()
      w.destroy()
      ws.current = null
      regions.current = null
    }
  }, [audioBuffer, url])

  // Drag-to-select creates manual slices.
  useEffect(() => {
    if (!ready || !dragSelect || !regions.current) return undefined
    return regions.current.enableDragSelection({ color: 'rgba(255, 210, 63, 0.25)' })
  }, [ready, dragSelect])

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
        Object.assign(tag.style, {
          position: 'absolute', top: '1px', left: '4px', font: '600 10px ui-monospace, monospace',
          color: '#ffd23f', textShadow: '0 1px 2px #000',
        })
        d.appendChild(tag)
      }
      frag.appendChild(d)
    }
    ov.replaceChildren(frag)
    ov.dataset.lines = String(lines.length)
  }, [ready, bpm, downbeat, audioBuffer])

  // Mirror slices (+ loop) into regions.
  useEffect(() => {
    const reg = regions.current
    if (!ready || !reg) return
    syncing.current = true
    reg.clearRegions()
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
  }, [ready, slices, selectedId, loop])

  return (
    <div className="waveform-wrap">
      <div ref={container} className="waveform" data-testid="waveform" data-ready={ready ? 'true' : 'false'} />
      <div ref={minimap} className="minimap" />
    </div>
  )
})

export default Waveform
