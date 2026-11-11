import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../context.js'
import { useNativeDrag } from '../hooks/useNativeDrag.js'
import { dragSpec, toApiSlice } from '../lib/exportSpec.js'
import { baseName } from '../lib/filenames.js'

function ProTag({ allowed }) {
  return allowed ? null : <span className="badge badge-pro-lock" title="Pro feature">PRO</span>
}

export default function ExportPanel({ track, slices, options, setOptions }) {
  const { host, health, notify } = useApp()
  const [busy, setBusy] = useState(null)
  const [folder, setFolder] = useState(null)
  useEffect(() => {
    let alive = true
    host.getSetting('exportFolder').then((f) => alive && setFolder(f)).catch(() => {})
    return () => { alive = false }
  }, [host])
  const changeFolder = async () => {
    const f = await host.pickFolder().catch((e) => { notify(e.message, 'error'); return null })
    if (f) setFolder(f)
  }
  const f = health?.features ?? {}
  const a = track.analysis
  const set = (patch) => setOptions({ ...options, ...patch })

  const kitSpec = useCallback(() => (slices.length ? dragSpec(track.id, 'kit', { slices, options }) : null), [track.id, slices, options])
  const midiSpec = useCallback(() => (slices.length ? dragSpec(track.id, 'midi', { slices, options }) : null), [track.id, slices, options])
  const kitDrag = useNativeDrag(kitSpec)
  const midiDrag = useNativeDrag(midiSpec)

  const saved = (res) => notify(`Saved ${res.path.split(/[\\/]/).pop()}`, 'success', {
    label: 'Show in folder', run: () => host.showItemInFolder(res.path),
  })

  const exportKit = async () => {
    setBusy('kit')
    try {
      const res = await host.download({
        path: `/tracks/${track.id}/export`,
        filename: `${baseName(track.title, a.bpm, a.key)}_Kit.zip`,
        body: { ...options, slices: slices.map(toApiSlice), include_stems: true, include_midi: true },
      })
      saved(res)
    } catch (e) {
      notify(`Export failed: ${e.message}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const toFolder = async (kind) => {
    setBusy(kind)
    try {
      const res = await host.exportToFolder({
        trackId: track.id, kind, slices: slices.map(toApiSlice), options,
        subfolder: `${baseName(track.title, a.bpm, a.key)}${kind === 'kit' ? '_Kit' : '_Slices'}`,
      })
      if (res) setFolder(res.folder)
      if (res) notify(`Exported ${res.files.length} file(s)`, 'success', { label: 'Show in folder', run: () => host.showItemInFolder(res.files[0]) })
    } catch (e) {
      notify(`Export failed: ${e.message}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const none = slices.length === 0
  return (
    <div className="panel export-panel" data-testid="export-panel">
      <div className="panel-title">Export to DAW</div>
      <div className="export-options">
        <div className="seg">
          {['oneshot', 'loop'].map((m) => (
            <button key={m} className={`seg-btn ${options.mode === m ? 'seg-on' : ''}`} onClick={() => set({ mode: m })} data-testid={`export-mode-${m}`}>
              {m === 'oneshot' ? 'One-shots' : 'Bar loops'}
            </button>
          ))}
        </div>
        <select className="input" value={options.sr} onChange={(e) => set({ sr: Number(e.target.value) })} data-testid="export-sr">
          <option value={44100}>44.1 kHz</option>
          <option value={48000}>48 kHz</option>
        </select>
        <span className="muted small">24-bit WAV · tempo tag</span>
        <label className="chk"><input type="checkbox" checked={options.normalize} onChange={(e) => set({ normalize: e.target.checked })} data-testid="export-normalize" />Normalize</label>
        <label className="chk" title={options.mode === 'loop' ? 'Not applied to tempo-locked loops' : ''}>
          <input type="checkbox" checked={options.trim_silence} disabled={options.mode === 'loop'} onChange={(e) => set({ trim_silence: e.target.checked })} data-testid="export-trim" />Trim silence
        </label>
      </div>
      <div className="export-actions">
        <button className="btn btn-primary" onClick={exportKit} disabled={none || !!busy || f.export_kit === false} data-testid="export-kit">
          {busy === 'kit' ? 'Exporting…' : 'Export Kit (.zip)'} <ProTag allowed={f.export_kit !== false} />
        </button>
        {host.capabilities.folders && (
          <>
            <button className="btn" onClick={() => toFolder('slices')} disabled={none || !!busy || f.batch_export === false} data-testid="export-folder">
              Slices → folder… <ProTag allowed={f.batch_export !== false} />
            </button>
            <button className="btn" onClick={() => toFolder('kit')} disabled={none || !!busy || f.export_kit === false} data-testid="export-kit-folder">
              Kit → folder… <ProTag allowed={f.export_kit !== false} />
            </button>
            <button className="btn btn-small" onClick={changeFolder} title={folder || 'No folder chosen yet'} data-testid="export-folder-pick">
              📁 {folder ? folder.split(/[\\/]/).filter(Boolean).pop() : 'Choose folder'}
            </button>
          </>
        )}
        {host.capabilities.nativeDrag && (
          <div className="drag-chips">
            <span className={`chip ${none || f.export_kit === false ? 'chip-disabled' : ''}`} data-testid="drag-kit" title="Drag the whole kit (slices + stems + MIDI) into your DAW"
              {...(none || f.export_kit === false ? {} : kitDrag)}>⠿ KIT</span>
            <span className={`chip ${none || f.export_kit === false ? 'chip-disabled' : ''}`} data-testid="drag-midi" title="Drag the slice-map MIDI into your piano roll"
              {...(none || f.export_kit === false ? {} : midiDrag)}>⠿ MIDI</span>
          </div>
        )}
      </div>
      <div className="muted small">Kit = all slices + stems (runs Fast stems if none yet) + MIDI (one note per slice from C1, original timing).</div>
    </div>
  )
}
