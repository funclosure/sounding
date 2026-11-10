export type TranscriberState = 'connecting' | 'listening' | 'reconnecting' | 'error'
export interface TranscriberCallbacks {
  onInterim(text: string): void
  onFinal(text: string): void
  onStatus(state: TranscriberState, message?: string): void
}
export interface Transcriber {
  connect(cbs: TranscriberCallbacks): Promise<void>
  sendAudio(pcm: Int16Array): void
  end(): Promise<void>
  /** Words the speaker has since spelled out (a renamed mark). Optional: only transcribers that can take vocabulary mid-session implement it. */
  addVocabulary?(words: string[]): void
}
