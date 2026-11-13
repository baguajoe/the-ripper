// Rough shape of a start-up: the engine prints these stages (engine/app.py); the bar also
// creeps forward with time so a long silent cold start (≈40 s on a fresh Mac) still moves.
const STAGES = [
  ['Starting', 0.02],
  ['Starting the audio engine', 0.05],
  ['Loading Python libraries', 0.1],
  ['Checking audio tools', 0.55],
  ['Loading the audio engine', 0.6],
  ['Starting the server', 0.88],
  ['Connecting', 0.94],
  ['Ready', 1],
]
const floorOf = (stage) => STAGES.find(([s]) => s === stage)?.[1] ?? 0.05
const EXPECTED_MS = 20_000

/** 0..1 for the start-up progress bar. */
export function startupProgress(stage, elapsedMs) {
  const timeBased = 0.93 * (1 - Math.exp(-elapsedMs / EXPECTED_MS))
  return Math.min(stage === 'Ready' ? 1 : 0.97, Math.max(floorOf(stage), timeBased))
}
