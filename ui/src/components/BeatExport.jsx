import { useCallback, useRef, useState } from 'react'
import { useApp } from '../context.js'
import { useNativeDrag } from '../hooks/useNativeDrag.js'
import { beatParts, passLabel } from '../lib/beatExport.js'
import { passEvents } from '../lib/sequence.js'
import { baseName } from '../lib/filenames.js'

const KINDS = {
  beat: { label: 'Beat WAV', chip: 'WAV', what: { beat: true }, file: (b, l) => `${b}_beat_${l}.wav`, title: 'The whole pattern / song as one WAV (with the master bus if ticked)' },
  midi: { label: 'MIDI', chip: 'MIDI', what: { midi: true }, file: (b, l) => `${b}_pattern_${l}.mid`, title: 'The pattern / song as MIDI: one note per pad from C1, velocity + swing applied' },
  stems: { label: 'Pad stems', chip: 'STEMS', what: { stems: true }, file: (b) => `${b}_Pad-stems.zip`, title: 'One WAV per used pad, all from bar 1 and the same length: one DAW track per pad, already in time' },
  chops: { label: 'Chops in place', chip: 'CHOPS', what: { chops: true }, file: (b) => `${b}_Chops-in-place.zip`, title: 'One WAV per chop, each only that chop at its original position (silence elsewhere), all the same length' },
}

function DragChip({ kind, getSpec, disabled }) {
  const drag = useNativeDrag(getSpec)
  return (
    <span className={`chip ${disabled ? 'chip-disabled' : ''}`} data-testid={`drag-beat-${kind}`} title={`Drag ${KINDS[kind].label} into your DAW`}
      {...(disabled ? {} : drag)}>⠿ {KINDS[kind].chip}</span>
  )
}

/**
 * Export the beat: WAV, MIDI, per-pad stems, chops in original position. As a download, into a
 * folder, or dragged into the DAW (several files in one drag).
 * ctx(): the render context (lib/beatExport.js beatParts) for the current state.
 */
export default function BeatExport({ track, options, seq, opts, setOpts, ctx, hasSelection }) {
  const { host, health, notify } = useApp()
  const [busy, setBusy] = useState(null)
  const cache = useRef(new Map()) // inputs -> Promise(parts)
  const f = health?.features ?? {}
  const a = track.analysis
  const base = baseName(track.title, a.bpm, a.key)
  const label = passLabel(seq)
  const multi = (k) => k === 'stems' || k === 'chops'
  const empty = passEvents(seq).events.length === 0
  const allowed = (k) => (multi(k) ? f.batch_export !== false : true) && (k === 'chops' || !empty)

  const parts = useCallback((k) => {
    const c = ctx()
    const key = JSON.stringify([k, c.key])
    if (!cache.current.has(key)) {
      const p = beatParts(KINDS[k].what, c)
      p.catch(() => cache.current.delete(key))
      cache.current.set(key, p)
      if (cache.current.size > 24) cache.current.delete(cache.current.keys().next().value)
    }
    return { key, promise: cache.current.get(key) }
  }, [ctx])

  const run = async (k, where) => {
    setBusy(`${k}:${where}`)
    try {
      const p = await parts(k).promise
      if (where === 'folder') {
        const res = await host.exportToFolder({ trackId: track.id, kind: 'beat', slices: [], options, subfolder: `${base}_${k === 'chops' ? 'Chops-in-place' : k === 'stems' ? 'Pad-stems' : `Beat-${label}`}`, ...p })
        if (res) notify(`Exported ${res.files.length} file(s)`, 'success', { label: 'Show in folder', run: () => host.showItemInFolder(res.files[0]) })
      } else {
        const res = await host.download({ path: `/tracks/${track.id}/export`, filename: KINDS[k].file(base, label),
          body: { ...options, ...p, ...(multi(k) ? {} : { format: 'wav' }) } })
        notify(`Saved ${res.path.split(/[\\/]/).pop()}`, 'success', { label: 'Show in folder', run: () => host.showItemInFolder(res.path) })
      }
    } catch (e) {
      notify(`Export failed: ${e.message}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  // drag: the files render on hover (useNativeDrag waits for `pending`), then one multi-file drag
  const resolved = useRef(new Map())
  const getSpec = (k) => () => {
    if (!allowed(k)) return null
    const { key, promise } = parts(k)
    const done = resolved.current.get(key)
    const spec = { trackId: track.id, kind: 'beat', slices: [], stems: [], options, ...(done || {}) }
    if (!done) {
      Object.defineProperty(spec, 'pending', {
        value: () => promise.then((p) => { resolved.current.set(key, p); return p }), enumerable: false,
      })
    }
    return spec
  }

  return (
    <div className="beat-export" data-testid="beat-export">
      <div className="panel-title">Export the beat <span className="muted small">pattern {label} · {Math.round(a.bpm * 10) / 10} BPM</span></div>
      <div className="seq-row">
        <label className="chk" title="Pads play through their own effects"><input type="checkbox" checked={opts.fx} onChange={(e) => setOpts({ fx: e.target.checked })} data-testid="beat-fx" />Include effects</label>
        <label className="chk" title="Through the master bus (effects + compressor). Pad stems without it sum exactly to the beat."><input type="checkbox" checked={opts.master} onChange={(e) => setOpts({ master: e.target.checked })} data-testid="beat-master" />Include master bus</label>
        <label className="num" title="Chops in place: the selection or the whole song">Range
          <select className="input input-small" value={opts.range} onChange={(e) => setOpts({ range: e.target.value })} data-testid="beat-range">
            <option value="selection" disabled={!hasSelection}>Current selection</option>
            <option value="song">Whole song</option>
          </select>
        </label>
        <label className="num" title="Chops in place: which chops">Chops
          <select className="input input-small" value={opts.scope} onChange={(e) => setOpts({ scope: e.target.value })} data-testid="beat-scope">
            <option value="bank">Current bank</option>
            <option value="selected">Selected slice</option>
            <option value="all">All banks</option>
          </select>
        </label>
      </div>
      <div className="beat-grid">
        {Object.entries(KINDS).map(([k, v]) => (
          <div key={k} className="beat-row" title={v.title}>
            <span className="beat-name">{v.label}{multi(k) && f.batch_export === false && <span className="badge badge-pro-lock">PRO</span>}</span>
            <button className="btn btn-small" onClick={() => run(k, 'download')} disabled={!!busy || !allowed(k)} data-testid={`beat-${k}-save`} title={`Save ${v.label}`}>
              {busy === `${k}:download` ? '…' : 'Save'}</button>
            {host.capabilities.folders && (
              <button className="btn btn-small" onClick={() => run(k, 'folder')} disabled={!!busy || !allowed(k)} data-testid={`beat-${k}-folder`} title={`${v.label} into your export folder`}>
                {busy === `${k}:folder` ? '…' : '→ folder'}</button>
            )}
            {host.capabilities.nativeDrag && <DragChip kind={k} getSpec={getSpec(k)} disabled={!allowed(k)} />}
          </div>
        ))}
      </div>
    </div>
  )
}
