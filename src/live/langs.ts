// The languages the listener can be told to expect. Pure: shared by the server and the page.
// The choice is kept beside the soundings and used from the next sounding on; none saved means the server's own --lang.
export const LANGS: ReadonlyArray<{ code: string; name: string; says: string }> = [
  { code: 'en-US', name: 'English', says: 'Everything is heard as English.' },
  { code: 'zh-TW', name: '中文', says: 'Everything is heard as Chinese.' },
  { code: 'ja-JP', name: '日本語', says: 'Everything is heard as Japanese.' },
  { code: 'auto', name: 'whatever I speak', says: 'The listener works out the language itself. Less steady on short phrases.' },
]
export const isLang = (v: unknown): v is string => typeof v === 'string' && LANGS.some((l) => l.code === v)
export const langName = (code: string): string => LANGS.find((l) => l.code === code)?.name ?? code
