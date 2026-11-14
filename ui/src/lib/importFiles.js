// What the app accepts by drag-and-drop / Browse. Mirrors engine/config.py.
export const AUDIO_EXT = ['.wav', '.mp3']
export const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv']
export const MAX_AUDIO_MB = 200
export const MAX_VIDEO_MB = 500
export const ACCEPT_ATTR = [...AUDIO_EXT, ...VIDEO_EXT].join(',')

const MB = 1024 * 1024

export function extOf(name) {
  const m = /\.[^./\\]+$/.exec(String(name || '').toLowerCase())
  return m ? m[0] : ''
}

/** Split dropped files into accepted ones and rejections with a user-facing reason. */
export function classifyFiles(files) {
  const accepted = []
  const rejected = []
  for (const file of files || []) {
    const ext = extOf(file.name)
    const video = VIDEO_EXT.includes(ext)
    if (!video && !AUDIO_EXT.includes(ext)) {
      rejected.push({ file, reason: `${file.name}: unsupported file type${ext ? ` (${ext})` : ''}. Drop WAV or MP3 audio, or an MP4, MOV, M4V, WEBM or MKV video.` })
      continue
    }
    const max = video ? MAX_VIDEO_MB : MAX_AUDIO_MB
    if (file.size > max * MB) {
      rejected.push({ file, reason: `${file.name}: ${video ? 'videos' : 'audio files'} can be at most ${max} MB.` })
      continue
    }
    accepted.push(file)
  }
  return { accepted, rejected }
}

/** True when a drag carries files from outside (not text, not one of our own drags). */
export function isExternalFileDrag(dataTransfer, draggingOut = false) {
  if (draggingOut || !dataTransfer) return false
  return Array.from(dataTransfer.types || []).includes('Files')
}
