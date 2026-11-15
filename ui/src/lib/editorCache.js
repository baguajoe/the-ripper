// Per track + source editor state kept for the app session (Editor <-> Stems navigation), and
// primed when a session file is opened. Key: `${trackId}:${source}`.
export const sessionCache = new Map()
