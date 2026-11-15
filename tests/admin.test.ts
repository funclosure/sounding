// The invites page's words and sums, and the admin link that signs a phone in to it.
import { describe, it, expect } from 'vitest'
import { adminLink, inviteLine, keyIn, monthLine, stateWord } from '../src/admin/view'
import { terminalQr, parseArgs } from '../scripts/invite'
import { carryCode as qrModules } from '../src/own/keys'
import type { InviteAdminView } from '../src/relay/relay'

const invite = (o: Partial<InviteAdminView> = {}): InviteAdminView => ({
  id: 'ab12cd34', name: 'Amy', from: 'Victor', expiresAt: Date.UTC(2026, 10, 22), minutes: 60, minutesLeft: 42, state: 'ok',
  claimed: true, heardMinutes: 18, spentUsd: 0.482, createdAt: Date.UTC(2026, 10, 15), lastUsedAt: Date.UTC(2026, 10, 16), ...o,
})

describe('the invites page', () => {
  it('says where an invite stands', () => {
    expect(stateWord(invite())).toBe('in use')
    expect(stateWord(invite({ claimed: false }))).toBe('not opened yet')
    expect(stateWord(invite({ state: 'used' }))).toBe('minutes used up')
    expect(stateWord(invite({ state: 'revoked' }))).toBe('withdrawn')
    expect(stateWord(invite({ state: 'expired' }))).toBe('expired')
    expect(stateWord(invite({ state: 'cap' }))).toBe('paused: monthly cap reached')
  })
  it('puts minutes, money and dates in one line', () => {
    const now = Date.UTC(2026, 10, 17)
    expect(inviteLine(invite(), now)).toBe('18 of 60 min · $0.48 · until 22 Nov · last used 16 Nov')
    expect(inviteLine(invite({ heardMinutes: 0.5, lastUsedAt: null, expiresAt: Date.UTC(2026, 10, 16) }), now)).toBe('0.5 of 60 min · $0.48 · ended 16 Nov')
    expect(monthLine({ month: '2026-11', spentUsd: 0.019, capUsd: 10 })).toBe('November: $0.02 of the $10 monthly cap')
  })
  it('signs a device in with the secret after the #, never in the request', () => {
    const link = adminLink('https://sounding.example/', 'a+b/c=')
    expect(link).toBe('https://sounding.example/admin#key=a%2Bb%2Fc%3D')
    expect(keyIn(new URL(link).hash)).toBe('a+b/c=')
    expect(keyIn('#other')).toBeNull()
  })
})

describe('the admin link in a terminal', () => {
  it('draws the code two rows to a line, light as blocks, with a quiet margin, and nothing lost', () => {
    const modules = qrModules('https://sounding.example/admin#key=0123456789abcdef0123456789abcdef0123456789a')
    const text = terminalQr(modules)
    const lines = text.split('\n')
    const n = modules.length
    expect(lines[0]).toBe('█'.repeat(n + 4)) // the margin above the code is light
    // read the modules back out of the half blocks
    const back: boolean[][] = Array.from({ length: n + 4 + 1 }, () => [])
    lines.forEach((line, i) => [...line].forEach((ch, c) => {
      back[2 * i][c] = ch === ' ' || ch === '▄' // the upper half is dark
      back[2 * i + 1][c] = ch === ' ' || ch === '▀'
    }))
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) expect(back[r + 2][c + 2]).toBe(modules[r][c])
  })
  it('takes --new-secret as a flag', () => {
    expect(parseArgs(['setup', '--from', 'Victor', '--new-secret']).flags).toEqual({ from: 'Victor', 'new-secret': '' })
  })
})
