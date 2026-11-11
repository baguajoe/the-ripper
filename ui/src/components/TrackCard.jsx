import { useNavigate } from 'react-router-dom'
import MiniWave from './MiniWave.jsx'
import { formatDuration } from '../lib/format.js'

const STATUS_LABEL = { downloading: 'Downloading', analyzing: 'Analyzing', ready: 'Ready', error: 'Error' }

export default function TrackCard({ track, onDelete }) {
  const navigate = useNavigate()
  const a = track.analysis
  const ready = track.status === 'ready'
  const progress = track.job?.status === 'running' ? track.job.progress : null
  const open = () => ready && navigate(`/track/${track.id}`)
  return (
    <div
      className={`card track-card status-${track.status}`}
      data-testid={`track-card-${track.id}`}
      data-status={track.status}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <div className="card-head">
        <div className="card-title" title={track.title} data-testid="track-title">{track.title}</div>
        <button
          className="icon-btn"
          title="Delete"
          data-testid="track-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(track) }}
        >✕</button>
      </div>
      <MiniWave peaks={a?.peaks} />
      <div className="card-meta">
        <span className="meta-pill" data-testid="track-bpm">{a ? `${Math.round(a.bpm * 10) / 10} BPM` : '— BPM'}</span>
        <span className="meta-pill" data-testid="track-key">{a?.key ?? '—'}</span>
        <span className="meta-pill">{formatDuration(track.duration)}</span>
        <span className={`status status-${track.status}`} data-testid="track-status">{STATUS_LABEL[track.status] ?? track.status}</span>
      </div>
      {progress !== null && !ready && (
        <div className="progress" title={track.job?.message}>
          <div className="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {track.status !== 'ready' && track.job?.message && track.status !== 'error' && <div className="card-sub">{track.job.message}</div>}
      {track.status === 'error' && <div className="card-sub error-text" data-testid="track-error">{track.error}</div>}
    </div>
  )
}
