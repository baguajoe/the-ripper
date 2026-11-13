// Unit tests for the desktop-side tool resolver (desktop/src/tools.js): node --test tests/unit/
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { findTool, findAll, bundledDirs } = require('../../src/tools')

const WIN = process.platform === 'win32'
const exe = (n) => n + (WIN ? '.exe' : '')

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ripper-tools-'))
  const bundled = path.join(base, 'bundled')
  const onPath = path.join(base, 'path')
  fs.mkdirSync(bundled)
  fs.mkdirSync(onPath)
  const make = (dir, name) => {
    const p = path.join(dir, exe(name))
    fs.writeFileSync(p, '#!/bin/sh\necho fake\n')
    fs.chmodSync(p, 0o755)
    return p
  }
  return { base, bundled, onPath, make, env: { PATH: onPath } }
}

for (const name of ['ffmpeg', 'ffprobe', 'deno']) {
  test(`${name}: bundled copy wins over PATH`, () => {
    const { bundled, onPath, make, env } = setup()
    const b = make(bundled, name)
    make(onPath, name)
    assert.deepEqual(findTool(name, { bundled: [bundled], env }), { name, path: b, source: 'bundled' })
  })

  test(`${name}: falls back to PATH when the bundled copy is missing`, () => {
    const { bundled, onPath, make, env } = setup()
    const p = make(onPath, name)
    assert.deepEqual(findTool(name, { bundled: [bundled], env }), { name, path: p, source: 'path' })
  })

  test(`${name}: both missing → null (the caller reports it)`, () => {
    const { bundled, env } = setup()
    assert.equal(findTool(name, { bundled: [bundled], env }), null)
  })
}

test('env override beats the bundled copy; a bogus override is ignored', () => {
  const { base, bundled, make, env } = setup()
  const b = make(bundled, 'ffmpeg')
  const customDir = path.join(base, 'custom')
  fs.mkdirSync(customDir)
  const custom = make(customDir, 'ffmpeg')
  assert.equal(findTool('ffmpeg', { bundled: [bundled], env: { ...env, RIPPER_FFMPEG: custom } }).source, 'env')
  assert.equal(findTool('ffmpeg', { bundled: [bundled], env: { ...env, RIPPER_FFMPEG: path.join(base, 'nope') } }).path, b)
})

test('non-executable bundled copy is skipped', { skip: WIN && 'no exec bit on Windows' }, () => {
  const { bundled, onPath, make, env } = setup()
  fs.chmodSync(make(bundled, 'ffmpeg'), 0o644)
  const p = make(onPath, 'ffmpeg')
  assert.equal(findTool('ffmpeg', { bundled: [bundled], env }).path, p)
})

test('bundled dirs: <resources>/engine when packaged, desktop/vendor/<tool>/<os> in dev', () => {
  assert.deepEqual(bundledDirs('ffprobe', { packaged: true, resourcesPath: '/r', env: {} }), [path.join('/r', 'engine')])
  assert.deepEqual(bundledDirs('ffprobe', { packaged: false, repoRoot: '/repo', platform: 'darwin', env: {} }),
    [path.join('/repo', 'desktop', 'vendor', 'ffmpeg', 'mac')])
  assert.deepEqual(bundledDirs('deno', { packaged: false, repoRoot: '/repo', platform: 'win32', env: {} }),
    [path.join('/repo', 'desktop', 'vendor', 'deno', 'win')])
})

test('findAll never looks for node in the bundle', () => {
  const { bundled, onPath, make, env } = setup()
  make(bundled, 'node')
  const n = make(onPath, 'node')
  const all = findAll({ bundled: [bundled], env })
  assert.equal(all.node.path, n)
  assert.equal(all.ffmpeg, null)
})
