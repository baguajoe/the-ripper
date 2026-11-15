import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { useApp } from '../context.js'
import { useKeyboard } from '../hooks/useKeyboard.js'
import Waveform from '../components/Waveform.jsx'
import PadGrid from '../components/PadGrid.jsx'
import SliceRow from '../components/SliceRow.jsx'
import ChopControls from '../components/ChopControls.jsx'
import BpmControls from '../components/BpmControls.jsx'
import ExportPanel from '../components/ExportPanel.jsx'
import { divisionBeats, MIN_SLICE, selectionSlices, shiftDownbeat, snap, splitAt } from '../lib/grid.js'
import { BANKS, keyToPad, PADS_PER_BANK } from '../lib/pads.js'
import { BANK_COUNT, FREE_BANKS, chopBanks, clearBank, clearPad, describeChop, emptyProgram, nextEmptyBank, padSettings, padSlice, pastePad, placeChop,
  scaleProgram, swapPads, updateBank, updateSlices, withDefaults } from '../lib/program.js'
import { canRedo, canUndo, initHistory, push, redo, undo } from '../lib/history.js'
import { barRange, barsFrom, formatBarPos, selectionBars, snapSelection } from '../lib/selection.js'
import { LivePlayer } from '../lib/livePlayer.js'
import { DEFAULT_EXPORT, apiSlices } from '../lib/exportSpec.js'
import { asAudioBuffer, decodeWav, encodeWav, fromAudioBuffer } from '../lib/wav.js'
import { registerSource, setTrackBpm } from '../lib/clips.js'
import { getPitched } from '../lib/pitched.js'
import { pitchedKey } from '../dsp/params.js'
import { voiceFrames } from '../dsp/render.js'
import { DEFAULT_TRIM, moveEdge, snapZero } from '../lib/trim.js'
import PadPanel from '../components/PadPanel.jsx'
import TrimEditor from '../components/TrimEditor.jsx'
import { PadMenu } from '../components/PadGrid.jsx'
import SeqPanel from '../components/SeqPanel.jsx'
import FxPanel from '../components/FxPanel.jsx'
import { FREE_PATTERNS, PATTERN_IDS, REPEAT_RATES, addHit, clearPattern, emptySeq, passEvents, unswingTick } from '../lib/sequence.js'
import { emptyMap, learn as midiLearn, midiInput, resolve as midiResolve } from '../lib/midi.js'
import { buildFilename } from '../lib/filenames.js'
import { formatTime } from '../lib/format.js'

/** Clock display with its own state so playback doesn't re-render the whole editor. */
function Playhead({ subscribe, duration }) {
  const [t, setT] = useState(0)
  useEffect(() => subscribe(setT), [subscribe])
  // Fixed width (see .time): the text changes 10x a second and must never reflow the row.
  return <span className="time" data-testid="playhead">{formatTime(t)} / {formatTime(duration)}</span>
}

// The pad program (with its undo history), current bank, selection and chop settings survive
// navigation (Editor <-> Stems) for the session.
const sessionCache = new Map()
let padClipboard = null // {key: editor cacheKey, slice} — copy / paste pads within one track + source
const DEFAULT_CHOP = { mode: 'even', count: 16, division: '1', sensitivity: 0.5, cap: 16, snap: true, snapDivision: '1', replace: false }
const RECHOP_KEYS = ['mode', 'count', 'division', 'sensitivity', 'cap']
const DEFAULT_BARS = 4
const DEFAULT_SEQ_OPTS = { loop: true, overdub: true, countIn: false, metronome: false, quantize: '1/16', repeat: 'off' }
let chopSeq = 1

const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

/** Remount per track + source so a stem sent from the mixer gets its own editor state. */
export default function EditorRoute() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const source = params.get('source') || 'mix'
  return <Editor key={`${id}:${source}`} id={id} source={source} />
}

function Editor({ id, source }) {
  const { host, health, notify } = useApp()
  const cacheKey = `${id}:${source}`
  const cached = sessionCache.get(cacheKey)

  const [track, setTrack] = useState(null)
  const [buffer, setBuffer] = useState(null)
  const [blobUrl, setBlobUrl] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [hist, setHist] = useState(() => cached?.hist ?? initHistory(emptyProgram()))
  const histRef = useRef(hist)
  const [bank, setBankState] = useState(cached?.bank ?? 0)
  const [selection, setSelectionState] = useState(cached?.selection ?? null)
  const [chop, setChopState] = useState(cached?.chop ?? DEFAULT_CHOP)
  const [selectedId, setSelectedIdState] = useState(null)
  const [selectedPad, setSelectedPad] = useState(0)
  const [src, setSrc] = useState(null) // {sr, channels}: the audio the pad engine plays
  const [trimOpts, setTrimOpts] = useState(cached?.trimOpts ?? DEFAULT_TRIM)
  const [trimId, setTrimId] = useState(null)
  const [audition, setAudition] = useState(false)
  const [sideTab, setSideTab] = useState(cached?.sideTab ?? 'slices')
  const [menu, setMenu] = useState(null) // {pad, at}
  const [onsets, setOnsets] = useState(null)
  const [seqOpts, setSeqOptsState] = useState(cached?.seqOpts ?? DEFAULT_SEQ_OPTS)
  const setSeqOpts = useCallback((patch) => setSeqOptsState((o) => ({ ...o, ...patch })), [])
  const [pitchedVer, setPitchedVer] = useState(0)
  const [resampling, setResampling] = useState(null) // 'pass' | 'live' | null
  const [match, setMatch] = useState({ bpm: '', key: '' })
  const [fitting, setFitting] = useState(false)
  const navigate = useNavigate()
  const [livePlayer, setLivePlayer] = useState(null) // the player, as state for components that subscribe to it
  const [midiMap, setMidiMap] = useState(emptyMap())
  const [midiLearning, setMidiLearning] = useState(false)
  const [midiTarget, setMidiTarget] = useState(null)
  const [midiDevices, setMidiDevices] = useState([])
  const [loop, setLoop] = useState({ active: false, start: 0, end: 0 })
  const [activePads, setActivePads] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const timeListeners = useRef(new Set())
  const subscribeTime = useCallback((fn) => {
    timeListeners.current.add(fn)
    return () => timeListeners.current.delete(fn)
  }, [])
  const onTime = useCallback((t) => { for (const fn of timeListeners.current) fn(t) }, [])
  const [zoom, setZoom] = useState(0) // 0 = whole track fits the width
  const [follow, setFollow] = useState(false) // scroll the zoomed waveform with the playhead
  const [options, setOptionsState] = useState(DEFAULT_EXPORT)
  const wave = useRef(null)
  const player = useRef(null)
  const onsetCache = useRef(new Map())
  const chopToken = useRef(0)
  const anchorBar = useRef(null)
  const sensTimer = useRef(null)

  useEffect(() => { sessionCache.set(cacheKey, { hist, bank, selection, chop, trimOpts, sideTab, seqOpts }) }, [cacheKey, hist, bank, selection, chop, trimOpts, sideTab, seqOpts])

  const program = hist.present
  const cur = program.banks[bank]
  const slices = cur.slices
  const allowedBanks = health?.features?.banks_beyond_b === false ? FREE_BANKS : BANK_COUNT

  // --- history -------------------------------------------------------------------------------
  const setHistory = useCallback((h) => { histRef.current = h; setHist(h) }, [])
  /** Apply an edit to the program as one undo step (`coalesce`: merge a burst of the same edit). */
  const commit = useCallback((fn, coalesce = null) => {
    const h = histRef.current
    setHistory(push(h, typeof fn === 'function' ? fn(h.present) : fn, coalesce))
  }, [setHistory])
  const doUndo = useCallback(() => setHistory(undo(histRef.current)), [setHistory])
  const doRedo = useCallback(() => setHistory(redo(histRef.current)), [setHistory])

  // remembered export options
  useEffect(() => { host.getSetting('exportOptions').then((o) => o && setOptionsState({ ...DEFAULT_EXPORT, ...o })).catch(() => {}) }, [host])
  const setOptions = useCallback((o) => { setOptionsState(o); host.setSetting('exportOptions', o).catch(() => {}) }, [host])

  // load track + audio
  useEffect(() => {
    let alive = true
    let url = null
    ;(async () => {
      try {
        const t = await api.getTrack(id)
        if (!alive) return
        setTrack(t)
        const bytes = await api.audioBytes(id, source)
        if (!alive) return
        url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
        const ctx = host.audio.getContext()
        // The pad engine plays the WAV at its own rate; the waveform draws from the same samples
        // (one copy of a long song in memory, not a Web Audio re-decode at the device rate too).
        let pcm
        try { pcm = decodeWav(bytes) } catch { pcm = fromAudioBuffer(await ctx.decodeAudioData(bytes.slice(0))) }
        if (!alive) return
        const buf = asAudioBuffer(pcm)
        registerSource(id, source, pcm)
        if (!player.current) {
          const pl = await LivePlayer.create(ctx)
          if (!alive) { pl.dispose(); return }
          player.current = pl
        }
        if (!alive) return
        setLivePlayer(player.current)
        player.current.setSource(pcm)
        setSrc(pcm)
        window.__ripperTest = { ...(window.__ripperTest || {}), editorSource: pcm } // e2e: the audio the pads play
        setBlobUrl(url)
        setBuffer(buf)
      } catch (e) {
        if (alive) setLoadError(e.message)
      }
    })()
    return () => {
      alive = false
      // leaving the editor: free the pad engine (and its copy of the track) entirely
      player.current?.transportStop()
      player.current?.dispose()
      player.current = null
      if (url) URL.revokeObjectURL(url)
    }
  }, [id, source, host])

  const analysis = track?.analysis
  const duration = buffer?.duration ?? track?.duration ?? 0
  const bpm = analysis?.bpm
  const downbeat = analysis?.downbeat ?? 0

  const playheadTime = useCallback(() => wave.current?.getCurrentTime() ?? 0, [])
  const defaultRegion = useCallback(() => (analysis ? barsFrom(playheadTime(), DEFAULT_BARS, analysis.bpm, analysis.downbeat, duration) : null), [analysis, duration, playheadTime])

  const bankRef = useRef(bank)
  useEffect(() => { bankRef.current = bank }, [bank])
  const setSelectedId = useCallback((sid) => {
    setSelectedIdState(sid)
    const sl = sid && histRef.current.present.banks[bankRef.current]?.slices.find((x) => x.id === sid)
    if (sl) setSelectedPad(sl.pad)
  }, [])
  const setSelection = useCallback((sel) => { setSelectionState(sel); if (!sel) anchorBar.current = null }, [])

  const setBank = useCallback((b) => {
    setBankState(b)
    setSelectedIdState(null)
    const region = histRef.current.present.banks[b]?.chop?.region
    if (region) setSelectionState(region) // the waveform shows what this bank was chopped from
  }, [])

  // --- chopping ------------------------------------------------------------------------------
  const onsetsFor = useCallback(async (sensitivity) => {
    const k = sensitivity.toFixed(2)
    if (!onsetCache.current.has(k)) onsetCache.current.set(k, await api.onsets(id, sensitivity, source))
    return onsetCache.current.get(k)
  }, [id, source])

  const computeSlices = useCallback(async (settings, region, a = analysis) => {
    const { start, end } = region
    if (settings.mode === 'even') return selectionSlices('even', start, end, { count: settings.count })
    if (settings.mode === 'grid') {
      return selectionSlices('grid', start, end, { bpm: a.bpm, downbeat: a.downbeat, division_beats: divisionBeats(settings.division) })
    }
    if (settings.mode === 'transients') {
      const o = await onsetsFor(settings.sensitivity)
      return selectionSlices('transients', start, end, { onsets: o.onsets, strengths: o.strengths, cap: settings.cap, bpm: a.bpm, downbeat: a.downbeat })
    }
    return [{ start, end }] // manual: one slice to split with S / drag
  }, [analysis, onsetsFor])

  /**
   * Chop `region` with `settings`. into: 'new' (next empty bank, unless Replace is ticked),
   * 'current' (re-chop the current bank's chop in place), or 'base' (first open: no undo step).
   */
  const chopInto = useCallback(async ({ settings, region, into, a = analysis, coalesce = null }) => {
    if (!a || !region) return
    const token = ++chopToken.current
    let sl
    if (settings.mode === 'transients') setBusy(true)
    try {
      sl = await computeSlices(settings, region, a)
    } catch (e) {
      notify(e.message, 'error')
      return
    } finally {
      if (settings.mode === 'transients') setBusy(false)
    }
    if (token !== chopToken.current || !sl.length) return // a newer chop won
    const prog = histRef.current.present
    const need = Math.ceil(sl.length / PADS_PER_BANK)
    let target
    if (into === 'current' || into === 'base' || settings.replace) {
      target = chopBanks(prog, bank)[0]
    } else {
      // the bank you're on if it's empty, else the next empty one(s)
      target = prog.banks[bank].slices.length === 0 ? bank : nextEmptyBank(prog, need, allowedBanks)
      if (target < 0) target = nextEmptyBank(prog, 1, allowedBanks)
      if (target < 0) {
        const pro = allowedBanks < BANK_COUNT && nextEmptyBank(prog, 1, BANK_COUNT) >= 0
        notify(pro ? 'Banks C–H are a Pro feature — chopping into the current bank instead (Ctrl+Z to undo).'
          : 'All 8 banks are full — chopping into the current bank instead (Ctrl+Z to undo).', 'info')
        target = chopBanks(prog, bank)[0]
      }
    }
    const r = placeChop(prog, sl, { target, limit: allowedBanks, source, chop: { id: `c${chopSeq++}`, region, settings: { ...settings } } })
    if (into === 'base') setHistory(initHistory(r.program))
    else commit(r.program, coalesce)
    setBankState(r.bank)
    setSelectedIdState(null)
    setSelectionState(region)
    if (r.dropped > 0) {
      notify(`${r.dropped} slice(s) didn't fit: ${allowedBanks < BANK_COUNT ? 'banks C–H are a Pro feature' : 'the banks after this one are in use'}.`, 'info')
    }
  }, [analysis, bank, allowedBanks, source, computeSlices, commit, setHistory, notify])

  const doChop = useCallback(() => {
    const region = selection ?? defaultRegion()
    if (!region) return
    chopInto({ settings: chop, region, into: 'new' })
  }, [selection, defaultRegion, chop, chopInto])

  // Changing size / mode re-chops the current bank right away (one undo step).
  const setChop = useCallback((patch) => {
    const next = { ...chop, ...patch }
    setChopState(next)
    if (!RECHOP_KEYS.some((k) => k in patch) || next.mode === 'manual') return
    const region = selection ?? cur.chop?.region ?? defaultRegion()
    const run = () => chopInto({ settings: next, region, into: 'current', coalesce: 'sensitivity' in patch ? `rechop-sens-${bank}` : null })
    clearTimeout(sensTimer.current)
    if ('sensitivity' in patch) sensTimer.current = setTimeout(run, 200) // slider drag: settle first
    else run()
  }, [chop, selection, cur.chop, defaultRegion, chopInto, bank])

  // first open: chop 4 bars from the start, Even 16, into bank A (pads ready immediately)
  const autoChopped = useRef(false)
  useEffect(() => {
    if (!buffer || !analysis || autoChopped.current) return
    autoChopped.current = true
    if (program.banks.some((b) => b.slices.length)) return
    const region = barsFrom(0, DEFAULT_BARS, analysis.bpm, analysis.downbeat, duration)
    queueMicrotask(() => chopInto({ settings: chop, region, into: 'base' }))
  }, [buffer, analysis, program, duration, chop, chopInto])

  // --- selection -----------------------------------------------------------------------------
  const snapRange = useCallback((sel) => {
    if (!analysis) return sel
    if (!chop.snap) {
      const a = Math.max(0, Math.min(sel.start, sel.end))
      const b = Math.min(duration, Math.max(sel.start, sel.end))
      return b - a >= MIN_SLICE ? { start: a, end: b } : null
    }
    return snapSelection(sel, analysis.bpm, analysis.downbeat, divisionBeats(chop.snapDivision), duration)
  }, [analysis, chop.snap, chop.snapDivision, duration])

  const onSelectionChange = useCallback((sel) => setSelection(snapRange(sel)), [snapRange, setSelection])

  const onBarClick = useCallback((bar, shift) => {
    if (!analysis) return
    if (shift && anchorBar.current != null) {
      setSelectionState(barRange(anchorBar.current, bar, analysis.bpm, analysis.downbeat, duration))
    } else {
      anchorBar.current = bar
      setSelectionState(barRange(bar, bar, analysis.bpm, analysis.downbeat, duration))
    }
  }, [analysis, duration])

  const selectBars = useCallback((n) => {
    if (!analysis) return
    anchorBar.current = null
    setSelectionState(barsFrom(playheadTime(), n, analysis.bpm, analysis.downbeat, duration))
  }, [analysis, duration, playheadTime])

  // --- pads ----------------------------------------------------------------------------------
  const snapT = useCallback((t) => (chop.snap && analysis
    ? snap(t, analysis.bpm, analysis.downbeat, divisionBeats(chop.snapDivision), duration) : t), [chop.snap, chop.snapDivision, analysis, duration])

  const flashPad = useCallback((i) => {
    setActivePads((s) => new Set(s).add(i))
    setTimeout(() => setActivePads((s) => { const n = new Set(s); n.delete(i); return n }), 120)
  }, [])

  const playSlice = useCallback((s, pad = -1, vel = 127) => {
    if (s) player.current?.play(s, { bank, pad, vel, mono: histRef.current.present.banks[bank].mono, pitchedKey: pitchedKey(s) })
  }, [bank])

  const repeating = useRef(-1)
  const triggerPad = useCallback((pad, vel = 127) => {
    if (midiLearning) { setMidiTarget(`pad:${pad}`); return }
    const s = padSlice(cur, pad)
    setSelectedPad(pad)
    if (!s) return
    const v = typeof vel === 'number' ? vel : 127
    if (seqOpts.repeat !== 'off' && REPEAT_RATES[seqOpts.repeat]) {
      repeating.current = pad
      player.current?.setRepeat({ bank, pad, vel: v, rate: REPEAT_RATES[seqOpts.repeat] })
    } else {
      playSlice(s, pad, v)
    }
    flashPad(pad)
    setSelectedIdState(s.id)
  }, [cur, playSlice, flashPad, midiLearning, seqOpts.repeat, bank])

  // keep-length pads: fetch their pitch-shifted copies into the engine
  useEffect(() => {
    if (!player.current) return
    for (const b of program.banks) {
      for (const s of b.slices) {
        const key = pitchedKey(s)
        const p = key && getPitched(id, s)
        if (p) {
          p.then((pcm) => {
            if (player.current && !player.current.pitched.has(key)) { player.current.setPitched(key, pcm); setPitchedVer((v) => v + 1) }
          }).catch((e) => notify(`Keep length: ${e.message}`, 'error'))
        }
      }
    }
  }, [program, id, notify, src])

  const releasePad = useCallback((pad) => {
    if (repeating.current === pad) { repeating.current = -1; player.current?.setRepeat(null) }
    player.current?.release(bank, pad)
  }, [bank])

  const stopAll = useCallback(() => {
    player.current?.transportStop()
    player.current?.stopAll()
    wave.current?.pause()
  }, [])

  // --- slice + bank edits (all undoable) -----------------------------------------------------
  const editSlices = useCallback((fn, coalesce) => commit((p) => updateSlices(p, bank, fn), coalesce), [commit, bank])

  const updateSlice = useCallback((sid, patch) => editSlices((list) => list.map((s) => (s.id === sid ? { ...s, ...patch } : s)),
    `slice:${sid}:${Object.keys(patch).join(',')}`), [editSlices])

  // edges dragged on the main waveform: grid snap (chop settings), zero crossing + link (trim settings)
  const onRegionChange = useCallback((sid, { start, end }) => {
    const s = slices.find((x) => x.id === sid)
    if (!s) return
    const zero = (t) => (trimOpts.zero && src ? snapZero(src, t) : t)
    let list = slices
    if (Math.abs(start - s.start) > 1e-6) list = moveEdge(list, sid, 'start', zero(snapT(start)), { link: trimOpts.link, duration })
    if (Math.abs(end - s.end) > 1e-6) list = moveEdge(list, sid, 'end', zero(snapT(end)), { link: trimOpts.link, duration })
    if (list !== slices) editSlices(() => list)
  }, [slices, snapT, trimOpts, src, duration, editSlices])

  // --- trim editor ---------------------------------------------------------------------------
  const trimSlice = slices.find((s) => s.id === trimId) || null
  const openTrim = useCallback((pad) => {
    const s = padSlice(histRef.current.present.banks[bank], pad)
    if (s) { setTrimId(s.id); setSelectedIdState(s.id); setSelectedPad(pad) }
  }, [bank])
  const closeTrim = useCallback(() => { setTrimId(null); setAudition(false) }, [])
  const applyTrim = useCallback((list, coalesce) => editSlices(() => list, coalesce), [editSlices])
  useEffect(() => {
    if (trimOpts.snap === 'transient' && trimId && !onsets) onsetsFor(chop.sensitivity).then((o) => setOnsets(o.onsets)).catch(() => {})
  }, [trimOpts.snap, trimId, onsets, onsetsFor, chop.sensitivity])
  // loop audition: replays from the start on every change
  useEffect(() => {
    const p = player.current
    if (!audition || !trimSlice || !p || !src) return undefined
    const dur = Math.max(0.02, voiceFrames(src, trimSlice, src.sr) / src.sr)
    const ctx = p.ctx
    p.stopAll()
    let next = ctx.currentTime + 0.03
    const opts = { bank, pad: trimSlice.pad, mono: true, pitchedKey: pitchedKey(trimSlice) }
    const tick = () => {
      while (next < ctx.currentTime + 0.2) { p.play(trimSlice, { ...opts, when: next }); next += dur }
    }
    tick()
    const t = setInterval(tick, 50)
    return () => { clearInterval(t); p.stopAll() }
  }, [audition, trimSlice, src, bank])

  // --- pad management ------------------------------------------------------------------------
  const copyPad = useCallback((pad = selectedPad) => {
    const s = padSlice(histRef.current.present.banks[bank], pad)
    if (!s) return
    padClipboard = { key: cacheKey, slice: padSettings(s) }
    notify(`Copied ${s.name}`, 'info')
  }, [bank, selectedPad, cacheKey, notify])
  const pastePadAt = useCallback((pad = selectedPad) => {
    if (!padClipboard) return
    if (padClipboard.key !== cacheKey) return notify('Pads can be pasted within the same track (and stem).', 'info')
    commit((p) => pastePad(p, bank, pad, padClipboard.slice))
  }, [bank, selectedPad, cacheKey, commit, notify])
  const swap = useCallback((a, b) => { commit((p) => swapPads(p, bank, a, b)); setSelectedPad(b) }, [commit, bank])
  const clearOnePad = useCallback((pad) => commit((p) => clearPad(p, bank, pad)), [commit, bank])
  const padInfo = useMemo(() => (cur.vintage && cur.vintage !== 'off' ? { vintage: cur.vintage } : {}), [cur.vintage])
  const exportSlices = useMemo(() => slices.map((x) => ({ ...x, ...padInfo })), [slices, padInfo])
  const setVintage = useCallback((vintage) => commit((p) => updateBank(p, bank, { vintage })), [commit, bank])

  // --- sequencer -----------------------------------------------------------------------------
  const seq = program.seq ?? emptySeq()
  const allowedPatterns = health?.features?.patterns_beyond_b === false ? FREE_PATTERNS : PATTERN_IDS.length
  const editSeq = useCallback((fn, coalesce) => commit((p) => ({ ...p, seq: fn(p.seq ?? emptySeq()) }), coalesce), [commit])
  // the engine's copy of the pads (sequencer triggers) and the pass it plays
  useEffect(() => {
    const pl = player.current
    if (!pl || !src) return
    pl.setProgram({
      bpm, master: program.master || null,
      banks: program.banks.map((b) => ({
        mono: b.mono, vintage: b.vintage || 'off',
        pads: Array.from({ length: PADS_PER_BANK }, (_, i) => {
          const x = padSlice(b, i)
          if (!x) return null
          const k = pitchedKey(x)
          return { ...x, pitched: k && pl.pitched.has(k) ? `p:${k}` : null }
        }),
      })),
    })
  }, [program, src, pitchedVer, bpm])
  useEffect(() => { if (bpm) setTrackBpm(id, bpm) }, [id, bpm])
  useEffect(() => {
    if (!player.current || !src || !bpm) return
    player.current.setPass({ ...passEvents(seq), bpm, swing: seq.swing }, seqOpts.loop)
  }, [seq, bpm, seqOpts.loop, src])
  useEffect(() => { player.current?.setMetronome(seqOpts.metronome) }, [seqOpts.metronome, src])

  const take = useRef(0)
  const seqRefs = useRef({})
  useEffect(() => { seqRefs.current = { seqOpts, seq } })
  const seqPlay = useCallback((record = false) => {
    const pl = player.current
    if (!pl) return
    if (record) {
      take.current++
      if (!seqRefs.current.seqOpts.overdub) editSeq((s0) => ({ ...s0, patterns: { ...s0.patterns, [s0.current]: clearPattern(s0.patterns[s0.current]) } }), `take-${take.current}`)
    }
    const o = seqRefs.current.seqOpts
    pl.transportPlay({ countIn: o.countIn, metronome: o.metronome, record })
  }, [editSeq])
  const seqStop = useCallback(() => player.current?.transportStop(), [])

  // --- fit the sample to the project tempo / key -> a new track, chops carried over ----------
  const fitToProject = useCallback(async () => {
    const body = {}
    if (match.bpm && Math.abs(Number(match.bpm) - bpm) > 1e-6) body.bpm = Number(match.bpm)
    if (match.key && match.key !== analysis?.key) body.key = match.key
    if (!body.bpm && !body.key) return notify('Pick a different tempo or key to match.', 'info')
    setFitting(true)
    try {
      const r = await api.fitTrack(id, body)
      for (;;) {
        await new Promise((res) => setTimeout(res, 400))
        const j = await api.getJob(r.job_id)
        if (j.status === 'error') throw new Error(j.error || 'failed')
        if (j.status === 'done') break
      }
      // the new track opens with this one's chops, pads and patterns (times scaled by the stretch)
      sessionCache.set(`${r.track_id}:mix`, { ...sessionCache.get(cacheKey), hist: initHistory(scaleProgram(histRef.current.present, r.ratio)) })
      notify(`Fitted${body.bpm ? ` to ${body.bpm} BPM` : ''}${body.key ? ` in ${body.key}` : ''}`, 'success')
      navigate(`/track/${r.track_id}`)
    } catch (e) {
      notify(`Fit failed: ${e.message}`, 'error')
    } finally {
      setFitting(false)
    }
  }, [match, bpm, analysis, id, cacheKey, notify, navigate])

  // --- resample: record the pads / sequencer (with shaping + effects) into a new track ---------
  const importResample = useCallback(async (pcm, label) => {
    try {
      const file = new File([encodeWav(pcm)], `${track.title} (resampled ${label}).wav`, { type: 'audio/wav' })
      const { job_id: jobId, track_id: newId } = await api.upload(file)
      window.__ripperTest = { ...(window.__ripperTest || {}), lastResample: { trackId: newId, frames: pcm.channels[0].length, sr: pcm.sr } }
      notify('Resampled — importing it as a new track…', 'info')
      for (;;) {
        await new Promise((r) => setTimeout(r, 400))
        const j = await api.getJob(jobId)
        if (j.status === 'error') throw new Error(j.error || 'import failed')
        if (j.status === 'done') break
      }
      notify('Resampled track ready', 'success', { label: 'Open', run: () => navigate(`/track/${newId}`) })
    } catch (e) {
      notify(`Resample failed: ${e.message}`, 'error')
    }
  }, [track, notify, navigate])
  const resample = useCallback(async (mode) => {
    const pl = player.current
    if (!pl) return
    if (mode === 'live' && resampling === 'live') { pl.stopCapture(); return }
    if (resampling) return
    setResampling(mode)
    try {
      const pcm = mode === 'pass' ? await pl.resamplePass() : await pl.startCapture()
      if (pcm.channels[0].length < pcm.sr * 0.5) notify('Nothing long enough was recorded (min 0.5 s).', 'info')
      else await importResample(pcm, mode === 'pass' ? (seq.mode === 'song' ? 'song' : `pattern ${seq.current}`) : 'live')
    } finally {
      setResampling(null)
    }
  }, [resampling, importResample, notify, seq])
  const seqRecord = useCallback(() => {
    const pl = player.current
    if (!pl) return
    if (pl.transport.playing) {
      if (!pl.transport.recording) take.current++
      pl.setRecording(!pl.transport.recording)
    } else {
      seqPlay(true)
    }
  }, [seqPlay])
  // recorded hits (live pads, MIDI, note repeat) land in the current pattern, quantized; one take = one undo step
  useEffect(() => {
    const pl = player.current
    if (!pl || !src) return undefined
    return pl.on((m) => {
      if (m.type !== 'hit') return
      const { seqOpts: o, seq: sq } = seqRefs.current
      if (sq.mode === 'song' && sq.song.length) return
      editSeq((s0) => ({
        ...s0,
        patterns: { ...s0.patterns, [s0.current]: addHit(s0.patterns[s0.current], { bank: m.bank, pad: m.pad, vel: m.vel, tick: unswingTick(m.tick, s0.swing) }, o.quantize) },
      }), `take-${take.current}`)
    })
  }, [src, editSeq])

  const onRegionCreate = useCallback(({ start, end }) => {
    if (slices.length >= PADS_PER_BANK) return notify(`Bank ${BANKS[bank]} is full (16 pads) — pick an empty bank first.`, 'info')
    const s0 = snapT(start)
    const e0 = Math.max(snapT(end), s0 + MIN_SLICE)
    editSlices((list) => [...list, withDefaults({ start: s0, end: e0 }, source)])
  }, [slices.length, bank, snapT, source, editSlices, notify])

  const splitAtPlayhead = useCallback(() => {
    const t = snapT(playheadTime())
    const region = selection ?? defaultRegion()
    if (slices.length >= PADS_PER_BANK) return notify(`Bank ${BANKS[bank]} is full (16 pads).`, 'info')
    editSlices((list) => {
      const base = list.length ? list : (region ? [withDefaults(region, source)] : [])
      return splitAt(base, t).map((s) => withDefaults(s, source))
    })
  }, [snapT, playheadTime, selection, defaultRegion, slices.length, bank, source, editSlices, notify])

  const selectedSlice = padSlice(cur, selectedPad)
  const deleteSlice = useCallback((sid) => editSlices((list) => list.filter((s) => s.id !== sid)), [editSlices])
  const setMono = useCallback((mono) => commit((p) => updateBank(p, bank, { mono })), [commit, bank])
  const chokeAll = useCallback((on) => editSlices((list) => list.map((s) => ({ ...s, choke: on }))), [editSlices])
  const clearCurrent = useCallback(() => commit((p) => clearBank(p, bank)), [commit, bank])

  const regrid = useCallback(async (patch) => {
    setBusy(true)
    try {
      const t = await api.patchTrack(id, patch)
      setTrack(t)
      const c = histRef.current.present.banks[bank].chop
      if (c && c.settings.mode === 'grid') chopInto({ settings: c.settings, region: c.region, into: 'current', a: t.analysis })
    } catch (e) {
      notify(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [id, bank, chopInto, notify])

  const toggleLoop = useCallback(() => {
    setLoop((l) => {
      if (l.active) return { ...l, active: false }
      const sel = slices.find((s) => s.id === selectedId)
      if (sel) return { active: true, start: sel.start, end: sel.end }
      if (selection) return { active: true, start: selection.start, end: selection.end }
      if (l.end > l.start) return { ...l, active: true }
      const t = playheadTime()
      const bar = analysis ? (240 / analysis.bpm) : 2
      return { active: true, start: t, end: Math.min(duration, t + bar) }
    })
  }, [slices, selectedId, selection, analysis, duration, playheadTime])

  // --- MIDI controllers -----------------------------------------------------------------------
  useEffect(() => {
    let alive = true
    host.getSetting('midiMap').then((m) => alive && m && setMidiMap({ ...emptyMap(), ...m })).catch(() => {})
    midiInput.start().then(() => alive && setMidiDevices(midiInput.list))
    const off = midiInput.on((m) => { if (m.type === 'devices') setMidiDevices(midiInput.list) })
    return () => { alive = false; off() }
  }, [host])
  const midiRefs = useRef({})
  useEffect(() => { midiRefs.current = { midiMap, midiLearning, midiTarget, triggerPad, releasePad, seqPlay, seqStop, seqRecord } })
  useEffect(() => midiInput.on((m) => {
    if (m.type === 'devices') return
    const r = midiRefs.current
    const type = m.type === 'cc' ? 'cc' : 'note'
    if (r.midiLearning && r.midiTarget && m.type !== 'off' && !(m.type === 'cc' && m.value === 0)) {
      const next = midiLearn(r.midiMap, r.midiTarget, type, m.num)
      if (next !== r.midiMap) {
        setMidiMap(next)
        host.setSetting('midiMap', next).catch(() => {})
        notify(`MIDI ${type === 'cc' ? 'CC' : 'note'} ${m.num} → ${r.midiTarget.replace('pad:', 'pad ').replace(/pad (\d+)/, (_, n) => `pad ${Number(n) + 1}`)}`, 'success')
        setMidiTarget(null)
      }
      return
    }
    const what = midiResolve(r.midiMap, type, m.num)
    if (!what) return
    if (what.kind === 'pad') {
      if (m.type === 'on') r.triggerPad(what.pad, m.value)
      else if (m.type === 'off') r.releasePad(what.pad)
    } else if (m.type === 'on' || (m.type === 'cc' && m.value > 0)) {
      if (what.button === 'play') r.seqPlay()
      else if (what.button === 'stop') r.seqStop()
      else if (what.button === 'record') r.seqRecord()
    }
  }), [host, notify])

  // --- keyboard ------------------------------------------------------------------------------
  useKeyboard((e) => {
    const k = e.key.toLowerCase()
    if (e.code === 'Space') {
      e.preventDefault()
      wave.current?.playPause()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) return seqRecord()
      return player.current?.transport.playing ? seqStop() : seqPlay()
    }
    if (k === 'l') return toggleLoop()
    if (k === 'escape') return stopAll()
    // "S" slices at the playhead in Manual mode; otherwise it's pad 10 (ASDF row).
    if (k === 's' && chop.mode === 'manual') return splitAtPlayhead()
    const pad = keyToPad(e.code) >= 0 ? keyToPad(e.code) : keyToPad(k)
    if (pad >= 0) {
      e.preventDefault()
      triggerPad(pad)
    }
  })

  // key up (note-on pads) + Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z / Ctrl+Y
  const keyRefs = useRef({})
  useEffect(() => { keyRefs.current = { releasePad, doUndo, doRedo, copyPad, pastePadAt } })
  useEffect(() => {
    const up = (e) => {
      const pad = keyToPad(e.code) >= 0 ? keyToPad(e.code) : keyToPad(e.key)
      if (pad >= 0) keyRefs.current.releasePad(pad)
    }
    const down = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || isTyping(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); keyRefs.current.doUndo() }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); keyRefs.current.doRedo() }
      else if (k === 'c' && !window.getSelection?.()?.toString()) { e.preventDefault(); keyRefs.current.copyPad() }
      else if (k === 'v') { e.preventDefault(); keyRefs.current.pastePadAt() }
    }
    window.addEventListener('keyup', up)
    window.addEventListener('keydown', down)
    return () => { window.removeEventListener('keyup', up); window.removeEventListener('keydown', down) }
  }, [])

  const downloadSlice = useCallback(async (s) => {
    try {
      const res = await host.download({
        path: `/tracks/${id}/export`,
        filename: buildFilename(track.title, analysis.bpm, analysis.key, s.name),
        body: { ...options, slices: await apiSlices(id, [{ ...s, ...padInfo }]), format: 'wav' },
      })
      notify(`Saved ${res.path.split(/[\\/]/).pop()}`, 'success', { label: 'Show in folder', run: () => host.showItemInFolder(res.path) })
    } catch (e) {
      notify(e.message, 'error')
    }
  }, [host, id, track, analysis, options, notify, padInfo])

  const stableOptions = useMemo(() => options, [options])

  if (loadError) return <div className="banner banner-error" data-testid="editor-error">Could not open track: {loadError} <Link to="/">Back</Link></div>
  if (!track || !analysis) return <div className="muted pad-24">Loading…</div>

  const nextBank = chop.replace ? chopBanks(program, bank)[0] : slices.length === 0 ? bank : nextEmptyBank(program, 1, allowedBanks)
  const targetLabel = `Bank ${BANKS[nextBank >= 0 ? nextBank : bank]}`
  const bars = selectionBars(selection, bpm)

  return (
    <div className="editor" data-testid="editor">
      <div className="editor-head">
        <Link to="/" className="btn btn-small" data-testid="back-to-library">← Library</Link>
        <h1 className="editor-title" data-testid="editor-title">{track.title}{source !== 'mix' && <span className="badge">stem: {source}</span>}</h1>
        <BpmControls analysis={analysis} onApply={regrid} busy={busy} />
        <span className="key-display" data-testid="editor-key" title={`Camelot ${analysis.camelot ?? ''}`}>{analysis.key ?? '—'}</span>
        <div className="downbeat-ctl" title="Shift the downbeat (bar 1)">
          <button className="btn btn-small" onClick={() => regrid({ downbeat: shiftDownbeat(analysis.downbeat, analysis.bpm, -1) })} disabled={busy} data-testid="downbeat-left">◀</button>
          <span className="muted small">Downbeat</span>
          <button className="btn btn-small" onClick={() => regrid({ downbeat: shiftDownbeat(analysis.downbeat, analysis.bpm, 1) })} disabled={busy} data-testid="downbeat-right">▶</button>
        </div>
        <div className="match-ctl" title={health?.features?.fit === false ? 'Fit to tempo / key is a Pro feature' : 'Match to: time-stretch to a project tempo and/or shift to a project key (new track, chops carried over)'}>
          <span className="muted small">Match</span>
          <input className="input input-num" type="number" min="40" max="300" step="0.1" placeholder={String(bpm)} value={match.bpm}
            onChange={(e) => setMatch((m) => ({ ...m, bpm: e.target.value }))} data-testid="match-bpm" aria-label="Project BPM" />
          <select className="input input-small" value={match.key} onChange={(e) => setMatch((m) => ({ ...m, key: e.target.value }))} data-testid="match-key" aria-label="Project key">
            <option value="">key</option>
            {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].flatMap((n) => [n, `${n}m`]).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button className="btn btn-small" onClick={fitToProject} disabled={fitting || health?.features?.fit === false || (!match.bpm && !match.key)} data-testid="match-fit">
            {fitting ? 'Fitting…' : 'Fit'}</button>
        </div>
        <Link to={`/track/${id}/stems`} className="btn" data-testid="open-stems">Stems ›</Link>
      </div>

      {!buffer ? <div className="waveform-loading">Decoding audio…</div> : (
        <Waveform ref={wave} audioBuffer={buffer} url={blobUrl} bpm={analysis.bpm} downbeat={analysis.downbeat}
          slices={slices} selectedId={selectedId} loop={loop} selection={selection}
          dragMode={chop.mode === 'manual' ? 'slice' : 'select'}
          onSliceChange={onRegionChange} onSelect={(sid, { play } = {}) => { setSelectedId(sid); if (play) { const sl = slices.find((s) => s.id === sid); if (sl) playSlice(sl, sl.pad) } }}
          onTrim={(sid) => { const sl = slices.find((s) => s.id === sid); if (sl) openTrim(sl.pad) }}
          onCreate={onRegionCreate} onSelectionChange={onSelectionChange} onBarClick={onBarClick}
          onLoopChange={(r) => setLoop((l) => ({ ...l, start: snapT(r.start), end: snapT(r.end) }))}
          onTime={onTime} onPlayState={setPlaying} zoom={zoom} follow={follow} />
      )}

      <div className="transport">
        <button className="btn btn-play" onClick={() => wave.current?.playPause()} data-testid="play-toggle">
          {playing ? '❚❚ Pause' : '▶ Play'} <kbd>Space</kbd>
        </button>
        <button className={`btn ${loop.active ? 'btn-on' : ''}`} onClick={toggleLoop} data-testid="loop-toggle">⟳ Loop <kbd>L</kbd></button>
        <Playhead subscribe={subscribeTime} duration={duration} />
        <label className="slider-label">Zoom
          <input type="range" min="0" max="800" step="10" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} data-testid="zoom" />
          <span className="zoom-value">{zoom === 0 ? 'Fit' : `${zoom} px/s`}</span>
        </label>
        <label className="chk" title="When zoomed in, keep the playhead in view by scrolling the waveform">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="follow-toggle" />Follow playhead
        </label>
        <span className="muted small slice-count" data-testid="slice-count">{slices.length} slices</span>
      </div>

      <div className="selection-bar" data-testid="selection-bar">
        <span className="sel-label">Selection</span>
        <span className="sel-info" data-testid="selection-info" data-start={selection?.start ?? ''} data-end={selection?.end ?? ''}>
          {selection
            ? `bar ${formatBarPos(selection.start, bpm, downbeat)} → ${formatBarPos(selection.end, bpm, downbeat)} · ${Number.isInteger(Math.round(bars * 100) / 100) ? Math.round(bars) : bars.toFixed(2)} bar${Math.abs(bars - 1) < 1e-6 ? '' : 's'} · ${formatTime(selection.start)}–${formatTime(selection.end)}`
            : 'none — Chop takes 4 bars from the playhead'}
        </span>
        <span className="muted small">From playhead:</span>
        <div className="seg">
          {[1, 2, 4, 8].map((n) => (
            <button key={n} className="seg-btn" onClick={() => selectBars(n)} data-testid={`select-bars-${n}`} title={`Select ${n} bar${n > 1 ? 's' : ''} from the playhead`}>{n}</button>
          ))}
        </div>
        <button className="btn btn-small" onClick={() => setSelection({ start: 0, end: duration })} data-testid="select-all" title="Select the whole track">All</button>
        <button className="btn btn-small btn-ghost" onClick={() => setSelection(null)} disabled={!selection} data-testid="select-clear" title="Clear the selection">✕</button>
        <span className="muted small bank-info" data-testid="bank-info">
          Bank {BANKS[bank]}{cur.chop ? ` · ${describeChop(cur.chop)}` : ''}{cur.mono ? ' · mono' : ' · poly'}
        </span>
        <button className="btn btn-small" onClick={doUndo} disabled={!canUndo(hist)} data-testid="undo" title="Undo (Ctrl+Z)">↶ Undo</button>
        <button className="btn btn-small" onClick={doRedo} disabled={!canRedo(hist)} data-testid="redo" title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
      </div>

      <ChopControls chop={chop} setChop={setChop} onChop={chop.mode === 'manual' ? splitAtPlayhead : doChop} busy={busy}
        targetLabel={targetLabel} hasSelection={!!selection} />

      <div className="editor-body">
        <PadGrid banks={program.banks} bank={bank} setBank={setBank} allowedBanks={allowedBanks} activePads={activePads}
          selectedPad={selectedPad} onTrigger={triggerPad} onRelease={releasePad} onMono={setMono} onChokeAll={chokeAll}
          onClear={clearCurrent} onStop={stopAll} trackId={id} options={stableOptions} bankInfo={padInfo}
          onSelectPad={setSelectedPad} onSwap={swap} onTrim={openTrim} onMenu={(pad, at) => setMenu({ pad, at })}>
          <select className="input input-small" value={cur.vintage || 'off'} onChange={(e) => setVintage(e.target.value)} data-testid="bank-vintage"
            disabled={health?.features?.vintage === false}
            title={health?.features?.vintage === false ? 'Vintage mode is a Pro feature' : 'Vintage character for every pad in this bank (playback and export)'}>
            <option value="off">Vintage: off</option>
            <option value="12bit">Vintage 12-bit</option>
            <option value="16bit">Vintage 16-bit</option>
          </select>
        </PadGrid>
        <div className="editor-side">
          {sideTab === 'slices' && <ExportPanel track={track} slices={exportSlices} bank={bank} options={options} setOptions={setOptions} />}
          <div className="panel slices-panel">
            <div className="panel-title side-tabs">
              {[['slices', `Slices · Bank ${BANKS[bank]}`], ['pad', 'Pad'], ['fx', 'Effects'], ['seq', 'Sequencer']].map(([k, l]) => (
                <button key={k} className={`side-tab ${sideTab === k ? 'side-tab-on' : ''}`} onClick={() => setSideTab(k)} data-testid={`side-tab-${k}`}
                  title={{ pad: 'Shape the selected pad: tune, envelope, filter, velocity, pan', slices: 'The slices of this bank', seq: 'Step sequencer, patterns, song, recording, MIDI', fx: 'Pad and master effects' }[k]}>{l}</button>
              ))}
              {sideTab === 'slices' && <span className="muted small">drag ⠿ into your DAW · double-click to trim</span>}
            </div>
            {sideTab === 'slices' && (
              <div className="slice-list" data-testid="slice-list">
                {slices.map((s, i) => (
                  <SliceRow key={s.id} slice={s} index={i} selected={s.id === selectedId} onSelect={setSelectedId}
                    onChange={updateSlice} onPlay={(sl) => playSlice(sl, sl.pad)} onDelete={deleteSlice} onDownload={downloadSlice}
                    onTrim={() => openTrim(s.pad)} trackId={id} options={stableOptions} />
                ))}
                {slices.length === 0 && <div className="muted">Empty bank — select a region and hit Chop.</div>}
              </div>
            )}
            {sideTab === 'seq' && (
              <div className="slice-list seq-scroll">
                <SeqPanel seq={seq} onSeq={editSeq} bank={bank} banks={program.banks} player={livePlayer} opts={seqOpts} setOpts={setSeqOpts}
                  onPlay={() => seqPlay()} onStop={seqStop} onRecord={seqRecord} onPreview={(pad) => { const x = padSlice(cur, pad); if (x) playSlice(x, pad) }}
                  allowedPatterns={allowedPatterns} bpm={bpm} resampling={resampling} onResample={resample} canResample={health?.features?.resample !== false}
                  midi={{ learning: midiLearning, setLearning: (on) => { setMidiLearning(on); setMidiTarget(null) }, target: midiTarget, setTarget: setMidiTarget, devices: midiDevices }} />
              </div>
            )}
            {sideTab === 'fx' && (
              <div className="slice-list">
                <FxPanel slice={selectedSlice} bank={bank} locked={health?.features?.effects === false}
                  onPadFx={(fx) => selectedSlice && updateSlice(selectedSlice.id, { fx })}
                  master={program.master} onMaster={(master) => commit((p) => ({ ...p, master }), 'master-fx')} />
              </div>
            )}
            {sideTab === 'pad' && (
              <div className="slice-list">
                <PadPanel slice={selectedSlice} bank={bank} onAudition={() => selectedSlice && triggerPad(selectedPad)}
                  onChange={(patch) => selectedSlice && updateSlice(selectedSlice.id, patch)} />
              </div>
            )}
          </div>
        </div>
        {trimSlice && src && (
          <TrimEditor slice={trimSlice} slices={slices} bank={bank} src={src} opts={trimOpts} setOpts={setTrimOpts}
            ctx={{ src, onsets, bpm: analysis.bpm, downbeat: analysis.downbeat, divisionBeats: divisionBeats(chop.snapDivision), duration }}
            onApply={applyTrim} audition={audition} setAudition={setAudition} onClose={closeTrim} />
        )}
        {menu && (
          <PadMenu at={menu.at} slice={padSlice(cur, menu.pad)} canPaste={!!padClipboard} onClose={() => setMenu(null)}
            onRename={(name) => { const s = padSlice(cur, menu.pad); if (s) updateSlice(s.id, { name }) }}
            onColor={(color) => { const s = padSlice(cur, menu.pad); if (s) updateSlice(s.id, { color }) }}
            onCopy={() => copyPad(menu.pad)} onPaste={() => pastePadAt(menu.pad)} onTrim={() => openTrim(menu.pad)} onClear={() => clearOnePad(menu.pad)} />
        )}
      </div>
    </div>
  )
}
