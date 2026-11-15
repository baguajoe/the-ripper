import { useEffect, useRef, useState } from 'react'
import { BANKS, PADS_PER_BANK } from '../lib/pads.js'
import { padSlice } from '../lib/program.js'
import {
  LENGTHS, PATTERN_IDS, QUANTIZE, REPEAT_RATES, STEP, SWING_MAX, SWING_MIN, emptyPattern, notesAt, patternTicks, setLength,
  setStepVelocity, toggleAccent, toggleStep,
} from '../lib/sequence.js'

let patternClipboard = null

/** Transport position from the engine, kept local so playback doesn't re-render the editor. */
function usePosition(player) {
  const [pos, setPos] = useState({ playing: false, recording: false, tick: null, pass: null })
  useEffect(() => {
    if (!player) return undefined
    return player.on((m) => {
      if (m.type !== 'status') return
      setPos((p) => (p.playing === !!m.transport && p.recording === !!m.recording && p.tick === m.tick ? p
        : { playing: !!m.transport, recording: !!m.recording, tick: m.tick, pass: m.pass }))
    })
  }, [player])
  return pos
}

function Step({ on, vel, accent, beat, playhead, onToggle, onVelocity, testid, title }) {
  const drag = useRef(null)
  return (
    <div className={`step ${on ? 'step-on' : ''} ${beat ? 'step-beat' : ''} ${playhead ? 'step-play' : ''} ${accent ? 'step-accent' : ''}`}
      data-testid={testid} data-on={on ? '1' : '0'} data-vel={on ? vel : ''} title={title}
      onPointerDown={(e) => {
        e.preventDefault()
        if (!on) { onToggle(); return }
        drag.current = { y: e.clientY, vel, moved: false }
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dy = d.y - e.clientY
        if (Math.abs(dy) > 2) d.moved = true
        if (d.moved) onVelocity(Math.max(1, Math.min(127, Math.round(d.vel + dy * 2))))
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (d && !d.moved) onToggle()
      }}>
      {on && <span className="step-vel" style={{ height: `${Math.round((vel / 127) * 100)}%` }} />}
    </div>
  )
}

/**
 * Step sequencer for the current bank: one row per pad, 16/32/64 steps, accents, velocity,
 * swing, patterns A–H, song chain, transport, live record, note repeat, MIDI learn.
 */
export default function SeqPanel({ seq, onSeq, bank, banks, player, opts, setOpts, onPlay, onStop, onRecord, onPreview,
  allowedPatterns, midi, bpm }) {
  const pos = usePosition(player)
  const p = seq.patterns[seq.current] || emptyPattern()
  const steps = p.steps
  const cur = banks[bank]
  const edit = (fn, coalesce) => onSeq((s) => ({ ...s, patterns: { ...s.patterns, [s.current]: fn(s.patterns[s.current] || emptyPattern()) } }), coalesce)
  // playhead step in the current pattern (pattern mode; song mode: when that pattern is playing)
  let playStep = -1
  if (pos.playing && pos.tick != null) {
    if (seq.mode === 'song' && seq.song.length) {
      let at = 0
      for (const id of seq.song) {
        const len = patternTicks(seq.patterns[id])
        if (pos.tick < at + len) { if (id === seq.current) playStep = Math.floor((pos.tick - at) / STEP); break }
        at += len
      }
    } else {
      playStep = Math.floor(pos.tick / STEP)
    }
  }
  const learnBtn = (b) => (midi.learning ? { 'data-learn': midi.target === b ? 'pending' : 'ready', onClickCapture: (e) => { e.stopPropagation(); e.preventDefault(); midi.setTarget(b) } } : {})

  return (
    <div className="seq-panel" data-testid="seq-panel">
      <div className="seq-row">
        <button className={`btn btn-small ${pos.playing ? 'btn-on' : ''}`} onClick={pos.playing ? onStop : onPlay} data-testid="seq-play"
          title="Play / stop the pattern (Enter)" {...learnBtn('play')}>{pos.playing ? '■ Stop' : '▶ Play'}</button>
        <button className="btn btn-small" onClick={onStop} data-testid="seq-stop" title="Stop" {...learnBtn('stop')}>■</button>
        <button className={`btn btn-small btn-rec ${pos.recording ? 'btn-rec-on' : ''}`} onClick={onRecord} data-testid="seq-record"
          title="Record pads into the pattern (Shift+Enter)" {...learnBtn('record')}>● Rec</button>
        <label className="chk" title="Loop the pattern"><input type="checkbox" checked={opts.loop} onChange={(e) => setOpts({ loop: e.target.checked })} data-testid="seq-loop" />Loop</label>
        <label className="chk" title="Overdub: recording adds to the pattern. Off: a new take replaces it.">
          <input type="checkbox" checked={opts.overdub} onChange={(e) => setOpts({ overdub: e.target.checked })} data-testid="seq-overdub" />Overdub</label>
        <label className="chk" title="One bar of clicks before playing / recording"><input type="checkbox" checked={opts.countIn} onChange={(e) => setOpts({ countIn: e.target.checked })} data-testid="seq-countin" />Count-in</label>
        <label className="chk" title="Metronome click"><input type="checkbox" checked={opts.metronome} onChange={(e) => setOpts({ metronome: e.target.checked })} data-testid="seq-metronome" />Click</label>
        <span className="muted small" data-testid="seq-bpm" title="Project tempo">{Math.round(bpm * 10) / 10} BPM</span>
      </div>
      <div className="seq-row">
        <div className="seg seg-small" role="group" aria-label="Patterns">
          {PATTERN_IDS.map((id, i) => {
            const locked = i >= allowedPatterns
            const used = (seq.patterns[id]?.notes.length ?? 0) > 0
            return (
              <button key={id} className={`seg-btn ${seq.current === id ? 'seg-on' : ''} ${used ? 'pattern-used' : ''}`} disabled={locked}
                onClick={() => onSeq((s) => ({ ...s, current: id }))} data-testid={`pattern-${id}`}
                title={locked ? `Pattern ${id} is a Pro feature` : `Pattern ${id}${used ? '' : ' (empty)'}`}>{id}{locked && <span className="badge badge-pro-lock">PRO</span>}</button>
            )
          })}
        </div>
        <select className="input input-small" value={steps} onChange={(e) => edit((x) => setLength(x, Number(e.target.value)))} data-testid="seq-length" title="Pattern length">
          {LENGTHS.map((n) => <option key={n} value={n}>{n} steps · {n / 16} bar{n > 16 ? 's' : ''}</option>)}
        </select>
        <button className="btn btn-small" onClick={() => { patternClipboard = p }} data-testid="pattern-copy" title="Copy this pattern">Copy</button>
        <button className="btn btn-small" onClick={() => patternClipboard && edit(() => patternClipboard)} disabled={!patternClipboard} data-testid="pattern-paste" title="Paste over this pattern">Paste</button>
        <button className="btn btn-small btn-ghost" onClick={() => edit((x) => ({ ...x, notes: [], accents: [] }))} data-testid="pattern-clear" title="Clear this pattern">Clear</button>
        <label className="slider-label" title="Swing: delays every second 16th (50% = straight)">Swing
          <input type="range" min={SWING_MIN} max={SWING_MAX} value={seq.swing} onChange={(e) => onSeq((s) => ({ ...s, swing: Number(e.target.value) }), 'swing')} data-testid="seq-swing" />
          <span className="shape-value" data-testid="seq-swing-value">{seq.swing}%</span>
        </label>
      </div>
      <div className="seq-row">
        <div className="seg seg-small" title="Play the current pattern, or the song (patterns chained in order)">
          {['pattern', 'song'].map((m) => (
            <button key={m} className={`seg-btn ${seq.mode === m ? 'seg-on' : ''}`} onClick={() => onSeq((s) => ({ ...s, mode: m }))} data-testid={`seq-mode-${m}`}>{m === 'pattern' ? 'Pattern' : 'Song'}</button>
          ))}
        </div>
        <span className="song-chain" data-testid="song-chain">
          {seq.song.map((id, i) => (
            <button key={i} className="chip chip-small" onClick={() => onSeq((s) => ({ ...s, song: s.song.filter((_, j) => j !== i) }))} title="Remove from the song" data-testid={`song-${i}`}>{id}</button>
          ))}
          <button className="btn btn-small" onClick={() => onSeq((s) => ({ ...s, song: [...s.song, s.current].slice(0, 64) }))} data-testid="song-add" title="Add the current pattern to the end of the song">+ {seq.current}</button>
        </span>
        <label className="num" title="Quantize recorded hits">Quantize
          <select className="input input-small" value={opts.quantize} onChange={(e) => setOpts({ quantize: e.target.value })} data-testid="seq-quantize">
            {Object.keys(QUANTIZE).map((q) => <option key={q} value={q}>{q === 'off' ? 'Off' : q}</option>)}
          </select>
        </label>
        <label className="num" title="Note repeat: hold a pad to repeat it at this rate">Repeat
          <select className="input input-small" value={opts.repeat} onChange={(e) => setOpts({ repeat: e.target.value })} data-testid="seq-repeat">
            <option value="off">Off</option>
            {Object.keys(REPEAT_RATES).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <button className={`btn btn-small ${midi.learning ? 'btn-on' : ''}`} onClick={() => midi.setLearning(!midi.learning)} data-testid="midi-learn"
          title={`MIDI learn: click a pad or Play / Stop / Rec, then hit a key or knob on your controller. Inputs: ${midi.devices.map((d) => d.name).join(', ') || 'none'}`}>
          MIDI {midi.learning ? (midi.target ? `→ ${midi.target}` : 'learn: pick a target') : `(${midi.devices.length})`}
        </button>
      </div>
      <div className="seq-grid" style={{ '--steps': steps }} data-testid="seq-grid" data-steps={steps} data-playstep={playStep}>
        <div className="seq-label muted small">Accent</div>
        {Array.from({ length: steps }, (_, s) => (
          <div key={s} className={`step step-acc ${(p.accents || []).includes(s) ? 'step-on' : ''} ${s % 4 === 0 ? 'step-beat' : ''}`}
            data-testid={`accent-${s}`} data-on={(p.accents || []).includes(s) ? '1' : '0'} title={`Accent step ${s + 1} (full velocity)`}
            onPointerDown={(e) => { e.preventDefault(); edit((x) => toggleAccent(x, s)) }} />
        ))}
        {Array.from({ length: PADS_PER_BANK }, (_, pad) => {
          const sl = padSlice(cur, pad)
          return [
            <button key={`l${pad}`} className="seq-label" style={sl?.color ? { borderLeftColor: sl.color } : undefined}
              onPointerDown={() => onPreview(pad)} data-testid={`seq-row-${pad}`} title={sl ? `${sl.name} — click to hear` : 'Empty pad'}>
              {BANKS[bank]}{String(pad + 1).padStart(2, '0')} <span className="muted">{sl?.name ?? ''}</span>
            </button>,
            ...Array.from({ length: steps }, (_, s) => {
              const ns = notesAt(p, bank, pad, s)
              const on = ns.length > 0
              return (
                <Step key={`${pad}:${s}`} on={on} vel={on ? ns[0].vel : 0} beat={s % 4 === 0} playhead={s === playStep}
                  accent={(p.accents || []).includes(s)} testid={`step-${pad}-${s}`}
                  title={on ? `Velocity ${ns[0].vel} — drag up/down to change, click to remove` : `Step ${s + 1}`}
                  onToggle={() => edit((x) => toggleStep(x, bank, pad, s))}
                  onVelocity={(v) => edit((x) => setStepVelocity(x, bank, pad, s, v), `vel:${pad}:${s}`)} />
              )
            }),
          ]
        })}
      </div>
    </div>
  )
}
