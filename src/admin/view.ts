// The invites page's words and sums, without the page: what state an invite is
// in, the line under its name, and the address that signs this device in.
import type { InviteAdminView } from '../relay/relay'

/** Where an invite stands, said plainly. */
export function stateWord(v: Pick<InviteAdminView, 'state' | 'claimed'>): string {
  switch (v.state) {
    case 'ok': return v.claimed ? 'in use' : 'not opened yet'
    case 'used': return 'minutes used up'
    case 'expired': return 'expired'
    case 'revoked': return 'withdrawn'
    case 'cap': return 'paused: monthly cap reached'
  }
}

const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const minutes = (m: number) => (Number.isInteger(m) ? String(m) : m.toFixed(1))

/** The line under an invite's name: minutes, money, dates. */
export function inviteLine(v: InviteAdminView, now = Date.now()): string {
  const parts = [`${minutes(v.heardMinutes)} of ${v.minutes} min`, `$${v.spentUsd.toFixed(2)}`, v.expiresAt > now ? `until ${day(v.expiresAt)}` : `ended ${day(v.expiresAt)}`]
  if (v.lastUsedAt) parts.push(`last used ${day(v.lastUsedAt)}`)
  return parts.join(' · ')
}

/** The month's line: what all invites have spent against the cap. */
export function monthLine(m: { month: string; spentUsd: number; capUsd: number }): string {
  const name = new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })
  return `${name}: $${m.spentUsd.toFixed(2)} of the $${m.capUsd} monthly cap`
}

/** The address that signs a device in to this page: the admin secret rides after the #, never sent to the site. */
export const adminLink = (site: string, secret: string): string => `${site.replace(/\/+$/, '')}/admin#key=${encodeURIComponent(secret)}`

/** The admin secret in a page's address, if it arrived there. */
export const keyIn = (hash: string): string | null => new URLSearchParams(hash.replace(/^#/, '')).get('key') || null
