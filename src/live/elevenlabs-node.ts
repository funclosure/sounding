// The server's socket to ElevenLabs' live model: the key rides in a header and
// never leaves this Node process.
import WebSocket from 'ws'
import type { LiveSocket } from './elevenlabs'

export const nodeElevenSocket = (url: string, key: string): LiveSocket => new WebSocket(url, { headers: { 'xi-api-key': key } }) as unknown as LiveSocket
