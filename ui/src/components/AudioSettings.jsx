import { useEffect, useState } from 'react'
import { useApp } from '../context.js'

const BUFFERS = [['interactive', 'Lowest (automatic)'], ['128', '128 samples'], ['256', '256 samples'], ['512', '512 samples'], ['1024', '1024 samples']]
const ms = (v) => `${v.toFixed(1)} ms`

/** Audio settings: output device, buffer size, latency (reported + measured). */
export default function AudioSettings({ onClose }) {
  const { host, notify } = useApp()
  const audio = host.audio
  const [devices, setDevices] = useState([])
  const [opts, setOpts] = useState(audio.options?.() ?? { buffer: 'interactive', sinkId: '' })
  const [info, setInfo] = useState(() => audio.info?.())
  const [measured, setMeasured] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { audio.devices?.().then(setDevices) }, [audio])
  useEffect(() => {
    const t = setInterval(() => setInfo(audio.info?.()), 500)
    return () => clearInterval(t)
  }, [audio])
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  const apply = async (patch) => {
    const next = { ...opts, ...patch }
    setOpts(next)
    setMeasured(null)
    try {
      await audio.setOptions(patch)
      host.setSetting('audio', next).catch(() => {})
      setInfo(audio.info?.())
    } catch (e) {
      notify(`Audio output: ${e.message}`, 'error')
    }
  }
  const measure = async () => {
    const p = window.__ripperTest?.player
    if (!p) return notify('Open a track first: the latency is measured through the pad engine.', 'info')
    setBusy(true)
    try { setMeasured(await p.measureLatency()) } finally { setBusy(false) }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal audio-settings" data-testid="audio-settings" role="dialog" aria-label="Audio settings">
        <div className="modal-head"><b>Audio</b><span className="muted small">changes apply right away</span>
          <button className="btn btn-small" onClick={onClose} data-testid="audio-close" title="Close (Esc)">Done</button></div>
        <label className="num" title="Where the pads, sequencer and previews play">Output
          <select className="input" value={opts.sinkId} onChange={(e) => apply({ sinkId: e.target.value })} data-testid="audio-device">
            <option value="">System default</option>
            {devices.filter((d) => d.id).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        <label className="num" title="Smaller buffers = less latency, more CPU (and a risk of crackles on slow machines)">Buffer
          <select className="input" value={String(opts.buffer)} onChange={(e) => apply({ buffer: e.target.value })} data-testid="audio-buffer">
            {BUFFERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {info && (
          <div className="latency" data-testid="audio-latency" data-total={info.total.toFixed(2)}>
            <span>{info.sampleRate} Hz</span>
            <span title="The browser engine's processing latency">base {ms(info.base)}</span>
            <span title="Reported by the audio device">output {ms(info.output)}</span>
            <b className={info.total < 10 ? 'ok' : 'warn'}>= {ms(info.total)}</b>
            <span className="muted small">target: under 10 ms</span>
          </div>
        )}
        <div className="latency">
          <button className="btn btn-small" onClick={measure} disabled={busy} data-testid="audio-measure"
            title="Hit the pad engine 12 times and time it: trigger → audio thread + one buffer + base + output latency">{busy ? 'Measuring…' : 'Measure pad latency'}</button>
          {measured && <b data-testid="audio-measured" data-ms={measured.total.toFixed(2)} className={measured.total < 10 ? 'ok' : 'warn'}>
            {ms(measured.total)} <span className="muted small">(trigger {ms(measured.schedule)} + buffer {ms(measured.quantum)} + base {ms(measured.base)} + output {ms(measured.output)})</span></b>}
        </div>
      </div>
    </div>
  )
}
