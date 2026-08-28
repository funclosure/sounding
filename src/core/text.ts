// Shared tokenization. Everything downstream (recurrence counting, token
// identity, fast-loop nudges) must agree on what a "word" is, so this is
// the single definition.

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'of', 'to', 'in',
  'on', 'at', 'for', 'with', 'about', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'im', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
  'her', 'hers', 'they', 'them', 'their', 'what', 'which', 'who', 'when',
  'where', 'why', 'how', 'not', 'no', 'yes', 'do', 'does', 'did', 'have',
  'has', 'had', 'will', 'would', 'can', 'could', 'should', 'just', 'like',
  'really', 'actually', 'maybe', 'know', 'think', 'mean', 'get', 'got',
  'going', 'go', 'thing', 'things', 'lot', 'bit', 'well', 'okay', 'ok',
  'um', 'uh', 'yeah', 'right', 'dont', 'cant', 'thats', 'there', 'here',
  'because', 'from', 'into', 'over', 'again', 'still', 'very', 'too', 'also',
  'all', 'some', 'any', 'more', 'most', 'other', 'than', 'up', 'down', 'out',
  'off', 'now', 'one', 'two', 'time', 'back', 'every',
])

export function normalizeToken(raw: string): string {
  let t = raw.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'/g, '')
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1)
  return t
}

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}
