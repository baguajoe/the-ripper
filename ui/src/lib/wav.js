// Minimal RIFF/WAVE reader: PCM 16/24/32-bit and IEEE float 32/64, plain or EXTENSIBLE.
// The pad engine plays the engine's own WAVs at their real sample rate (Web Audio's
// decodeAudioData would resample them to the device rate first).

/** ArrayBuffer -> {sr, channels: Float32Array[]} (throws on anything else). */
export function decodeWav(buf) {
  const dv = new DataView(buf)
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let fmt = null
  let data = null
  let o = 12
  while (o + 8 <= buf.byteLength) {
    const id = tag(o)
    let size = dv.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'data' && (size === 0xffffffff || body + size > buf.byteLength)) size = buf.byteLength - body
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true)
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true) // EXTENSIBLE: sub-format GUID
      fmt = { format, channels: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) }
    } else if (id === 'data') {
      data = { offset: body, size }
    }
    o = body + size + (size & 1)
  }
  if (!fmt || !data) throw new Error('WAV has no fmt or data chunk')
  const { format, channels: nch, bits, sr } = fmt
  const bps = bits / 8
  const frames = Math.floor(data.size / (bps * nch))
  const channels = Array.from({ length: nch }, () => new Float32Array(frames))
  let p = data.offset
  const read = format === 3
    ? (bits === 64 ? (q) => dv.getFloat64(q, true) : (q) => dv.getFloat32(q, true))
    : bits === 16 ? (q) => dv.getInt16(q, true) / 32768
      : bits === 24 ? (q) => ((dv.getUint8(q) | (dv.getUint8(q + 1) << 8) | (dv.getInt8(q + 2) << 16)) / 8388608)
        : bits === 32 ? (q) => dv.getInt32(q, true) / 2147483648
          : null
  if (!read || (format !== 1 && format !== 3)) throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) { channels[c][i] = read(p); p += bps }
  }
  return { sr, channels }
}

/** An AudioBuffer-shaped view of {sr, channels} (no copy) for the waveform. */
export const asAudioBuffer = (p) => ({
  sampleRate: p.sr, numberOfChannels: p.channels.length, length: p.channels[0].length,
  duration: p.channels[0].length / p.sr, getChannelData: (c) => p.channels[c],
})

/** {sr, channels} from a Web Audio AudioBuffer (copies). */
export const fromAudioBuffer = (b) => ({ sr: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice()) })

/** {sr, channels} -> 32-bit float WAV bytes (lossless; the engine converts it on import). */
export function encodeWav({ sr, channels }) {
  const nch = channels.length
  const n = channels[0].length
  const buf = new ArrayBuffer(44 + n * nch * 4)
  const dv = new DataView(buf)
  const str = (o, t) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, t.charCodeAt(i)) }
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * nch * 4, true); str(8, 'WAVE')
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, nch, true)
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nch * 4, true); dv.setUint16(32, nch * 4, true); dv.setUint16(34, 32, true)
  str(36, 'data'); dv.setUint32(40, n * nch * 4, true)
  let o = 44
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { dv.setFloat32(o, channels[c][i], true); o += 4 }
  return buf
}
