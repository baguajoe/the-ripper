import { useState } from 'react'

const STEPS = [
  ['Import', 'Drop a WAV, MP3 or video anywhere on the window, or paste a link. The Ripper finds the tempo, the beat grid and the key.'],
  ['Select', 'Open the track. Drag on the waveform, click a bar number, or use 1 / 2 / 4 / 8 bars from the playhead to pick what to chop.'],
  ['Chop', 'Pick Even, Grid, Transients or Manual and hit Chop: the slices land on 16 pads. Double-click a pad to trim it to the sample.'],
  ['Play', 'Hit the pads with 1234 / QWER / ASDF / ZXCV (or a MIDI controller), shape them in the Pad tab, program a beat in the Sequencer.'],
  ['Drag to your DAW', 'Drag any pad, slice, kit, MIDI or the whole beat straight into FL Studio, Ableton, Logic… — real files, already in tempo.'],
]

/** First-run quick tour: five steps, skippable, shown once. */
export default function Tour({ onDone }) {
  const [i, setI] = useState(0)
  const [title, text] = STEPS[i]
  const last = i === STEPS.length - 1
  return (
    <div className="tour" data-testid="tour" role="dialog" aria-label="Quick tour">
      <div className="tour-step muted small">{i + 1} / {STEPS.length}</div>
      <b className="tour-title" data-testid="tour-title">{title}</b>
      <p>{text}</p>
      <div className="tour-actions">
        <button className="btn btn-small btn-ghost" onClick={onDone} data-testid="tour-skip" title="Skip the tour (it won't show again)">Skip</button>
        {i > 0 && <button className="btn btn-small" onClick={() => setI(i - 1)} data-testid="tour-back" title="Previous step">Back</button>}
        <button className="btn btn-small btn-primary" onClick={() => (last ? onDone() : setI(i + 1))} data-testid="tour-next" title={last ? 'Finish the tour' : 'Next step'}>{last ? 'Done' : 'Next'}</button>
      </div>
    </div>
  )
}
