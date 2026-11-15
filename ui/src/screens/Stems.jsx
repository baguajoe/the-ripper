import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { useApp } from '../context.js'
import { usePollJob } from '../hooks/usePollJob.js'
import { useNativeDrag } from '../hooks/useNativeDrag.js'
import { dragSpec, DEFAULT_EXPORT } from '../lib/exportSpec.js'
import { buildFilename } from '../lib/filenames.js'
import { formatBytes, formatDurationLong, formatTime } from '../lib/format.js'

const DEVICE_LABEL = { cuda: 'NVIDIA GPU', mps: 'Apple Silicon GPU', cpu: 'CPU' }

function StemStrip({ name, state, setState, anySolo, trackId, onDownload, onSend, onAudition }) {
  const getSpec = useCallback(() => dragSpec(trackId, 'stem', { stems: [name], options: DEFAULT_EXPORT }), [trackId, name])
  const drag = useNativeDrag(getSpec)
  const audible = !state.mute && (!anySolo || state.solo)
  return (
    <div className={`stem-strip ${audible ? '' : 'stem-muted'}`} data-testid={`stem-${name}`}>
      <span className="drag-handle" title="Drag this stem into your DAW" data-testid={`stem-drag-${name}`} {...drag}>⠿</span>
      <button className={`stem-name ${state.solo && anySolo ? 'stem-name-solo' : ''}`} onClick={() => onAudition(name)}
        title="Click to hear this stem on its own (click again for all)" data-testid={`stem-name-${name}`}>{name}</button>
      <button className={`btn btn-small ${state.solo ? 'btn-on' : ''}`} onClick={() => setState({ solo: !state.solo })} data-testid={`stem-solo-${name}`} title={`Solo ${name}`}>S</button>
      <button className={`btn btn-small ${state.mute ? 'btn-warn' : ''}`} onClick={() => setState({ mute: !state.mute })} data-testid={`stem-mute-${name}`} title={`Mute ${name}`}>M</button>
      <input type="range" min="0" max="1.5" step="0.01" value={state.volume} onChange={(e) => setState({ volume: Number(e.target.value) })}
        data-testid={`stem-volume-${name}`} title={`${name} volume`} aria-label={`${name} volume`} />
      <button className="btn btn-small" onClick={() => onDownload(name)} data-testid={`stem-download-${name}`} title={`Save the ${name} stem as a WAV`}>⤓ WAV</button>
      <button className="btn btn-small" onClick={() => onSend(name)} data-testid={`stem-send-${name}`} title={`Open the ${name} stem in the editor to chop it`}>Send to Chop Editor</button>
    </div>
  )
}

/** The HQ (AI) add-on: size up front, one-click download with progress, resume, remove. */
function AddonPanel({ addon, job, onInstall, onRemove, busy }) {
  if (!addon) return <div className="muted small" data-testid="addon-card">Checking the HQ (AI) add-on…</div>
  if (!addon.supported) return <div className="hint" data-testid="addon-card">{addon.reason}</div>
  const running = job && (job.status === 'queued' || job.status === 'running')
  if (addon.installed && !running) {
    const info = addon.info || {}
    return (
      <div className="addon-card addon-installed" data-testid="addon-card" data-state="installed">
        <span className="muted small">HQ (AI) add-on installed · {addon.variant_label} build{info.disk_bytes ? ` · ${formatBytes(info.disk_bytes)} on disk` : ''}</span>
        <button className="btn btn-small btn-ghost" onClick={onRemove} disabled={busy} data-testid="addon-remove" title="Remove the HQ (AI) add-on">Remove</button>
      </div>
    )
  }
  return (
    <div className="addon-card" data-testid="addon-card" data-state={running ? 'downloading' : 'available'}>
      <div><strong>Get HQ (AI) stems</strong> <span className="badge badge-free">FREE</span></div>
      <div className="muted small">
        Separates vocals, drums, bass and more with Demucs. A one-time download for your computer
        ({addon.variant_label}{addon.variant === 'win-cuda' ? ' — uses your graphics card' : ''}).
      </div>
      {addon.manifest_error && !running ? (
        <div className="hint" data-testid="addon-error">{addon.manifest_error}</div>
      ) : (
        <div className="small" data-testid="addon-size">
          Download: <strong>{formatBytes(addon.download_bytes)}</strong>{addon.disk_bytes ? ` · needs ${formatBytes(addon.disk_bytes)} of disk space` : ''}
        </div>
      )}
      {running ? (
        <div className="job-progress" data-testid="addon-progress">
          <div className="progress"><div className="progress-bar" style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div>
          <span className="muted small">{job.message}</span>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-primary" onClick={onInstall} disabled={busy || (!!addon.manifest_error && !addon.download_bytes)} data-testid="addon-get" title="Download and install the HQ (AI) add-on">
            {job?.status === 'error' ? 'Resume download' : 'Get HQ (AI) stems'}
          </button>
          {job?.status === 'error' && <span className="error-text small" data-testid="addon-error">{job.error}</span>}
        </div>
      )}
    </div>
  )
}

export default function Stems() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { host, health, notify, refreshHealth } = useApp()
  const [track, setTrack] = useState(null)
  const [engine, setEngine] = useState(null)
  const [model, setModel] = useState('htdemucs')
  const [fastModel, setFastModel] = useState('dsp')
  const [jobId, setJobId] = useState(null)
  const [addon, setAddon] = useState(null)
  const [addonJobId, setAddonJobId] = useState(null)
  const [addonBusy, setAddonBusy] = useState(false)
  const [estimate, setEstimate] = useState(null)
  const [decoded, setDecoded] = useState({ key: '', buffers: {} })
  const [mix, setMix] = useState({})
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const voices = useRef([])
  const gains = useRef({})
  const clock = useRef({ startedAt: 0, offset: 0, raf: 0 })

  const aiAvailable = health?.demucs_available
  const f = health?.features ?? {}
  const effectiveEngine = engine ?? (aiAvailable && f.stems_ai !== false ? 'ai' : 'dsp')

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

  // add-on status (size up front); re-attach to a download that is still running
  const applyAddon = useCallback((a) => {
    setAddon(a)
    if (a.job && (a.job.status === 'queued' || a.job.status === 'running')) setAddonJobId(a.job.id)
    return a
  }, [])
  const loadAddon = useCallback(() => api.aiAddon().then(applyAddon)
    .catch((e) => { setAddon({ supported: true, manifest_error: e.message }); return null }), [applyAddon])
  useEffect(() => {
    let alive = true
    api.aiAddon().then((a) => alive && applyAddon(a))
      .catch((e) => alive && setAddon({ supported: true, manifest_error: e.message }))
    return () => { alive = false }
  }, [applyAddon])

  const addonJob = usePollJob(addonJobId, {
    onDone: async () => {
      setAddonJobId(null)
      await loadAddon()
      const h = await refreshHealth()
      if (h?.demucs_available) {
        setEngine('ai')
        notify('HQ (AI) stems are ready', 'success')
      } else notify(`The add-on installed but the AI engine didn't start: ${h?.demucs_reason || 'unknown error'}`, 'error')
    },
    onError: (j) => { setAddonJobId(null); setFailedAddonJob(j); loadAddon() },
  })
  const [failedAddonJob, setFailedAddonJob] = useState(null)

  const installAddon = async () => {
    setAddonBusy(true)
    try {
      const r = await api.installAiAddon()
      setFailedAddonJob(null)
      setAddonJobId(r.job_id)
    } catch (e) {
      notify(e.message, 'error')
    } finally {
      setAddonBusy(false)
    }
  }

  const removeAddon = async () => {
    setAddonBusy(true)
    try {
      await api.removeAiAddon()
      setEngine('dsp')
      await loadAddon()
      await refreshHealth()
      notify('HQ (AI) add-on removed', 'success')
    } catch (e) {
      notify(e.message, 'error')
    } finally {
      setAddonBusy(false)
    }
  }

  // estimated processing time, before separating
  useEffect(() => {
    if (!track) return undefined
    let alive = true
    const m = effectiveEngine === 'ai' ? model : fastModel
    if (effectiveEngine === 'ai' && !aiAvailable) return undefined
    api.stemsEstimate(id, effectiveEngine, m).then((e) => alive && setEstimate({ ...e, key: `${effectiveEngine}:${m}` })).catch(() => {})
    return () => { alive = false }
  }, [id, track, effectiveEngine, model, fastModel, aiAvailable])

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

  /** Click a stem name: hear it alone (click again: everything). */
  const audition = (name) => {
    const alone = mix[name]?.solo && Object.entries(mix).every(([n, m]) => n === name || !m.solo)
    setMix((m) => Object.fromEntries(Object.entries(m).map(([n, s]) => [n, { ...s, solo: alone ? false : n === name, mute: n === name ? false : s.mute }])))
    if (!alone && !playing && ready) play()
  }

  const job = usePollJob(jobId, {
    onDone: () => { setJobId(null); stop(); load(); notify('Stems ready', 'success') },
    onError: (j) => { setJobId(null); notify(`Stem separation failed: ${j.error}`, 'error') },
  })

  const run = async () => {
    try {
      const r = await api.startStems(id, effectiveEngine, effectiveEngine === 'ai' ? model : fastModel)
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
  const est = estimate && estimate.key === `${effectiveEngine}:${effectiveEngine === 'ai' ? model : fastModel}` ? estimate : null
  const deviceText = health?.gpu || DEVICE_LABEL[health?.device] || health?.device
  const shownJob = addonJob || failedAddonJob

  return (
    <div className="stems" data-testid="stems-screen">
      <div className="editor-head">
        <Link to={`/track/${id}`} className="btn btn-small" data-testid="back-to-editor">← Editor</Link>
        <h1 className="editor-title">{track.title} — Stems</h1>
      </div>

      <div className="panel">
        <div className="panel-title">Separate</div>
        <div className="stem-engines">
          <label className={`engine-opt ${effectiveEngine === 'ai' ? 'engine-on' : ''} ${aiAvailable ? '' : 'engine-locked'}`}>
            <input type="radio" name="engine" checked={effectiveEngine === 'ai'} onChange={() => setEngine('ai')} disabled={!aiAvailable} data-testid="engine-ai" title="HQ (AI) stems: best quality, slower" />
            <div>
              <strong>HQ (AI)</strong> <span className="badge badge-free">FREE</span>
              {aiAvailable ? (
                <>
                  <div className="muted small">Demucs 4.1 · runs on: <span data-testid="ai-device">{deviceText}</span></div>
                  <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={effectiveEngine !== 'ai'} data-testid="ai-model" title="Which AI model / how many stems">
                    {Object.entries(health.models).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </>
              ) : (
                <div className="muted small">{aiAvailable === null ? 'Checking…' : 'Vocals, drums, bass, other (+ guitar, piano) with Demucs'}</div>
              )}
            </div>
          </label>
          <label className={`engine-opt ${effectiveEngine === 'dsp' ? 'engine-on' : ''}`}>
            <input type="radio" name="engine" checked={effectiveEngine === 'dsp'} onChange={() => setEngine('dsp')} data-testid="engine-dsp" title="Fast stems: instant, no AI" />
            <div>
              <strong>Fast (no AI)</strong>
              <div className="muted small">Seconds. For vocals use HQ (AI).</div>
              <select className="input" value={fastModel} onChange={(e) => setFastModel(e.target.value)} disabled={effectiveEngine !== 'dsp'} data-testid="fast-model" title="Which fast split">
                <option value="dsp">Drums / Bass / Music</option>
                <option value="center_cancel">Instrumental (center cancel)</option>
              </select>
            </div>
          </label>
        </div>
        {(!aiAvailable || addon?.installed) && aiAvailable !== null && (
          <AddonPanel addon={addon} job={shownJob} onInstall={installAddon} onRemove={removeAddon} busy={addonBusy || !!jobId} />
        )}
        <div className="row">
          <button className="btn btn-primary" onClick={run} disabled={!!jobId} data-testid="stems-run" title="Separate the stems">
            {jobId ? 'Separating…' : stems ? 'Re-run separation' : 'Separate stems'}
          </button>
          {!jobId && est && (
            <span className="muted small" data-testid="stems-estimate">
              Estimated time: ~{formatDurationLong(est.seconds)}{effectiveEngine === 'ai' ? ` on ${DEVICE_LABEL[est.device] || est.device}` : ''}
            </span>
          )}
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
            Mixer <span className="muted small" data-testid="stems-label">{stems.label} · {DEVICE_LABEL[stems.device] || stems.device}</span>
            <span className="muted small"> · click a stem's name to hear it alone</span>
          </div>
          <div className="transport">
            <button className="btn" onClick={playing ? stop : play} disabled={!ready} data-testid="stems-play" title="Play / pause the stems">{playing ? '■ Stop' : '▶ Play'}</button>
            <span className="time">{formatTime(pos)} / {formatTime(track.duration)}</span>
            <input type="range" min="0" max={track.duration} step="0.01" value={pos} onChange={(e) => { stop(); setPos(Number(e.target.value)) }} className="seek" aria-label="Position" data-testid="stems-seek" title="Position in the track" />
          </div>
          {!ready && <div className="muted small">Loading stems…</div>}
          {stems.names.map((n) => (
            <StemStrip key={n} name={n} state={mix[n] ?? { solo: false, mute: false, volume: 1 }} anySolo={anySolo}
              setState={(patch) => setMix((m) => ({ ...m, [n]: { ...(m[n] ?? { solo: false, mute: false, volume: 1 }), ...patch } }))}
              trackId={id} onDownload={download} onAudition={audition}
              onSend={(name) => navigate(`/track/${id}?source=${encodeURIComponent(name)}`)} />
          ))}
        </div>
      )}
    </div>
  )
}
