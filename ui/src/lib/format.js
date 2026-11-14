export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '--:--'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
export const formatDuration = (sec) => {
  if (!Number.isFinite(sec)) return '--:--'
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?'
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`
}

/** "45 s", "2 min 10 s" (for time estimates). */
export function formatDurationLong(sec) {
  if (!Number.isFinite(sec)) return '?'
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  return s ? `${m} min ${s} s` : `${m} min`
}
