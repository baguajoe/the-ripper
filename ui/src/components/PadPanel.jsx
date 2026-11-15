import { DEFAULT_ENV, DEFAULT_FILTER, FILTER_MAX_HZ, FILTER_MIN_HZ, FINE_RANGE, TUNE_RANGE, shaping } from '../dsp/params.js'
import { BANKS, padKeyLabel } from '../lib/pads.js'

// cutoff slider: 0..1000 on a log scale
const toCut = (v) => Math.round(FILTER_MIN_HZ * Math.pow(FILTER_MAX_HZ / FILTER_MIN_HZ, v / 1000))
const fromCut = (hz) => Math.round((1000 * Math.log(hz / FILTER_MIN_HZ)) / Math.log(FILTER_MAX_HZ / FILTER_MIN_HZ))
const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${hz} Hz`)
const ms = (s) => `${Math.round(s * 1000)} ms`

/** Envelope shape: attack / decay / sustain (held) / release, scaled to fit. */
export function EnvelopeView({ env }) {
  const W = 180
  const H = 48
  const hold = 0.25
  const total = Math.max(0.5, env.a + env.d + hold + env.r)
  const x = (t) => (t / total) * W
  const y = (g) => H - 2 - g * (H - 6)
  const pts = [[0, y(0)], [x(env.a), y(1)], [x(env.a + env.d), y(env.s)], [x(env.a + env.d + hold), y(env.s)], [x(env.a + env.d + hold + env.r), y(0)]]
  return (
    <svg className="env-view" width={W} height={H} viewBox={`0 0 ${W} ${H}`} data-testid="env-view" aria-label="Envelope shape">
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1={x(env.a + env.d + hold)} x2={x(env.a + env.d + hold)} y1="0" y2={H} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="2 3" />
    </svg>
  )
}

function Slider({ label, value, min, max, step = 1, onChange, display, testid, title }) {
  return (
    <label className="shape-row" title={title}>
      <span className="shape-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testid} />
      <span className="shape-value" data-testid={`${testid}-value`}>{display ?? value}</span>
    </label>
  )
}

/**
 * Sound shaping for one pad: tune (+ keep length), envelope, filter, velocity, pan.
 * onChange(patch) merges into the slice (one undo step per burst of the same control).
 */
export default function PadPanel({ slice, bank, onChange, onAudition }) {
  if (!slice) return <div className="muted pad-12" data-testid="pad-panel-empty">Select a pad to shape its sound.</div>
  const sh = shaping(slice)
  const env = (patch) => onChange({ env: { ...DEFAULT_ENV, ...sh.env, ...patch } })
  const flt = (patch) => onChange({ filter: { ...DEFAULT_FILTER, ...sh.filter, ...patch } })
  return (
    <div className="pad-panel" data-testid="pad-panel">
      <div className="pad-panel-head">
        <span className="pad-swatch" style={{ background: slice.color || 'var(--line)' }} />
        <b>{BANKS[bank]}{String(slice.pad + 1).padStart(2, '0')}</b> <span className="muted small">key {padKeyLabel(slice.pad)} · {slice.name}</span>
        <button className="btn btn-small" onClick={onAudition} title="Play this pad" data-testid="pad-audition">▶</button>
        <button className="btn btn-small btn-ghost" title="Reset tune, envelope, filter, velocity and pan"
          onClick={() => onChange({ tune: 0, fine: 0, keepLength: false, env: DEFAULT_ENV, filter: DEFAULT_FILTER, velVol: 1, velFilter: 0, pan: 0 })} data-testid="shape-reset">Reset</button>
      </div>
      <div className="shape-grid">
        <fieldset className="shape-group">
          <legend>Tune</legend>
          <Slider label="Semi" min={-TUNE_RANGE} max={TUNE_RANGE} value={sh.tune} onChange={(v) => onChange({ tune: v })}
            display={`${sh.tune > 0 ? '+' : ''}${sh.tune} st`} testid="shape-tune" title="Tune in semitones (±24). Changes speed, like a classic sampler." />
          <Slider label="Fine" min={-FINE_RANGE} max={FINE_RANGE} value={sh.fine} onChange={(v) => onChange({ fine: v })}
            display={`${sh.fine > 0 ? '+' : ''}${sh.fine} ct`} testid="shape-fine" title="Fine tune in cents (±50)" />
          <label className="chk" title="Keep length: change the pitch by time-stretching, so the pad keeps its length">
            <input type="checkbox" checked={sh.keepLength} onChange={(e) => onChange({ keepLength: e.target.checked })} data-testid="shape-keeplength" />Keep length
          </label>
        </fieldset>
        <fieldset className="shape-group">
          <legend>Envelope</legend>
          <EnvelopeView env={sh.env} />
          <Slider label="A" min={0} max={2000} value={Math.round(sh.env.a * 1000)} onChange={(v) => env({ a: v / 1000 })} display={ms(sh.env.a)} testid="shape-attack" title="Attack: fade-in time" />
          <Slider label="D" min={0} max={2000} value={Math.round(sh.env.d * 1000)} onChange={(v) => env({ d: v / 1000 })} display={ms(sh.env.d)} testid="shape-decay" title="Decay: time to fall to the sustain level" />
          <Slider label="S" min={0} max={100} value={Math.round(sh.env.s * 100)} onChange={(v) => env({ s: v / 100 })} display={`${Math.round(sh.env.s * 100)}%`} testid="shape-sustain" title="Sustain level" />
          <Slider label="R" min={0} max={4000} value={Math.round(sh.env.r * 1000)} onChange={(v) => env({ r: v / 1000 })} display={ms(sh.env.r)} testid="shape-release"
            title="Release: fade after the pad is let go (note-on). A one-shot fades out over its last R ms." />
        </fieldset>
        <fieldset className="shape-group">
          <legend>Filter</legend>
          <div className="seg seg-small">
            {[['off', 'Off'], ['lp', 'LP'], ['hp', 'HP'], ['bp', 'BP']].map(([v, l]) => (
              <button key={v} className={`seg-btn ${sh.filter.type === v ? 'seg-on' : ''}`} onClick={() => flt({ type: v })} data-testid={`shape-filter-${v}`}
                title={{ off: 'No filter', lp: 'Low-pass', hp: 'High-pass', bp: 'Band-pass' }[v]}>{l}</button>
            ))}
          </div>
          <Slider label="Cut" min={0} max={1000} value={fromCut(sh.filter.cutoff)} onChange={(v) => flt({ cutoff: toCut(v) })} display={fmtHz(sh.filter.cutoff)} testid="shape-cutoff" title="Cutoff frequency" />
          <Slider label="Res" min={0} max={100} value={Math.round(sh.filter.res * 100)} onChange={(v) => flt({ res: v / 100 })} display={`${Math.round(sh.filter.res * 100)}%`} testid="shape-res" title="Resonance" />
        </fieldset>
        <fieldset className="shape-group">
          <legend>Velocity · Pan</legend>
          <Slider label="Vel→Vol" min={0} max={100} value={Math.round(sh.velVol * 100)} onChange={(v) => onChange({ velVol: v / 100 })} display={`${Math.round(sh.velVol * 100)}%`} testid="shape-velvol"
            title="How much hitting softer makes the pad quieter" />
          <Slider label="Vel→Flt" min={0} max={100} value={Math.round(sh.velFilter * 100)} onChange={(v) => onChange({ velFilter: v / 100 })} display={`${Math.round(sh.velFilter * 100)}%`} testid="shape-velfilter"
            title="How much hitting softer closes the filter (up to 4 octaves)" />
          <Slider label="Pan" min={-100} max={100} value={Math.round(sh.pan * 100)} onChange={(v) => onChange({ pan: v / 100 })}
            display={sh.pan === 0 ? 'C' : `${sh.pan < 0 ? 'L' : 'R'}${Math.abs(Math.round(sh.pan * 100))}`} testid="shape-pan" title="Pan left / right" />
        </fieldset>
      </div>
    </div>
  )
}
