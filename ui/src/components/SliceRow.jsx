import { useCallback } from 'react'
import { useNativeDrag } from '../hooks/useNativeDrag.js'
import { dragSpec } from '../lib/exportSpec.js'
import { formatTime } from '../lib/format.js'

export default function SliceRow({ slice, index, selected, onSelect, onChange, onPlay, onDelete, onDownload, trackId, options }) {
  const getSpec = useCallback(() => dragSpec(trackId, 'slice', { slices: [slice], options }), [slice, trackId, options])
  const drag = useNativeDrag(getSpec)
  const set = (patch) => onChange(slice.id, patch)
  return (
    <div className={`slice-row ${selected ? 'slice-row-selected' : ''}`} data-testid={`slice-row-${index}`} onClick={() => onSelect(slice.id)}>
      <span className="drag-handle" title="Drag this slice into your DAW" data-testid={`slice-drag-${index}`} {...drag}>⠿</span>
      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onPlay(slice) }} data-testid={`slice-play-${index}`} title="Play">▶</button>
      <span className="slice-idx">{index + 1}</span>
      <input className="input input-name" value={slice.name} onChange={(e) => set({ name: e.target.value })}
        onClick={(e) => e.stopPropagation()} data-testid={`slice-name-${index}`} aria-label="Slice name" />
      <span className="slice-time muted">{formatTime(slice.start)}–{formatTime(slice.end)}</span>
      <label className="chk" title="Reverse"><input type="checkbox" checked={!!slice.reverse} onChange={(e) => set({ reverse: e.target.checked })} data-testid={`slice-reverse-${index}`} />Rev</label>
      <label className="num" title="Gain (dB)">Gain
        <input type="number" className="input input-num" step="0.5" min="-48" max="24" value={slice.gain ?? 0}
          onChange={(e) => set({ gain: Number(e.target.value) })} data-testid={`slice-gain-${index}`} />dB</label>
      <label className="num" title="Fade in (ms)">In
        <input type="number" className="input input-num" step="1" min="0" value={Math.round((slice.fadeIn ?? 0) * 1000)}
          onChange={(e) => set({ fadeIn: Math.max(0, Number(e.target.value)) / 1000 })} data-testid={`slice-fadein-${index}`} />ms</label>
      <label className="num" title="Fade out (ms)">Out
        <input type="number" className="input input-num" step="1" min="0" value={Math.round((slice.fadeOut ?? 0) * 1000)}
          onChange={(e) => set({ fadeOut: Math.max(0, Number(e.target.value)) / 1000 })} data-testid={`slice-fadeout-${index}`} />ms</label>
      <label className="chk" title="Choke: a choked pad cuts off other choked pads"><input type="checkbox" checked={!!slice.choke} onChange={(e) => set({ choke: e.target.checked })} data-testid={`slice-choke-${index}`} />Choke</label>
      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onDownload(slice) }} title="Save WAV" data-testid={`slice-download-${index}`}>⤓</button>
      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onDelete(slice.id) }} title="Remove slice" data-testid={`slice-delete-${index}`}>✕</button>
    </div>
  )
}
