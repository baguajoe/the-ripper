import { useDropzone } from 'react-dropzone'

const MAX = 200 * 1024 * 1024

export default function DropZone({ onFiles, onReject }) {
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: { 'audio/wav': ['.wav'], 'audio/x-wav': ['.wav'], 'audio/wave': ['.wav'], 'audio/mpeg': ['.mp3'] },
    maxSize: MAX,
    multiple: true,
    noClick: true,
    onDropAccepted: onFiles,
    onDropRejected: (rejections) => onReject(rejections.map((r) => `${r.file.name}: ${r.errors.map((e) => (e.code === 'file-too-large' ? 'over 200 MB' : e.code === 'file-invalid-type' ? 'not a WAV/MP3' : e.message)).join(', ')}`)),
  })
  return (
    <div {...getRootProps({ className: `dropzone ${isDragActive ? 'dropzone-active' : ''}` })} data-testid="dropzone">
      <input {...getInputProps()} data-testid="file-input" />
      <div className="dropzone-inner">
        <div className="dropzone-icon">⇣</div>
        <div><strong>Drop WAV or MP3</strong> here, or</div>
        <button type="button" className="btn" onClick={open} data-testid="browse-files">Browse…</button>
        <div className="muted small">Max 200 MB per file</div>
      </div>
    </div>
  )
}
