// Where the live board's WebSocket lives on the page's own origin. Browser-safe
// (no Node imports): the page, the Vite dev proxy and the always-on server all
// read it.
export const LIVE_SOCKET_PATH = '/live-socket'

/** `bun run live`'s default port. 8790, not 8787: the companion hub already listens on 127.0.0.1:8787. */
export const DEFAULT_LIVE_PORT = 8790
