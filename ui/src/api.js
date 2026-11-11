// Engine API client (/api/v1). The engine location + token come from the host adapter.
import { getHost } from './host/index.js'

let enginePromise = null

export function engine() {
  if (!enginePromise) {
    enginePromise = getHost().getEngine().catch((e) => {
      enginePromise = null
      throw e
    })
  }
  return enginePromise
}

export class ApiError extends Error {
  constructor(status, error, detail) {
    super(detail || error || `HTTP ${status}`)
    this.status = status
    this.error = error
  }
}

async function request(path, { method = 'GET', body, raw = false, signal } = {}) {
  const { baseUrl, token } = await engine()
  const headers = { 'X-Ripper-Token': token }
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body: payload, signal })
  if (!res.ok) {
    let err = {}
    try { err = await res.json() } catch { /* not json */ }
    throw new ApiError(res.status, err.error, err.detail)
  }
  return raw ? res : res.json()
}

export const api = {
  health: () => request('/health'),
  listTracks: () => request('/tracks').then((r) => r.tracks),
  getTrack: (id) => request(`/tracks/${id}`),
  patchTrack: (id, body) => request(`/tracks/${id}`, { method: 'PATCH', body }),
  deleteTrack: (id) => request(`/tracks/${id}`, { method: 'DELETE' }),
  importLink: (url) => request('/tracks/link', { method: 'POST', body: { url } }),
  getJob: (id) => request(`/jobs/${id}`),
  onsets: (id, sensitivity, source = 'mix') =>
    request(`/tracks/${id}/onsets?sensitivity=${sensitivity}&source=${encodeURIComponent(source)}`).then((r) => r.onsets),
  startStems: (id, engineName, model) => request(`/tracks/${id}/stems`, { method: 'POST', body: { engine: engineName, model } }),
  getStems: (id) => request(`/tracks/${id}/stems`).then((r) => r.stems),

  /** Raw bytes of the track (or a stem) for Web Audio decoding. */
  async audioBytes(id, source = 'mix') {
    const path = source === 'mix' ? `/tracks/${id}/audio` : `/tracks/${id}/stems/${encodeURIComponent(source)}`
    const res = await request(path, { raw: true })
    return res.arrayBuffer()
  },

  /** Multipart upload with progress (0..1). Resolves {job_id, track_id}. */
  async upload(file, onProgress) {
    const { baseUrl, token } = await engine()
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${baseUrl}/api/v1/tracks/upload`)
      xhr.setRequestHeader('X-Ripper-Token', token)
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => {
        let body = {}
        try { body = JSON.parse(xhr.responseText) } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body)
        else reject(new ApiError(xhr.status, body.error, body.detail))
      }
      xhr.onerror = () => reject(new ApiError(0, 'network', 'Engine unreachable'))
      const fd = new FormData()
      fd.append('file', file, file.name)
      xhr.send(fd)
    })
  },
}
