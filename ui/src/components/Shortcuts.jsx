import { useEffect } from 'react'

const SHORTCUTS = [
  ['Pads', [['1 2 3 4 / Q W E R / A S D F / Z X C V', 'Play pads 1–16 of the current bank'], ['Esc', 'Stop everything'],
    ['Double-click a pad / slice', 'Trim it'], ['Right-click a pad', 'Rename, color, copy, paste, clear'],
    ['Alt + drag a pad onto another', 'Swap them'], ['Ctrl+C / Ctrl+V', 'Copy / paste the selected pad']]],
  ['Waveform', [['Space', 'Play / pause the track'], ['L', 'Loop on / off'], ['S', 'Slice at the playhead (Manual mode)'],
    ['Click a bar number (Shift-click)', 'Select a bar (a range of bars)']]],
  ['Trim editor', [['← / →', 'Nudge the marker 1 ms'], ['Shift + ← / →', 'Nudge 10 ms'], ['Ctrl + ← / →', 'Nudge 1 beat'],
    ['[ / ]', 'Pick the start / end marker'], ['Space', 'Loop audition on / off'], ['Esc', 'Close']]],
  ['Sequencer', [['Enter', 'Play / stop the pattern'], ['Shift+Enter', 'Record'], ['Drag a step up / down', 'Velocity']]],
  ['Files', [['Ctrl+S', 'Save the session'], ['Ctrl+Shift+S', 'Save the session as…'], ['Ctrl+O', 'Open a session'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['?', 'This list']]],
]

/** "?" — every keyboard shortcut on one page. */
export default function Shortcuts({ onClose }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const mod = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal shortcuts" data-testid="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
        <div className="modal-head"><b>Keyboard shortcuts</b><span className="muted small">press ? any time</span>
          <button className="btn btn-small" onClick={onClose} data-testid="shortcuts-close" title="Close (Esc)">Close</button></div>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([group, rows]) => (
            <div key={group}>
              <div className="panel-title">{group}</div>
              <table><tbody>{rows.map(([k, v]) => <tr key={k}><td><kbd>{k.replaceAll('Ctrl', mod)}</kbd></td><td>{v}</td></tr>)}</tbody></table>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
