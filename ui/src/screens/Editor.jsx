import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { useApp } from '../context.js'
import { useKeyboard } from '../hooks/useKeyboard.js'
import Waveform from '../components/Waveform.jsx'
import PadGrid from '../components/PadGrid.jsx'
import SliceRow from '../components/SliceRow.jsx'
import ChopControls from '../components/ChopControls.jsx'
import BpmControls from '../components/BpmControls.jsx'
import ExportPanel from '../components/ExportPanel.jsx'
import { divisionBeats, gridSlices, renumber, shiftDownbeat, snap, splitAt, transientSlices } from '../lib/grid.js'
import { keyToPad, padToSlice } from '../lib/pads.js'
import { SlicePlayer } from '../lib/slicePlayer.js'
import { DEFAULT_EXPORT, toApiSlice } from '../lib/exportSpec.js'
import { buildFilename } from '../lib/filenames.js'
import { formatTime } from '../lib/format.js'

/** Clock display with its own state so playback doesn't re-render the whole editor. */
function Playhead({ subscribe, duration }) {
  const [t, setT] = useState(0)
  useEffect(() => subscribe(setT), [subscribe])
  // Fixed width (see .time): the text changes 10x a second and must never reflow the row.
  return <span className="time" data-testid="playhead">{formatTime(t)} / {formatTime(duration)}</span>
}

// Slices survive navigation (Editor <-> Stems) for the session.
const sliceCache = new Map()
let nextId = 1
const withIds = (list, source) => list.map((s) => ({
  gain: 0, fadeIn: 0, fadeOut: 0.005, reverse: false, choke: false, ...s, source, id: s.id ?? `s${nextId++}`,
}))

/** Remount per track + source so a stem sent from the mixer gets its own editor state. */
export default function EditorRoute() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const source = params.get('source') || 'mix'
  return <Editor key={`${id}:${source}`} id={id} source={source} />
}

function Editor({ id, source }) {
  const { host, notify } = useApp()

  const [track, setTrack] = useState(null)
  const [buffer, setBuffer] = useState(null)
  const [blobUrl, setBlobUrl] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [slices, setSlicesState] = useState(() => sliceCache.get(`${id}:${source}`) ?? [])
  const [selectedId, setSelectedId] = useState(null)
  const [chop, setChop] = useState({ mode: 'grid', division: '1bar', sensitivity: 0.5, snap: true, snapDivision: '1' })
  const [loop, setLoop] = useState({ active: false, start: 0, end: 0 })
  const [bank, setBank] = useState(0)
  const [activePads, setActivePads] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const timeListeners = useRef(new Set())
  const subscribeTime = useCallback((fn) => {
    timeListeners.current.add(fn)
    return () => timeListeners.current.delete(fn)
  }, [])
  const onTime = useCallback((t) => { for (const fn of timeListeners.current) fn(t) }, [])
  const [zoom, setZoom] = useState(0) // 0 = whole track fits the width
  const [follow, setFollow] = useState(false) // scroll the zoomed waveform with the playhead
  const [options, setOptionsState] = useState(DEFAULT_EXPORT)
  const wave = useRef(null)
  const player = useRef(null)

  const setSlices = useCallback((next) => {
    setSlicesState((prev) => {
      const val = typeof next === 'function' ? next(prev) : next
      sliceCache.set(`${id}:${source}`, val)
      return val
    })
  }, [id, source])

  // remembered export options
  useEffect(() => { host.getSetting('exportOptions').then((o) => o && setOptionsState({ ...DEFAULT_EXPORT, ...o })).catch(() => {}) }, [host])
  const setOptions = useCallback((o) => { setOptionsState(o); host.setSetting('exportOptions', o).catch(() => {}) }, [host])

  // load track + audio
  useEffect(() => {
    let alive = true
    let url = null
    ;(async () => {
      try {
        const t = await api.getTrack(id)
        if (!alive) return
        setTrack(t)
        const bytes = await api.audioBytes(id, source)
        if (!alive) return
        url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
        const ctx = host.audio.getContext()
        const buf = await ctx.decodeAudioData(bytes.slice(0))
        if (!alive) return
        if (!player.current) player.current = new SlicePlayer(ctx)
        player.current.setBuffer(buf)
        setBlobUrl(url)
        setBuffer(buf)
      } catch (e) {
        if (alive) setLoadError(e.message)
      }
    })()
    return () => {
      alive = false
      player.current?.stopAll()
      if (url) URL.revokeObjectURL(url)
    }
  }, [id, source, host])

  const analysis = track?.analysis
  const duration = buffer?.duration ?? track?.duration ?? 0

  const doChop = useCallback(async (override) => {
    if (!analysis || !duration) return
    const c = { ...chop, ...override }
    let next
    if (c.mode === 'grid') next = gridSlices(analysis.bpm, analysis.downbeat, duration, divisionBeats(c.division))
    else if (c.mode === 'transients') {
      setBusy(true)
      try {
        next = transientSlices(await api.onsets(id, c.sensitivity, source), duration)
      } catch (e) {
        notify(e.message, 'error')
        return
      } finally {
        setBusy(false)
      }
    } else next = [{ start: 0, end: duration, name: 'slice01' }]
    setSlices(withIds(next, source))
    setSelectedId(null)
    setBank(0)
  }, [analysis, duration, chop, id, source, notify, setSlices])

  // first open: auto-chop by bar so pads are ready immediately
  const autoChopped = useRef(false)
  useEffect(() => {
    if (buffer && analysis && !autoChopped.current && slices.length === 0) {
      autoChopped.current = true
      doChop()
    }
  }, [buffer, analysis, slices.length, doChop])

  const snapT = useCallback((t) => (chop.snap && analysis
    ? snap(t, analysis.bpm, analysis.downbeat, divisionBeats(chop.snapDivision), duration) : t), [chop.snap, chop.snapDivision, analysis, duration])

  const flashPad = useCallback((i) => {
    setActivePads((s) => new Set(s).add(i))
    setTimeout(() => setActivePads((s) => { const n = new Set(s); n.delete(i); return n }), 120)
  }, [])

  const playSlice = useCallback((s) => { if (s) player.current?.play(s) }, [])

  const triggerPad = useCallback((pad) => {
    const s = slices[padToSlice(pad, bank)]
    if (!s) return
    playSlice(s)
    flashPad(pad)
    setSelectedId(s.id)
  }, [slices, bank, playSlice, flashPad])

  const regrid = useCallback(async (patch) => {
    setBusy(true)
    try {
      const t = await api.patchTrack(id, patch)
      setTrack(t)
      if (chop.mode === 'grid') {
        const a = t.analysis
        setSlices(withIds(gridSlices(a.bpm, a.downbeat, duration, divisionBeats(chop.division)), source))
      }
    } catch (e) {
      notify(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [id, chop.mode, chop.division, duration, source, notify, setSlices])

  const splitAtPlayhead = useCallback(() => {
    const t = snapT(wave.current?.getCurrentTime() ?? 0)
    setSlices((prev) => {
      const base = prev.length ? prev : withIds([{ start: 0, end: duration, name: 'slice01' }], source)
      return withIds(splitAt(base, t), source)
    })
  }, [snapT, duration, source, setSlices])

  const toggleLoop = useCallback(() => {
    setLoop((l) => {
      if (l.active) return { ...l, active: false }
      const sel = slices.find((s) => s.id === selectedId)
      if (sel) return { active: true, start: sel.start, end: sel.end }
      if (l.end > l.start) return { ...l, active: true }
      const t = wave.current?.getCurrentTime() ?? 0
      const bar = analysis ? (240 / analysis.bpm) : 2
      return { active: true, start: t, end: Math.min(duration, t + bar) }
    })
  }, [slices, selectedId, analysis, duration])

  useKeyboard((e) => {
    const k = e.key.toLowerCase()
    if (e.code === 'Space') {
      e.preventDefault()
      wave.current?.playPause()
      return
    }
    if (k === 'l') return toggleLoop()
    if (k === 'escape') return player.current?.stopAll()
    // "S" slices at the playhead in Manual mode; otherwise it's pad 10 (ASDF row).
    if (k === 's' && chop.mode === 'manual') return splitAtPlayhead()
    const pad = keyToPad(e.code) >= 0 ? keyToPad(e.code) : keyToPad(k)
    if (pad >= 0) {
      e.preventDefault()
      triggerPad(pad)
    }
  })

  const updateSlice = useCallback((sid, patch) => setSlices((prev) => prev.map((s) => (s.id === sid ? { ...s, ...patch } : s))), [setSlices])

  const onRegionChange = useCallback((sid, { start, end }) => {
    setSlices((prev) => renumber(prev.map((s) => (s.id === sid ? { ...s, start: snapT(start), end: Math.max(snapT(end), snapT(start) + 0.01) } : s))))
  }, [snapT, setSlices])

  const onRegionCreate = useCallback(({ start, end }) => {
    const s0 = snapT(start)
    const e0 = Math.max(snapT(end), s0 + 0.02)
    setSlices((prev) => withIds(renumber([...prev, { start: s0, end: e0 }]), source))
  }, [snapT, source, setSlices])

  const onSelect = useCallback((sid, { play } = {}) => {
    setSelectedId(sid)
    if (play) playSlice(slices.find((s) => s.id === sid))
  }, [slices, playSlice])

  const deleteSlice = useCallback((sid) => setSlices((prev) => renumber(prev.filter((s) => s.id !== sid))), [setSlices])

  const downloadSlice = useCallback(async (s) => {
    try {
      const res = await host.download({
        path: `/tracks/${id}/export`,
        filename: buildFilename(track.title, analysis.bpm, analysis.key, s.name),
        body: { ...options, slices: [toApiSlice(s)], format: 'wav' },
      })
      notify(`Saved ${res.path.split(/[\\/]/).pop()}`, 'success', { label: 'Show in folder', run: () => host.showItemInFolder(res.path) })
    } catch (e) {
      notify(e.message, 'error')
    }
  }, [host, id, track, analysis, options, notify])

  const stableOptions = useMemo(() => options, [options])

  if (loadError) return <div className="banner banner-error" data-testid="editor-error">Could not open track: {loadError} <Link to="/">Back</Link></div>
  if (!track || !analysis) return <div className="muted pad-24">Loading…</div>

  return (
    <div className="editor" data-testid="editor">
      <div className="editor-head">
        <Link to="/" className="btn btn-small" data-testid="back-to-library">← Library</Link>
        <h1 className="editor-title" data-testid="editor-title">{track.title}{source !== 'mix' && <span className="badge">stem: {source}</span>}</h1>
        <BpmControls analysis={analysis} onApply={regrid} busy={busy} />
        <span className="key-display" data-testid="editor-key" title={`Camelot ${analysis.camelot ?? ''}`}>{analysis.key ?? '—'}</span>
        <div className="downbeat-ctl" title="Shift the downbeat (bar 1)">
          <button className="btn btn-small" onClick={() => regrid({ downbeat: shiftDownbeat(analysis.downbeat, analysis.bpm, -1) })} disabled={busy} data-testid="downbeat-left">◀</button>
          <span className="muted small">Downbeat</span>
          <button className="btn btn-small" onClick={() => regrid({ downbeat: shiftDownbeat(analysis.downbeat, analysis.bpm, 1) })} disabled={busy} data-testid="downbeat-right">▶</button>
        </div>
        <Link to={`/track/${id}/stems`} className="btn" data-testid="open-stems">Stems ›</Link>
      </div>

      {!buffer ? <div className="waveform-loading">Decoding audio…</div> : (
        <Waveform ref={wave} audioBuffer={buffer} url={blobUrl} bpm={analysis.bpm} downbeat={analysis.downbeat}
          slices={slices} selectedId={selectedId} loop={loop} dragSelect={chop.mode === 'manual'}
          onSliceChange={onRegionChange} onSelect={onSelect} onCreate={onRegionCreate}
          onLoopChange={(r) => setLoop((l) => ({ ...l, start: snapT(r.start), end: snapT(r.end) }))}
          onTime={onTime} onPlayState={setPlaying} zoom={zoom} follow={follow} />
      )}

      <div className="transport">
        <button className="btn btn-play" onClick={() => wave.current?.playPause()} data-testid="play-toggle">
          {playing ? '❚❚ Pause' : '▶ Play'} <kbd>Space</kbd>
        </button>
        <button className={`btn ${loop.active ? 'btn-on' : ''}`} onClick={toggleLoop} data-testid="loop-toggle">⟳ Loop <kbd>L</kbd></button>
        <Playhead subscribe={subscribeTime} duration={duration} />
        <label className="slider-label">Zoom
          <input type="range" min="0" max="800" step="10" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} data-testid="zoom" />
          <span className="zoom-value">{zoom === 0 ? 'Fit' : `${zoom} px/s`}</span>
        </label>
        <label className="chk" title="When zoomed in, keep the playhead in view by scrolling the waveform">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="follow-toggle" />Follow playhead
        </label>
        <span className="muted small slice-count" data-testid="slice-count">{slices.length} slices</span>
      </div>

      <ChopControls chop={chop} setChop={setChop} onChop={() => doChop()} busy={busy} />

      <div className="editor-body">
        <PadGrid slices={slices} bank={bank} setBank={setBank} activePads={activePads} selectedId={selectedId}
          onTrigger={triggerPad} trackId={id} options={stableOptions} />
        <div className="editor-side">
          <ExportPanel track={track} slices={slices} options={options} setOptions={setOptions} />
          <div className="panel slices-panel">
            <div className="panel-title">Slices <span className="muted small">drag ⠿ into your DAW</span></div>
            <div className="slice-list" data-testid="slice-list">
              {slices.map((s, i) => (
                <SliceRow key={s.id} slice={s} index={i} selected={s.id === selectedId} onSelect={setSelectedId}
                  onChange={updateSlice} onPlay={playSlice} onDelete={deleteSlice} onDownload={downloadSlice}
                  trackId={id} options={stableOptions} />
              ))}
              {slices.length === 0 && <div className="muted">No slices — choose a mode and hit Chop.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
