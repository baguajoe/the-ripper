import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

/** Poll /jobs/<id> until done/error. Returns the latest job (or null). */
export function usePollJob(jobId, { interval = 500, onDone, onError } = {}) {
  const [job, setJob] = useState(null)
  const cbs = useRef({ onDone, onError })
  useEffect(() => { cbs.current = { onDone, onError } })

  useEffect(() => {
    if (!jobId) return undefined
    let alive = true
    let timer = null
    const tick = async () => {
      try {
        const j = await api.getJob(jobId)
        if (!alive) return
        setJob(j)
        if (j.status === 'done') return cbs.current.onDone?.(j)
        if (j.status === 'error') return cbs.current.onError?.(j)
      } catch (e) {
        if (!alive) return
        if (e.status === 404) return cbs.current.onError?.({ error: 'Job lost (engine restarted?)' })
      }
      timer = setTimeout(tick, interval)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [jobId, interval])

  return jobId ? job : null
}
