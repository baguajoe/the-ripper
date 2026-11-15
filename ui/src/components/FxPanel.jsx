import { DEFAULT_COMP, DEFAULT_FX, DELAY_TIMES } from '../dsp/fx.js'
import { BANKS } from '../lib/pads.js'

const pct = (v) => `${Math.round(v * 100)}%`

function Knob({ label, value, min = 0, max = 1, step = 0.01, fmt = pct, onChange, testid, title }) {
  return (
    <label className="shape-row" title={title}>
      <span className="shape-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testid} />
      <span className="shape-value">{fmt(value)}</span>
    </label>
  )
}

/** One effect: on/off + its parameters. */
function Effect({ name, label, fx, defaults, onChange, prefix, children }) {
  const f = { ...defaults, ...(fx?.[name] || {}) }
  const set = (patch) => onChange({ ...(fx || {}), [name]: { ...f, ...patch } })
  return (
    <fieldset className={`shape-group ${f.on ? '' : 'fx-off'}`}>
      <legend>
        <label className="chk"><input type="checkbox" checked={!!f.on} onChange={(e) => set({ on: e.target.checked })} data-testid={`${prefix}-${name}-on`} title={`${label} on / off`} />{label}</label>
      </legend>
      {children(f, set)}
      <Knob label="Mix" value={f.mix} onChange={(v) => set({ mix: v })} testid={`${prefix}-${name}-mix`} title="Wet / dry" />
    </fieldset>
  )
}

function Chain({ fx, onChange, prefix, master }) {
  return (
    <div className="shape-grid">
      <Effect name="drive" label="Drive" fx={fx} defaults={DEFAULT_FX.drive} onChange={onChange} prefix={prefix}>
        {(f, set) => <Knob label="Amount" value={f.amount} onChange={(v) => set({ amount: v })} testid={`${prefix}-drive-amount`} title="Saturation amount" />}
      </Effect>
      <Effect name="delay" label="Delay" fx={fx} defaults={DEFAULT_FX.delay} onChange={onChange} prefix={prefix}>
        {(f, set) => (
          <>
            <label className="shape-row" title="Delay time, synced to the project tempo">
              <span className="shape-label">Time</span>
              <select className="input input-small" value={f.time} onChange={(e) => set({ time: e.target.value })} data-testid={`${prefix}-delay-time`}>
                {Object.keys(DELAY_TIMES).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <Knob label="Feedback" value={f.feedback} max={0.9} onChange={(v) => set({ feedback: v })} testid={`${prefix}-delay-feedback`} title="How many echoes" />
          </>
        )}
      </Effect>
      <Effect name="reverb" label="Reverb" fx={fx} defaults={DEFAULT_FX.reverb} onChange={onChange} prefix={prefix}>
        {(f, set) => (
          <>
            <Knob label="Size" value={f.size} onChange={(v) => set({ size: v })} testid={`${prefix}-reverb-size`} title="Room size / decay" />
            <Knob label="Damp" value={f.damp} onChange={(v) => set({ damp: v })} testid={`${prefix}-reverb-damp`} title="High-frequency damping" />
          </>
        )}
      </Effect>
      {master && (
        <Effect name="comp" label="Compressor" fx={fx} defaults={DEFAULT_COMP} onChange={onChange} prefix={prefix}>
          {(f, set) => (
            <>
              <Knob label="Thresh" value={f.threshold} min={-48} max={0} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ threshold: v })} testid={`${prefix}-comp-threshold`} title="Threshold" />
              <Knob label="Ratio" value={f.ratio} min={1} max={20} step={0.5} fmt={(v) => `${v}:1`} onChange={(v) => set({ ratio: v })} testid={`${prefix}-comp-ratio`} title="Ratio" />
              <Knob label="Attack" value={f.attack} min={0.0005} max={0.1} step={0.0005} fmt={(v) => `${(v * 1000).toFixed(1)} ms`} onChange={(v) => set({ attack: v })} testid={`${prefix}-comp-attack`} title="Attack" />
              <Knob label="Release" value={f.release} min={0.02} max={1} step={0.01} fmt={(v) => `${Math.round(v * 1000)} ms`} onChange={(v) => set({ release: v })} testid={`${prefix}-comp-release`} title="Release" />
              <Knob label="Makeup" value={f.makeup} min={0} max={18} step={0.5} fmt={(v) => `+${v} dB`} onChange={(v) => set({ makeup: v })} testid={`${prefix}-comp-makeup`} title="Makeup gain" />
            </>
          )}
        </Effect>
      )}
    </div>
  )
}

/** Effects: the selected pad's chain and the master bus. */
export default function FxPanel({ slice, bank, onPadFx, master, onMaster, locked }) {
  if (locked) return <div className="muted pad-12" data-testid="fx-locked">Effects are a Pro feature.</div>
  return (
    <div className="pad-panel" data-testid="fx-panel">
      <div className="pad-panel-head"><b>Pad {slice ? `${BANKS[bank]}${String(slice.pad + 1).padStart(2, '0')} · ${slice.name}` : '—'}</b>
        <span className="muted small">drive → delay → reverb, rendered into exports</span></div>
      {slice ? <Chain fx={slice.fx} onChange={onPadFx} prefix="padfx" /> : <div className="muted">Select a pad.</div>}
      <div className="pad-panel-head"><b>Master bus</b> <span className="muted small">every pad and the sequencer · beat exports and resampling</span></div>
      <Chain fx={master} onChange={onMaster} prefix="master" master />
    </div>
  )
}
