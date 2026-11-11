// Tap tempo: average of the last (up to) 8 intervals; a gap > 2 s starts over.
export function createTapTempo({ maxTaps = 9, resetMs = 2000 } = {}) {
  let taps = []
  return {
    tap(now = performance.now()) {
      if (taps.length && now - taps[taps.length - 1] > resetMs) taps = []
      taps.push(now)
      if (taps.length > maxTaps) taps.shift()
      if (taps.length < 2) return null
      const span = taps[taps.length - 1] - taps[0]
      return Math.round((60000 * (taps.length - 1) / span) * 100) / 100
    },
    reset() { taps = [] },
    get count() { return taps.length },
  }
}
