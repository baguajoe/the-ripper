// Undo / redo over immutable snapshots. Edits that arrive in a burst for the same thing
// (typing a slice name, dragging a gain box) coalesce into one undo step.
export const HISTORY_LIMIT = 100
const COALESCE_MS = 1200

export const initHistory = (present) => ({ past: [], present, future: [], key: null, at: 0 })

/** Record `next` as the new present. `key`: edits with the same key within ~1 s merge. */
export function push(h, next, key = null, now = Date.now()) {
  if (next === h.present) return h
  if (key && key === h.key && now - h.at < COALESCE_MS) return { ...h, present: next, at: now }
  const past = [...h.past, h.present].slice(-HISTORY_LIMIT)
  return { past, present: next, future: [], key, at: now }
}

export function undo(h) {
  if (!h.past.length) return h
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null, at: 0 }
}

export function redo(h) {
  if (!h.future.length) return h
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null, at: 0 }
}

export const canUndo = (h) => h.past.length > 0
export const canRedo = (h) => h.future.length > 0
