import { useCallback, useRef } from 'react'
import { useApp } from '../context.js'

// While one of OUR files is being dragged out, the OS drag may pass back over our own window.
// The app-wide drop handler must not import it, so remember that a drag-out is in progress
// until the mouse is used again after the drop.
let draggingOut = false
export const isDraggingOut = () => draggingOut
function markDraggingOut() {
  draggingOut = true
  const clear = (e) => {
    if (e.type === 'mousemove' && e.buttons) return
    draggingOut = false
    for (const t of ['mousemove', 'mousedown', 'keydown', 'dragend']) window.removeEventListener(t, clear, true)
  }
  for (const t of ['mousemove', 'mousedown', 'keydown', 'dragend']) window.addEventListener(t, clear, true)
}

/**
 * Props that make an element drag a real file out to the DAW / desktop.
 * The file is pre-rendered on hover so the native drag starts instantly.
 * `getSpec()` returns a DragSpec (see host/index.js) or null to disable.
 */
export function useNativeDrag(getSpec) {
  const { host, notify } = useApp()
  const last = useRef('')
  const prepare = useCallback(async () => {
    let spec = getSpec()
    if (!spec || !host.capabilities.nativeDrag) return
    if (spec.pending) { // a shaped pad: render its clip first
      try { await spec.pending() } catch (e) { notify(e.message, 'error'); return }
      spec = getSpec()
      if (!spec || spec.pending) return
    }
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
    if (spec.pending) {
      notify('Still preparing that file — drag again in a moment.', 'info')
      prepare()
      return
    }
    markDraggingOut()
    host.startDrag(spec)
  }, [getSpec, host, notify, prepare])

  return { draggable: true, onDragStart, onMouseEnter: prepare, onFocus: prepare }
}
