const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLogs } = require('../../src/logs')

test('logs rotate and never exceed the total budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-logs-'))
  const total = 40_000
  const logs = createLogs(dir, total)
  for (let i = 0; i < 2000; i++) {
    logs.engine.write(`engine line ${i} ${'x'.repeat(40)}`)
    logs.app.write(`app line ${i}`)
  }
  const size = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)
  assert.ok(size <= total, `${size} > ${total}`)
  assert.ok(fs.existsSync(path.join(dir, 'engine.log.1')))
  const tail = logs.engine.tail(5)
  assert.equal(tail.length, 5)
  assert.match(tail[4], /engine line 1999 /)
})

test('tail reaches into the rotated file when the current one is short', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-logs-'))
  const logs = createLogs(dir, 4000)
  for (let i = 0; i < 30; i++) logs.app.write(`line ${i} ${'y'.repeat(30)}`)
  assert.match(logs.app.tail(30).at(-1), /line 29 /)
  assert.ok(logs.app.tail(30).length > 20)
})
