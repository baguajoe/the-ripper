// Unit tests for desktop/src/supervisor.js: restart policy, elevation, log noise filter.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RestartPolicy, isElevatedOutput, deElevate, NOISY } = require('../../src/supervisor')

test('restart policy: at most 3 restarts per minute', () => {
  const p = new RestartPolicy({ max: 3, windowMs: 60_000 })
  assert.equal(p.allow(0), true)
  assert.equal(p.allow(1000), true)
  assert.equal(p.allow(2000), true)
  assert.equal(p.allow(3000), false) // 4th within a minute: give up
  assert.equal(p.allow(61_500), true) // the first one aged out
  p.reset()
  assert.equal(p.allow(61_600), true)
})

test('elevation is read from the mandatory integrity level', () => {
  assert.equal(isElevatedOutput('Mandatory Label\\High Mandatory Level   Label   S-1-16-12288'), true)
  assert.equal(isElevatedOutput('Mandatory Label\\Medium Mandatory Level Label   S-1-16-8192'), false)
  assert.equal(isElevatedOutput(''), false)
})

test('elevated on Windows -> relaunch through Explorer once, never loop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'J. Test-'))
  const markerFile = path.join(dir, 'marker.txt')
  const launched = []
  const opts = { platform: 'win32', env: {}, execPath: 'C:\\Users\\J. Gallop\\AppData\\Local\\Programs\\the-ripper\\The Ripper.exe', markerFile, elevated: true, launch: (p) => launched.push(p) }
  assert.equal(deElevate({ ...opts, now: 1_000_000 }), 'relaunched')
  assert.deepEqual(launched, [opts.execPath])
  // started elevated again right away (Explorer itself is elevated): stay, warn, no loop
  assert.equal(deElevate({ ...opts, now: 1_005_000 }), 'elevated')
  assert.equal(launched.length, 1)
  assert.equal(deElevate({ ...opts, now: 1_100_000 }), 'relaunched') // much later: try again
  assert.equal(deElevate({ ...opts, elevated: false }), 'normal')
  assert.equal(deElevate({ ...opts, platform: 'darwin' }), 'normal')
  assert.equal(deElevate({ ...opts, env: { RIPPER_ALLOW_ELEVATED: '1' } }), 'elevated')
})

test('log filter hides only successful polling, never failures', () => {
  const line = (m, p, s) => `127.0.0.1 - - [14/Nov/2026 13:41:03] "${m} ${p} HTTP/1.1" ${s} -`
  assert.match(line('GET', '/api/v1/tracks', 200), NOISY)
  assert.match(line('OPTIONS', '/api/v1/tracks', 200), NOISY)
  assert.match(line('GET', '/api/v1/jobs/abc', 200), NOISY)
  assert.doesNotMatch(line('GET', '/api/v1/tracks', 500), NOISY)
  assert.doesNotMatch(line('GET', '/api/v1/tracks', 401), NOISY)
  assert.doesNotMatch(line('POST', '/api/v1/tracks/upload', 202), NOISY)
})
