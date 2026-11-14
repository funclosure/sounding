export type TranscriberState = 'connecting' | 'listening' | 'reconnecting' | 'error'
export interface TranscriberCallbacks {
  onInterim(text: string): void
  onFinal(text: string): void
  onStatus(state: TranscriberState, message?: string): void
}
export interface Transcriber {
  /** true when interim text comes from a rougher source than the finals do: it may be shown but never kept, so every long run must end in a final. */
  readonly roughInterims?: boolean
  connect(cbs: TranscriberCallbacks): Promise<void>
  sendAudio(pcm: Int16Array): void
  end(): Promise<void>
  /** Words the speaker has since spelled out (a renamed mark). Optional: only transcribers that can take vocabulary mid-session implement it. */
  addVocabulary?(words: string[]): void
}
