// The invites page (/admin on the hosted site): make an invite and hand its
// link over, see what each one has used, extend, withdraw or release it. It
// talks to the relay's admin routes (src/relay) with the admin secret, which
// this device keeps once it has been signed in from `bun run invite admin-link`.
import { carryCode as qrModules } from '../own/keys'
import type { InviteAdminView } from '../relay/relay'
import { inviteLine, keyIn, monthLine, stateWord } from './view'

const STORE = 'sounding.admin.key'
const FROM = 'sounding.admin.from'
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const said = $('said')

// The secret can arrive after the # of the admin link. It is taken out of the address before anything else.
const arrived = keyIn(location.hash)
if (location.hash) history.replaceState(null, '', location.pathname)
function secret(): string { try { return localStorage.getItem(STORE) ?? '' } catch { return '' } }
function keep(s: string, key = STORE): void { try { if (s) localStorage.setItem(key, s); else localStorage.removeItem(key) } catch { /* a private window keeps nothing */ } }
function kept(key: string): string { try { return localStorage.getItem(key) ?? '' } catch { return '' } }
if (arrived) keep(arrived)

class Refused extends Error {}
async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${secret()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (res.status === 401) throw new Refused('not signed in')
  if (!res.ok) throw new Error(json.error?.message ?? `the relay answered ${res.status}`)
  return json
}

function show(signedIn: boolean) {
  $('signin').hidden = signedIn
  for (const id of ['make', 'list', 'foot']) $(id).hidden = !signedIn
}

let invites: InviteAdminView[] = []
let sure = '' // an action waiting for its second tap: "<id>:revoke" or "<id>:release"

async function load() {
  try {
    const r = await call<{ invites: InviteAdminView[]; month: { month: string; spentUsd: number; capUsd: number } }>('/invites')
    invites = r.invites
    $('month').textContent = monthLine(r.month)
    // who invites are from: as this device last said, or as the newest invite says
    const from = $<HTMLInputElement>('from')
    if (!from.value) from.value = kept(FROM) || invites[0]?.from || ''
    show(true)
    render()
  } catch (e) {
    if (e instanceof Refused) { show(false); if (secret()) $('signin-said').textContent = 'That secret was not accepted. Make a new admin link on the mini.'; return }
    said.textContent = `Could not reach the invites: ${(e as Error).message}`
  }
}

function button(label: string, act: string, id: string, quiet = true): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `act${quiet ? ' quiet' : ''}${sure === `${id}:${act}` ? ' sure' : ''}`
  b.dataset.act = act
  b.dataset.id = id
  b.textContent = sure === `${id}:${act}` ? (act === 'revoke' ? 'tap again to withdraw' : 'tap again: the old device loses it') : label
  return b
}

function render() {
  const rows = $('rows')
  rows.replaceChildren()
  $('empty').hidden = invites.length > 0
  for (const v of invites) {
    const li = document.createElement('li')
    const top = document.createElement('div'); top.className = 'top'
    const who = document.createElement('span'); who.className = 'who'; who.textContent = v.name
    const state = document.createElement('span'); state.className = `state${v.state === 'ok' && v.claimed ? ' on' : ''}`; state.textContent = stateWord(v)
    top.append(who, state)
    const line = document.createElement('div'); line.className = 'line'; line.textContent = inviteLine(v)
    const acts = document.createElement('div'); acts.className = 'acts'
    acts.append(button('+7 days', 'days', v.id, false), button('+30 min', 'minutes', v.id, false))
    if (v.state === 'revoked') acts.append(button('restore', 'restore', v.id))
    else acts.append(button('withdraw', 'revoke', v.id))
    if (v.claimed) acts.append(button('release', 'release', v.id))
    li.append(top, line, acts)
    rows.append(li)
  }
}

$('rows').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
  if (!b) return
  const { act, id } = b.dataset as { act: string; id: string }
  // withdrawing and releasing ask twice
  if ((act === 'revoke' || act === 'release') && sure !== `${id}:${act}`) { sure = `${id}:${act}`; return render() }
  sure = ''
  const body = act === 'days' ? { addDays: 7 } : act === 'minutes' ? { addMinutes: 30 } : { [act]: true }
  b.disabled = true
  try {
    const r = await call<{ invite: InviteAdminView }>(`/invites/${id}`, body)
    invites = invites.map((v) => (v.id === id ? r.invite : v))
    said.textContent = ''
    render()
  } catch (err) { said.textContent = (err as Error).message; b.disabled = false }
})

$('new-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = $<HTMLInputElement>('name').value.trim()
  if (!name) return
  const btn = $<HTMLButtonElement>('make-btn')
  btn.disabled = true
  try {
    const from = $<HTMLInputElement>('from').value.trim()
    keep(from, FROM)
    const r = await call<{ token: string; invite: InviteAdminView }>('/invites', {
      name, from,
      days: Number($<HTMLInputElement>('days').value) || undefined,
      minutes: Number($<HTMLInputElement>('minutes').value) || undefined,
    })
    shown(name, `${location.origin}/#invite=${r.token}`)
    $<HTMLInputElement>('name').value = ''
    invites = [r.invite, ...invites]
    render()
    void load() // the month's line
  } catch (err) { said.textContent = (err as Error).message }
  finally { btn.disabled = false }
})

/** A link just made: as text to select, to copy, to hand to the phone's share sheet, or as a code to scan. */
function shown(name: string, url: string) {
  $('made').hidden = false
  $('made-name').textContent = name
  $('made-link').textContent = url
  const acts = $('made-acts')
  acts.replaceChildren()
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'act'; copy.textContent = 'copy'
  copy.onclick = () => navigator.clipboard.writeText(url).then(() => { copy.textContent = 'copied' }, () => { copy.textContent = 'select it above' })
  acts.append(copy)
  if (typeof navigator.share === 'function') {
    const share = document.createElement('button'); share.type = 'button'; share.className = 'act'; share.textContent = 'share'
    share.onclick = () => { void navigator.share({ title: 'Sounding', text: `An invitation to try Sounding, for ${name}`, url }).catch(() => {}) }
    acts.append(share)
  }
  const code = document.createElement('button'); code.type = 'button'; code.className = 'act'; code.textContent = 'show as a code'
  code.onclick = () => { $('made-code').hidden = !$('made-code').hidden; if (!$('made-code').hidden) draw(url) }
  acts.append(code)
  $('made-code').hidden = true
}

/** The link as a QR code: dark on light whatever the page's look, with a quiet margin, as phone cameras read best. */
function draw(url: string) {
  const m = qrModules(url), n = m.length, size = n + 8
  const c = $<HTMLCanvasElement>('made-canvas')
  c.width = size; c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size)
  g.fillStyle = '#000000'
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (m[r][k]) g.fillRect(k + 4, r + 4, 1, 1)
}

$('signin-form').addEventListener('submit', (e) => {
  e.preventDefault()
  keep($<HTMLInputElement>('secret').value.trim())
  $<HTMLInputElement>('secret').value = ''
  $('signin-said').textContent = ''
  void load()
})
$('forget').addEventListener('click', () => { keep(''); invites = []; $('made').hidden = true; show(false); $('month').textContent = '' })

// an admin link opened in a tab already showing this page changes only the #
addEventListener('hashchange', () => {
  const k = keyIn(location.hash)
  history.replaceState(null, '', location.pathname)
  if (k) { keep(k); $('signin-said').textContent = ''; void load() }
})

if (secret()) void load()
else show(false)
