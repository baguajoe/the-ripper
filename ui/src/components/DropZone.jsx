import { useRef } from 'react'
import { useApp } from '../context.js'
import { ACCEPT_ATTR, MAX_AUDIO_MB, MAX_VIDEO_MB } from '../lib/importFiles.js'

/** Import target. Dropping works anywhere in the window (see App.jsx); this is the visible
 *  hint plus the Browse… button. */
export default function DropZone() {
  const { importFiles } = useApp()
  const input = useRef(null)
  return (
    <div className="dropzone" data-testid="dropzone">
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        style={{ display: 'none' }}
        data-testid="file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          e.target.value = ''
          if (files.length) importFiles(files)
        }}
      />
      <div className="dropzone-inner">
        <div className="dropzone-icon">⇣</div>
        <div><strong>Drop audio or video</strong> anywhere, or</div>
        <button type="button" className="btn" onClick={() => input.current?.click()} data-testid="browse-files">Browse…</button>
        <div className="muted small">WAV or MP3 up to {MAX_AUDIO_MB} MB · MP4, MOV, M4V, WEBM, MKV up to {MAX_VIDEO_MB} MB</div>
      </div>
    </div>
  )
}
