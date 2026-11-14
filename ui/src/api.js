// Engine API client (/api/v1). The engine location + token come from the host adapter.
//
// The engine can restart (the desktop app supervises it) and then comes back on a new port
// with a new token, so: network failures are retried with backoff, the engine address is
// re-read from the host before each retry, and while the host says the engine is restarting
// we wait for it instead of failing.
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

/** Forget the cached engine address (after the engine restarted). */
export function resetEngine() {
  enginePromise = null
}

export class ApiError extends Error {
  constructor(status, error, detail) {
    super(detail || error || `HTTP ${status}`)
    this.status = status
    this.error = error
  }
}

const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Resolves when the host reports the engine ready (or right away if it can't tell). */
async function engineSettled(timeoutMs) {
  const host = getHost()
  let s = null
  try { s = await host.getEngineStatus?.() } catch { /* not supported */ }
  if (!s || s.state === 'ready' || s.state === 'failed') return s
  return new Promise((resolve) => {
    const t = setTimeout(() => { off?.(); resolve(null) }, timeoutMs)
    const off = host.onEngineStatus?.((st) => {
      if (st.state === 'ready' || st.state === 'failed') { clearTimeout(t); off?.(); resolve(st) }
    })
  })
}

/** fetch() against the engine with retries on network errors (never on HTTP errors). */
export async function engineFetch(path, init = {}, { retries = RETRY_DELAYS_MS } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    const { baseUrl, token } = await engine()
    try {
      return await fetch(`${baseUrl}/api/v1${path}`, { ...init, headers: { 'X-Ripper-Token': token, ...(init.headers || {}) } })
    } catch (e) {
      if (init.signal?.aborted) throw e
      lastErr = e
      if (attempt === retries.length) break
      resetEngine()
      const st = await engineSettled(20_000)
      if (st?.state === 'failed') break
      await sleep(retries[attempt])
    }
  }
  throw new ApiError(0, 'engine_down', `The audio engine is not reachable (${lastErr?.message || 'network error'})`)
}

async function request(path, { method = 'GET', body, raw = false, signal } = {}) {
  const headers = {}
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  // Only idempotent requests are retried after a network error.
  const retries = method === 'GET' ? RETRY_DELAYS_MS : []
  const res = await engineFetch(path, { method, headers, body: payload, signal }, { retries })
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
  retryTrack: (id) => request(`/tracks/${id}/retry`, { method: 'POST' }),
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
    await engineSettled(20_000)
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
      xhr.onerror = () => { resetEngine(); reject(new ApiError(0, 'engine_down', 'The audio engine is not reachable - try again in a moment')) }
      const fd = new FormData()
      fd.append('file', file, file.name)
      xhr.send(fd)
    })
  },
}
