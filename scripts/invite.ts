// Making and managing friends' invites for the hosted Sounding, from the mini.
// Justy can run these too. Talks to the relay's admin routes (src/relay) with
// the admin secret kept in ~/.config/sounding/admin-secret.
//
//   bun run invite setup --from <your name> [--site https://…] [--new-secret]
//   bun run invite new <name> [--days 7] [--minutes 60]
//   bun run invite list
//   bun run invite extend <id> [--days N] [--minutes N]
//   bun run invite revoke <id>      (and: restore <id>)
//   bun run invite release <id>     the same link works again, on a new device
//   bun run invite remove <id>      gone from the list (withdrawn, expired or used up only)
//   bun run invite admin-link       signs a phone in to the invites page (run it in your own terminal)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { InviteAdminView } from '../src/relay/relay'
import { adminLink } from '../src/admin/view'
import { carryCode as qrModules } from '../src/own/keys'

const DIR = join(homedir(), '.config', 'sounding')
const CONFIG = join(DIR, 'friends.json')
const SECRET = join(DIR, 'admin-secret')
const DEFAULT_SITE = 'https://sounding-2j1.pages.dev'

interface Config { site: string; from: string }

export function parseArgs(argv: string[]): { cmd: string; rest: string[]; flags: Record<string, string> } {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i])
    if (m) flags[m[1]] = m[2] ?? argv[++i] ?? ''
    else rest.push(argv[i])
  }
  return { cmd: rest.shift() ?? 'help', rest, flags }
}

/** One invite as a line: who, where it stands, how much of it is used, until when. */
export function line(v: InviteAdminView, now = Date.now()): string {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  const state = v.state === 'ok' ? (v.claimed ? 'in use' : 'not opened yet') : v.state
  const last = v.lastUsedAt ? `, last used ${day(v.lastUsedAt)}` : ''
  const left = v.expiresAt > now ? `until ${day(v.expiresAt)}` : `ended ${day(v.expiresAt)}`
  return `${v.id}  ${v.name.padEnd(14)} ${state.padEnd(14)} ${String(v.heardMinutes).padStart(5)} of ${v.minutes} min  $${v.spentUsd.toFixed(3)}  ${left}${last}`
}

/** A QR code for a terminal: two rows of modules to a line, in half blocks, dark on light with a quiet margin. */
export function terminalQr(modules: boolean[][]): string {
  const n = modules.length, pad = 2
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && modules[r][c]
  const lines: string[] = []
  for (let r = -pad; r < n + pad; r += 2) {
    let s = ''
    // light is drawn, dark is left blank, so the code reads on a dark terminal: ▀ is the upper light, ▄ the lower
    for (let c = -pad; c < n + pad; c++) {
      const top = !dark(r, c), bottom = !dark(r + 1, c)
      s += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(s)
  }
  return lines.join('\n')
}

function config(): Config {
  if (!existsSync(CONFIG) || !existsSync(SECRET)) throw new Error('Not set up yet: run `bun run invite setup --from <your name>` first.')
  return JSON.parse(readFileSync(CONFIG, 'utf8')) as Config
}

async function call(path: string, body?: unknown, method?: string): Promise<Record<string, unknown>> {
  const { site } = config()
  const res = await fetch(`${site}/api/admin${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${readFileSync(SECRET, 'utf8').trim()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } }
  if (!res.ok) throw new Error(`${res.status}: ${json.error?.message ?? 'the relay refused'}`)
  return json
}

async function main(argv: string[]): Promise<void> {
  const { cmd, rest, flags } = parseArgs(argv)
  const num = (k: string) => (flags[k] === undefined ? undefined : Number(flags[k]))
  switch (cmd) {
    case 'setup': {
      const from = flags.from?.trim()
      if (!from) throw new Error('Say who the invites are from: `bun run invite setup --from <your name>`.')
      mkdirSync(DIR, { recursive: true })
      writeFileSync(CONFIG, JSON.stringify({ site: flags.site ?? DEFAULT_SITE, from }, null, 2) + '\n')
      // --new-secret replaces it, for a secret that got out: then put ADMIN_SECRET on the site again
      if (!existsSync(SECRET) || flags['new-secret'] !== undefined) { writeFileSync(SECRET, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 }); chmodSync(SECRET, 0o600) }
      console.log(`Invites will say they are from ${from}, on ${flags.site ?? DEFAULT_SITE}.`)
      console.log(`The admin secret is in ${SECRET}. Give it to the site once:`)
      console.log(`  bunx wrangler@4.148.0 pages secret put ADMIN_SECRET --project-name sounding < ${SECRET}`)
      return
    }
    case 'new': {
      const name = rest.join(' ').trim()
      if (!name) throw new Error('Who is it for? `bun run invite new <name>`')
      const { site, from } = config()
      const r = (await call('/invites', { name, from, days: num('days'), minutes: num('minutes') })) as { token: string; invite: InviteAdminView }
      console.log(`${site}/#invite=${r.token}`)
      console.log(line(r.invite))
      console.log('Works on the first device that opens it. The link is shown only now.')
      return
    }
    case 'admin-link': {
      const { site } = config()
      const link = adminLink(site, readFileSync(SECRET, 'utf8').trim())
      console.log('Open this on the phone that should manage invites, or scan the code. It carries the admin secret:')
      console.log('keep it out of chats. If it ever gets out: `bun run invite setup --from <your name> --new-secret`, then put ADMIN_SECRET on the site again.\n')
      console.log(terminalQr(qrModules(link)))
      console.log(`\n${link}`)
      return
    }
    case 'list': {
      const r = (await call('/invites')) as { invites: InviteAdminView[]; month: { month: string; spentUsd: number; capUsd: number } }
      for (const v of r.invites) console.log(line(v))
      if (!r.invites.length) console.log('No invites yet.')
      console.log(`${r.month.month}: $${r.month.spentUsd.toFixed(2)} of the $${r.month.capUsd} monthly cap spent.`)
      return
    }
    case 'remove': {
      const id = rest[0]
      if (!id) throw new Error('Which invite? `bun run invite remove <id>` (ids are in `bun run invite list`)')
      await call(`/invites/${id}`, undefined, 'DELETE')
      console.log(`${id} removed.`)
      return
    }
    case 'extend': case 'revoke': case 'restore': case 'release': {
      const id = rest[0]
      if (!id) throw new Error(`Which invite? \`bun run invite ${cmd} <id>\` (ids are in \`bun run invite list\`)`)
      const body = cmd === 'extend' ? { addDays: num('days') ?? 0, addMinutes: num('minutes') ?? 0 } : { [cmd]: true }
      if (cmd === 'extend' && !body.addDays && !body.addMinutes) throw new Error('Extend by what? --days N and/or --minutes N')
      console.log(line(((await call(`/invites/${id}`, body)) as { invite: InviteAdminView }).invite))
      return
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5)).join('\n'))
  }
}

if (process.argv[1] && /invite\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e: Error) => { console.error(e.message); process.exit(1) })
}
