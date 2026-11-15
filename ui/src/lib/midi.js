// MIDI controllers (Web MIDI): pads from any pad controller or keyboard (velocity respected),
// MIDI learn for pads and the play / stop / record buttons. Default pad notes: 36-51 (C1-D#2)
// = pads 1-16 of the current bank. The learned map is saved in the app settings.
export const DEFAULT_PAD_NOTE = 36
export const BUTTONS = ['play', 'stop', 'record']

export const emptyMap = () => ({ pads: {}, buttons: {} }) // pads: {"n60": 3}; buttons: {play: "n40" | "c20"}

/** "n36" for a note, "c20" for a control change. */
export const msgKey = (type, num) => `${type === 'cc' ? 'c' : 'n'}${num}`

/** What a note / CC does with this map: {kind: 'pad', pad} | {kind: 'button', button} | null. */
export function resolve(map, type, num) {
  const k = msgKey(type, num)
  for (const b of BUTTONS) if (map.buttons?.[b] === k) return { kind: 'button', button: b }
  if (type === 'note') {
    if (map.pads && k in map.pads) return { kind: 'pad', pad: map.pads[k] }
    const learned = new Set(Object.values(map.pads || {}))
    const p = num - DEFAULT_PAD_NOTE
    if (p >= 0 && p < 16 && !learned.has(p)) return { kind: 'pad', pad: p }
  }
  return null
}

/** Assign a message to a target ('pad:N' or a button name); it's removed from anything else. */
export function learn(map, target, type, num) {
  const k = msgKey(type, num)
  const pads = Object.fromEntries(Object.entries(map.pads || {}).filter(([key, pad]) => key !== k && `pad:${pad}` !== target))
  const buttons = Object.fromEntries(Object.entries(map.buttons || {}).filter(([b, key]) => key !== k && b !== target))
  if (target.startsWith('pad:')) {
    if (type !== 'note') return map // pads need a note (for velocity)
    pads[k] = Number(target.slice(4))
  } else {
    buttons[target] = k
  }
  return { pads, buttons }
}

/** Parse raw bytes: {type: 'on' | 'off' | 'cc', num, value} or null. */
export function parse(data) {
  const st = data[0] & 0xf0
  if (st === 0x90 && data[2] > 0) return { type: 'on', num: data[1], value: data[2] }
  if (st === 0x80 || (st === 0x90 && data[2] === 0)) return { type: 'off', num: data[1], value: 0 }
  if (st === 0xb0) return { type: 'cc', num: data[1], value: data[2] }
  return null
}

/** App-wide MIDI input: real devices plus virtual inputs (tests, other software). */
class MidiInput {
  constructor() {
    this.listeners = new Set()
    this.devices = new Map() // id -> {id, name, virtual}
    this.started = null
    this.error = null
  }

  start() {
    if (this.started) return this.started
    this.started = (async () => {
      if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) { this.error = 'Web MIDI is not available'; return }
      try {
        const access = await navigator.requestMIDIAccess({ sysex: false })
        const scan = () => {
          for (const input of access.inputs.values()) this.attach(input)
          for (const [id, d] of this.devices) if (!d.virtual && ![...access.inputs.values()].some((i) => i.id === id)) this.devices.delete(id)
          this.emit({ type: 'devices' })
        }
        access.onstatechange = scan
        scan()
      } catch (e) {
        this.error = e.message
      }
    })()
    return this.started
  }

  attach(input) {
    if (this.devices.has(input.id)) return
    this.devices.set(input.id, { id: input.id, name: input.name || 'MIDI input', virtual: false })
    input.onmidimessage = (e) => this.receive(e.data, input.id)
  }

  /** A software MIDI device: send(bytes) delivers messages exactly like a hardware input. */
  addVirtualInput(name = 'Virtual MIDI') {
    const id = `virtual-${this.devices.size + 1}-${name}`
    this.devices.set(id, { id, name, virtual: true })
    this.emit({ type: 'devices' })
    return { id, name, send: (bytes) => this.receive(Uint8Array.from(bytes), id) }
  }

  receive(data, device) {
    const m = parse(data)
    if (m) this.emit({ ...m, device })
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  emit(m) { for (const fn of this.listeners) fn(m) }

  get list() { return [...this.devices.values()] }
}

export const midiInput = new MidiInput()
if (typeof window !== 'undefined') window.__ripperTest = { ...(window.__ripperTest || {}), midi: midiInput }
