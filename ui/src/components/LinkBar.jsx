import { useState } from 'react'

export default function LinkBar({ onSubmit, busy }) {
  const [url, setUrl] = useState('')
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
    </form>
  )
}
