// App + engine log files in <userData>/logs, size-rotated so they never exceed 10 MB in total:
// main.log and engine.log, each up to 2.5 MB plus one rotated .1 copy.
const fs = require('node:fs')
const path = require('node:path')

const TOTAL_MAX_BYTES = 10 * 1024 * 1024

class RotatingLog {
  constructor(file, maxBytes) {
    this.file = file
    this.maxBytes = maxBytes
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try { this.size = fs.statSync(file).size } catch { this.size = 0 }
  }

  write(line) {
    const text = `${new Date().toISOString()} ${String(line).replace(/\s+$/, '')}\n`
    try {
      if (this.size + Buffer.byteLength(text) > this.maxBytes) this.rotate()
      fs.appendFileSync(this.file, text)
      this.size += Buffer.byteLength(text)
    } catch { /* logging must never break the app */ }
  }

  rotate() {
    try { fs.renameSync(this.file, `${this.file}.1`) } catch { /* nothing to rotate */ }
    this.size = 0
  }

  /** Last n lines (reads at most the last 256 KB, then the .1 file if needed). */
  tail(n = 60) {
    const read = (f) => {
      try {
        const fd = fs.openSync(f, 'r')
        const { size } = fs.fstatSync(fd)
        const len = Math.min(size, 256 * 1024)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, size - len)
        fs.closeSync(fd)
        return buf.toString('utf8').split('\n').filter(Boolean)
      } catch { return [] }
    }
    let lines = read(this.file)
    if (lines.length < n) lines = [...read(`${this.file}.1`), ...lines]
    return lines.slice(-n)
  }
}

/** { dir, app, engine } — two logs sharing the 10 MB budget. */
function createLogs(dir, totalMax = TOTAL_MAX_BYTES) {
  const each = Math.floor(totalMax / 4) // 2 files × (current + .1)
  return { dir, app: new RotatingLog(path.join(dir, 'main.log'), each), engine: new RotatingLog(path.join(dir, 'engine.log'), each) }
}

module.exports = { RotatingLog, createLogs, TOTAL_MAX_BYTES }
