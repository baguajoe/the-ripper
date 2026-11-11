import { useCallback, useRef } from 'react'
import { useApp } from '../context.js'

/**
 * Props that make an element drag a real file out to the DAW / desktop.
 * The file is pre-rendered on hover so the native drag starts instantly.
 * `getSpec()` returns a DragSpec (see host/index.js) or null to disable.
 */
export function useNativeDrag(getSpec) {
  const { host, notify } = useApp()
  const last = useRef('')
  const prepare = useCallback(() => {
    const spec = getSpec()
    if (!spec || !host.capabilities.nativeDrag) return
    const key = JSON.stringify(spec)
    if (key === last.current) return
    last.current = key
    host.prepareDrag(spec).catch((e) => { last.current = ''; notify(e.message, 'error') })
  }, [getSpec, host, notify])

  const onDragStart = useCallback((e) => {
    const spec = getSpec()
    if (!spec) return
    if (!host.capabilities.nativeDrag) return
    e.preventDefault()
    host.startDrag(spec)
  }, [getSpec, host])

  return { draggable: true, onDragStart, onMouseEnter: prepare, onFocus: prepare }
}
