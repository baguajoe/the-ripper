import { useState } from 'react'
import { useApp } from '../context.js'

export default function LinkBar({ onSubmit, busy }) {
  const [url, setUrl] = useState('')
  const { health } = useApp() || {}
  // Old engines don't report tools; only warn when the engine says there's no runtime.
  const noJs = health?.tools && health.tools.js_runtime === null
  const submit = (e) => {
    e.preventDefault()
    const u = url.trim()
    if (!u) return
    onSubmit(u).then((ok) => ok && setUrl(''))
  }
  return (
    <form className="linkbar" onSubmit={submit}>
      <input
        className="input linkbar-input"
        placeholder="Paste a link (YouTube, SoundCloud, Bandcamp, direct audio URL…)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        data-testid="link-input"
        spellCheck={false}
      />
      <button className="btn btn-primary" type="submit" disabled={busy || !url.trim()} data-testid="link-import">Rip</button>
      <div className="linkbar-note" data-testid="rights-note">Only import content you own or have rights to.</div>
      {noJs && (
        <div className="linkbar-note linkbar-warn" data-testid="link-js-warning">
          Some sites (like YouTube) need a JavaScript runtime that wasn&apos;t found, so their links may not import.
          Direct audio links and dropped files still work. Reinstalling The Ripper should fix this.
        </div>
      )}
    </form>
  )
}
