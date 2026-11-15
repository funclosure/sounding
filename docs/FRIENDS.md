# Inviting friends

A friend you invite uses the hosted page (https://sounding-2j1.pages.dev/) on
your Anthropic and ElevenLabs keys, with nothing to set up: they open your link,
read what happens to their sound and words, and accept. This is the first place
Sounding spends your API money on someone else, so every invite is capped and
all of them together stop at a monthly cap.

## How it works

- **The link.** `https://sounding-2j1.pages.dev/#invite=…`. The invite rides
  after the `#`, which a browser never sends to the site, and the page takes it
  out of its address as soon as it loads. Send it privately: until it is
  accepted, whoever opens it first gets it.
- **First device only.** Accepting trades the link for a secret kept on that
  device. The same link opened anywhere else says it was already accepted.
  If a friend's browser forgets it, `release` lets the link be accepted again.
- **The relay.** A Cloudflare Pages Function beside the site
  (`functions/api/[[route]].ts`, code in `src/relay/relay.ts`). Your keys live
  there as secrets and never reach a browser. It passes on only Sounding's own
  requests: the marks and the wrap (each checked against its own system prompt
  and answer shape), a single-use token for live hearing, and one utterance at
  a time for the kept text. An invite cannot be used as a general key.
- **Limits.** Each invite has an end date and minutes of talk (defaults: 7 days,
  60 minutes). All invites together stop at $10 a month (`MONTH_CAP_USD`).
  Claude's cost is counted exactly from each answer. ElevenLabs is counted from
  the talk the file model heard, plus an allowance for the live model, which
  also streams pauses.
- **What you see.** Names, minutes used, dollars spent, last use. Never what
  anyone said: the relay keeps no words and no sound, and the friend's
  soundings stay in their own browser.
- **What reaches whom.** The friend's sound goes to ElevenLabs and their words
  to Anthropic, on your accounts, under those companies' terms. The invite
  sheet tells them so before they accept.

About $1.60 per friend-hour on Sonnet: $1.19 for the marks, a few cents for the
wrap, about $0.40 for hearing.

## Setting it up (you run these, once)

Run the commands that take a key **in your own terminal on the mini**, not with
`!` in a Claude pane: Wrangler asks for the value, and a key typed or piped
there would end up in the conversation.

1. **Two keys just for friends**, so their limits cover only invites:
   - Anthropic: on platform.claude.com, make a workspace called
     *Sounding friends*. If the console offers a spend limit for the workspace,
     set it a little above the monthly cap (say $15). Then **API keys → Create
     key** in that workspace.
   - ElevenLabs: **Developers → API Keys → Create API Key**, named
     *Sounding friends*. Keep **Restrict Key** on, give **Speech to Text**
     access only, and set a monthly **Credit Limit**.
2. **The database**, from the repo:

       bunx wrangler@4.148.0 d1 create sounding-friends
       bunx wrangler@4.148.0 d1 execute sounding-friends --remote --file src/relay/schema.sql

3. **Bind it to the site.** Cloudflare dashboard → Workers & Pages → sounding →
   Settings → Bindings → Add → D1 database: variable name `DB`, database
   `sounding-friends`. While there, under Runtime → Compatibility flags, add
   `nodejs_compat`: Wrangler bundles a few Node shims with the function.
4. **The secrets.** First make the admin secret and say who invites are from:

       bun run invite setup --from "Your name"

   Then, in your own terminal:

       bunx wrangler@4.148.0 pages secret put ANTHROPIC_API_KEY --project-name sounding
       bunx wrangler@4.148.0 pages secret put ELEVENLABS_API_KEY --project-name sounding
       bunx wrangler@4.148.0 pages secret put ADMIN_SECRET --project-name sounding < ~/.config/sounding/admin-secret

   `MONTH_CAP_USD` is optional (10 if unset).
5. **Deploy**, so the function and its bindings go live:

       git pull && bun install --frozen-lockfile && bun run deploy:own

Until steps 2 to 4 are done, the site works as before and an invite link says
the site is not taking invitations.

## Making and managing invites

From the repo on the mini (Justy can run these for you):

    bun run invite new "Amy"                       # 7 days, 60 minutes
    bun run invite new "Ben" --days 14 --minutes 120
    bun run invite list                            # who, state, minutes, dollars, this month's total
    bun run invite extend <id> --days 7            # and/or --minutes 30
    bun run invite revoke <id>                     # and: restore <id>
    bun run invite release <id>                    # the same link works again, on a new device

`new` prints the link once; only its hash is kept. The admin secret and the
"from" name live in `~/.config/sounding/` on the mini, not in the repo.

## Taking it down

Remove the `DB` binding, or the secrets, and deploy again: invite links then
say the site is not taking invitations. `bunx wrangler@4.148.0 d1 delete
sounding-friends` removes the database.
