import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { useApp } from '../context.js'
import LinkBar from '../components/LinkBar.jsx'
import DropZone from '../components/DropZone.jsx'
import TrackCard from '../components/TrackCard.jsx'

const PENDING = new Set(['downloading', 'analyzing'])

export default function Library() {
  const { notify, engineUp, engineGen, uploads, libraryKick } = useApp()
  const [tracks, setTracks] = useState(null)
  const [linkBusy, setLinkBusy] = useState(false)
  const timer = useRef(null)
  const engineUpRef = useRef(engineUp)
  useEffect(() => { engineUpRef.current = engineUp }, [engineUp])

  const refresh = useCallback(async () => {
    try {
      const list = await api.listTracks()
      setTracks(list)
      return list
    } catch (e) {
      setTracks((t) => t ?? [])
      // While the engine is down/restarting the status dot + banner say so; a toast only
      // when it is up and the request still failed.
      if (engineUpRef.current && e.error !== 'engine_down') notify(`Could not load library: ${e.message}`, 'error')
      return null
    }
  }, [notify])

  // Poll while anything is in flight. `kick()` restarts the loop immediately; the
  // generation counter guarantees only one loop is ever scheduled.
  const kickRef = useRef(() => {})
  useEffect(() => {
    let alive = true
    let gen = 0
    const loop = async () => {
      const mine = ++gen
      clearTimeout(timer.current)
      const list = await refresh()
      if (!alive || mine !== gen) return
      const busy = (list || []).some((t) => PENDING.has(t.status))
      timer.current = setTimeout(loop, list === null ? 2000 : busy ? 700 : 4000)
    }
    kickRef.current = loop
    loop()
    return () => { alive = false; gen++; clearTimeout(timer.current) }
  }, [refresh, engineGen]) // engineGen: the engine restarted -> reload right away
  const kick = useCallback(() => kickRef.current(), [])
  useEffect(() => { if (libraryKick) kick() }, [libraryKick, kick])

  const onRetry = useCallback(async (t) => {
    try {
      await api.retryTrack(t.id)
      kick()
    } catch (e) {
      notify(e.message, 'error')
    }
  }, [kick, notify])

  const onLink = useCallback(async (url) => {
    setLinkBusy(true)
    try {
      await api.importLink(url)
      kick()
      return true
    } catch (e) {
      notify(e.message, 'error')
      return false
    } finally {
      setLinkBusy(false)
    }
  }, [kick, notify])

  const onDelete = useCallback(async (t) => {
    try {
      await api.deleteTrack(t.id)
      setTracks((list) => list.filter((x) => x.id !== t.id))
    } catch (e) {
      notify(e.message, 'error')
    }
  }, [notify])

  return (
    <div className="library">
      <section className="import-row">
        <LinkBar onSubmit={onLink} busy={linkBusy} />
        <DropZone />
      </section>
      {uploads.length > 0 && (
        <div className="uploads">
          {uploads.map((u) => (
            <div key={u.id} className="upload-row" data-testid="upload-progress">
              <span>Uploading {u.name}</span>
              <div className="progress"><div className="progress-bar" style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>
            </div>
          ))}
        </div>
      )}
      <section className="grid" data-testid="track-grid">
        {tracks === null && <div className="muted">Loading…</div>}
        {tracks?.length === 0 && uploads.length === 0 && (
          <div className="empty" data-testid="library-empty">No tracks yet. Paste a link, or drop a WAV, MP3 or video to start ripping.</div>
        )}
        {tracks?.map((t) => <TrackCard key={t.id} track={t} onDelete={onDelete} onRetry={onRetry} />)}
      </section>
    </div>
  )
}
