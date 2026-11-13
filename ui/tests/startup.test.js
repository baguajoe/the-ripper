import { describe, expect, it } from 'vitest'
import { startupProgress } from '../src/lib/startup.js'

describe('startupProgress', () => {
  it('never goes backwards as stages advance at a fixed time', () => {
    const stages = ['Starting', 'Starting the audio engine', 'Loading Python libraries', 'Checking audio tools',
      'Loading the audio engine', 'Starting the server', 'Connecting', 'Ready']
    const vals = stages.map((s) => startupProgress(s, 1000))
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1])
    expect(vals.at(-1)).toBe(1)
  })
  it('creeps forward with time during a silent cold start but never claims done', () => {
    const a = startupProgress('Loading Python libraries', 2000)
    const b = startupProgress('Loading Python libraries', 37000)
    expect(b).toBeGreaterThan(a)
    expect(startupProgress('Loading Python libraries', 10 * 60_000)).toBeLessThan(1)
  })
  it('handles an unknown or missing stage', () => {
    expect(startupProgress(undefined, 0)).toBeGreaterThan(0)
    expect(startupProgress('Something new', 0)).toBeGreaterThan(0)
  })
})
