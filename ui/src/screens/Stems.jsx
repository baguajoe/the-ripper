import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { useApp } from '../context.js'
import { usePollJob } from '../hooks/usePollJob.js'
import { useNativeDrag } from '../hooks/useNativeDrag.js'
import { dragSpec, DEFAULT_EXPORT } from '../lib/exportSpec.js'
import { buildFilename } from '../lib/filenames.js'
import { formatTime } from '../lib/format.js'

function StemStrip({ name, state, setState, anySolo, trackId, onDownload, onSend }) {
  const getSpec = useCallback(() => dragSpec(trackId, 'stem', { stems: [name], options: DEFAULT_EXPORT }), [trackId, name])
  const drag = useNativeDrag(getSpec)
  const audible = !state.mute && (!anySolo || state.solo)
  return (
    <div className={`stem-strip ${audible ? '' : 'stem-muted'}`} data-testid={`stem-${name}`}>
      <span className="drag-handle" title="Drag this stem into your DAW" data-testid={`stem-drag-${name}`} {...drag}>⠿</span>
      <span className="stem-name">{name}</span>
      <button className={`btn btn-small ${state.solo ? 'btn-on' : ''}`} onClick={() => setState({ solo: !state.solo })} data-testid={`stem-solo-${name}`}>S</button>
      <button className={`btn btn-small ${state.mute ? 'btn-warn' : ''}`} onClick={() => setState({ mute: !state.mute })} data-testid={`stem-mute-${name}`}>M</button>
      <input type="range" min="0" max="1.5" step="0.01" value={state.volume} onChange={(e) => setState({ volume: Number(e.target.value) })}
        data-testid={`stem-volume-${name}`} aria-label={`${name} volume`} />
      <button className="btn btn-small" onClick={() => onDownload(name)} data-testid={`stem-download-${name}`}>⤓ WAV</button>
      <button className="btn btn-small" onClick={() => onSend(name)} data-testid={`stem-send-${name}`}>Send to Chop Editor</button>
    </div>
  )
}

export default function Stems() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { host, health, notify } = useApp()
  const [track, setTrack] = useState(null)
  const [engine, setEngine] = useState(null)
  const [model, setModel] = useState('htdemucs')
  const [jobId, setJobId] = useState(null)
  const [decoded, setDecoded] = useState({ key: '', buffers: {} })
  const [mix, setMix] = useState({})
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const voices = useRef([])
  const gains = useRef({})
  const clock = useRef({ startedAt: 0, offset: 0, raf: 0 })

  const aiAvailable = health?.demucs_available
  const f = health?.features ?? {}
  const effectiveEngine = engine ?? (aiAvailable && f.stems_ai ? 'ai' : 'dsp')

  const load = useCallback(async () => {
    const t = await api.getTrack(id)
    setTrack(t)
    return t
  }, [id])

  useEffect(() => {
    let alive = true
    api.getTrack(id).then((t) => alive && setTrack(t)).catch((e) => alive && notify(e.message, 'error'))
    return () => { alive = false }
  }, [id, notify])

  const stop = useCallback(() => {
    for (const v of voices.current) { try { v.stop() } catch { /* stopped */ } }
    voices.current = []
    cancelAnimationFrame(clock.current.raf)
    setPlaying(false)
  }, [])

  // decode the current stem set (buffers are tagged with the set they belong to)
  const stemKey = track?.stems ? `${track.stems.engine}:${track.stems.model}:${track.stems.names.join(',')}` : ''
  const buffers = decoded.key === stemKey ? decoded.buffers : {}
  useEffect(() => {
    if (!track?.stems) return undefined
    let alive = true
    const names = track.stems.names
    const ctx = host.audio.getContext()
    ;(async () => {
      const out = {}
      for (const name of names) {
        const bytes = await api.audioBytes(id, name)
        out[name] = await ctx.decodeAudioData(bytes)
        if (!alive) return
      }
      setDecoded({ key: stemKey, buffers: out })
      setMix((m) => Object.fromEntries(names.map((n) => [n, m[n] ?? { solo: false, mute: false, volume: 1 }])))
    })().catch((e) => alive && notify(`Could not load stems: ${e.message}`, 'error'))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- track.stems is captured by stemKey
  }, [stemKey, id, host, notify])

  useEffect(() => stop, [stop])

  // live gain updates
  const anySolo = Object.values(mix).some((m) => m.solo)
  useEffect(() => {
    for (const [name, g] of Object.entries(gains.current)) {
      const m = mix[name]
      if (!m) continue
      const audible = !m.mute && (!anySolo || m.solo)
      g.gain.setTargetAtTime(audible ? m.volume : 0, g.context.currentTime, 0.01)
    }
  }, [mix, anySolo])

  const play = () => {
    const ctx = host.audio.getContext()
    if (ctx.state !== 'running') ctx.resume()
    stop()
    const offset = pos >= (track?.duration ?? 0) - 0.05 ? 0 : pos
    const t0 = ctx.currentTime + 0.03
    gains.current = {}
    for (const [name, buf] of Object.entries(buffers)) {
      const src = ctx.createBufferSource()
      src.buffer = buf
      const g = ctx.createGain()
      const m = mix[name] ?? { volume: 1 }
      const audible = !m.mute && (!anySolo || m.solo)
      g.gain.value = audible ? m.volume : 0
      src.connect(g).connect(ctx.destination)
      src.start(t0, offset)
      voices.current.push(src)
      gains.current[name] = g
    }
    clock.current = { startedAt: t0, offset, raf: 0 }
    setPlaying(true)
    const tick = () => {
      const p = clock.current.offset + (ctx.currentTime - clock.current.startedAt)
      setPos(Math.max(0, p))
      if (p >= (track?.duration ?? 0)) { stop(); setPos(0); return }
      clock.current.raf = requestAnimationFrame(tick)
    }
    clock.current.raf = requestAnimationFrame(tick)
  }

  const job = usePollJob(jobId, {
    onDone: () => { setJobId(null); stop(); load(); notify('Stems ready', 'success') },
    onError: (j) => { setJobId(null); notify(`Stem separation failed: ${j.error}`, 'error') },
  })

  const run = async () => {
    try {
      const r = await api.startStems(id, effectiveEngine, effectiveEngine === 'ai' ? model : undefined)
      setJobId(r.job_id)
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  const download = async (name) => {
    try {
      const a = track.analysis
      const res = await host.download({
        path: `/tracks/${id}/export`, filename: buildFilename(track.title, a.bpm, a.key, name),
        body: { ...DEFAULT_EXPORT, stems: [name], format: 'wav' },
      })
      notify(`Saved ${res.path.split(/[\\/]/).pop()}`, 'success', { label: 'Show in folder', run: () => host.showItemInFolder(res.path) })
    } catch (e) {
      notify(e.message, 'error')
    }
  }

  if (!track) return <div className="muted pad-24">Loading…</div>
  const stems = track.stems
  const ready = stems && Object.keys(buffers).length === stems.names.length

  return (
    <div className="stems" data-testid="stems-screen">
      <div className="editor-head">
        <Link to={`/track/${id}`} className="btn btn-small" data-testid="back-to-editor">← Editor</Link>
        <h1 className="editor-title">{track.title} — Stems</h1>
      </div>

      <div className="panel">
        <div className="panel-title">Separate</div>
        <div className="stem-engines">
          {aiAvailable === true && (
            <label className={`engine-opt ${effectiveEngine === 'ai' ? 'engine-on' : ''}`}>
              <input type="radio" name="engine" checked={effectiveEngine === 'ai'} onChange={() => setEngine('ai')} disabled={!f.stems_ai} data-testid="engine-ai" />
              <div>
                <strong>HQ (AI)</strong> {!f.stems_ai && <span className="badge badge-pro-lock">PRO</span>}
                <div className="muted small">Demucs · device: <span data-testid="ai-device">{health.device}</span></div>
                <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={effectiveEngine !== 'ai'} data-testid="ai-model">
                  {Object.entries(health.models).map(([k, label]) => (
                    <option key={k} value={k} disabled={k === 'htdemucs_6s' && !f.stems_6}>{label}{k === 'htdemucs_6s' && !f.stems_6 ? ' (Pro)' : ''}</option>
                  ))}
                </select>
              </div>
            </label>
          )}
          <label className={`engine-opt ${effectiveEngine === 'dsp' ? 'engine-on' : ''}`}>
            <input type="radio" name="engine" checked={effectiveEngine === 'dsp'} onChange={() => setEngine('dsp')} data-testid="engine-dsp" />
            <div>
              <strong>Fast (DSP)</strong>
              <div className="muted small">Fast mode — expect bleed. Seconds, no AI.</div>
            </div>
          </label>
        </div>
        {aiAvailable === false && (
          <div className="hint" data-testid="ai-setup-hint">
            HQ (AI) stems need the optional AI pack: <code>pip install -r engine/requirements-ai.txt</code> then restart.
          </div>
        )}
        {aiAvailable === null && <div className="muted small">Checking for the AI engine…</div>}
        <div className="row">
          <button className="btn btn-primary" onClick={run} disabled={!!jobId} data-testid="stems-run">
            {jobId ? 'Separating…' : stems ? 'Re-run separation' : 'Separate stems'}
          </button>
          {job && (
            <div className="job-progress" data-testid="stems-progress">
              <div className="progress"><div className="progress-bar" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
              <span className="muted small">{job.message}</span>
            </div>
          )}
        </div>
      </div>

      {stems && (
        <div className="panel" data-testid="stem-mixer">
          <div className="panel-title">
            Mixer <span className="muted small" data-testid="stems-label">{stems.label} · {stems.device}</span>
          </div>
          <div className="transport">
            <button className="btn" onClick={playing ? stop : play} disabled={!ready} data-testid="stems-play">{playing ? '■ Stop' : '▶ Play'}</button>
            <span className="time">{formatTime(pos)} / {formatTime(track.duration)}</span>
            <input type="range" min="0" max={track.duration} step="0.01" value={pos} onChange={(e) => { stop(); setPos(Number(e.target.value)) }} className="seek" aria-label="Position" data-testid="stems-seek" />
          </div>
          {!ready && <div className="muted small">Loading stems…</div>}
          {stems.names.map((n) => (
            <StemStrip key={n} name={n} state={mix[n] ?? { solo: false, mute: false, volume: 1 }} anySolo={anySolo}
              setState={(patch) => setMix((m) => ({ ...m, [n]: { ...(m[n] ?? { solo: false, mute: false, volume: 1 }), ...patch } }))}
              trackId={id} onDownload={download} onSend={(name) => navigate(`/track/${id}?source=${encodeURIComponent(name)}`)} />
          ))}
        </div>
      )}
    </div>
  )
}
