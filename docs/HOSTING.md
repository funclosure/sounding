# Hosting the own-keys page

The own-keys page is Sounding running wholly in the browser, on the visitor's
own Claude and ElevenLabs keys (`src/own/`). It needs no server: the build is a
folder of static files. This note is how that folder goes on Cloudflare Pages.
Your mini is not part of it and keeps running as it does.

It lives on Cloudflare Pages at https://sounding-2j1.pages.dev/, and can be
given `sounding.funclosure.xyz` (below).
Moving later is cheap: the folder is plain files, and Netlify reads the same
`_headers` file.

## What is built

`bun run build:own` writes `dist-own/`:

- `index.html` and `live.html`: the same page (the bare address opens it).
- `assets/`: the script, the styles, and the Chinese script tables (1.2 MB,
  fetched only when Chinese is the listening language).
- `_headers`: the security headers, written by `src/own/site-headers.ts` on
  every build. It is not kept by hand.

### What `_headers` sets

The page keeps both keys in the visitor's `localStorage`, so the headers make
sure that only the site's own code ever runs next to them:

- **Content-Security-Policy.** Only the site's own scripts run, plus the one
  inline script in `live.html` (it sets the light or dark look before first
  paint), allowed by its hash. That hash is worked out from the built page each
  time. The page can reach only itself, `api.anthropic.com` and
  `api.elevenlabs.io`. No framing, no plug-ins, no form posts.
- `Permissions-Policy`: the microphone for this site only; no camera, no location.
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Opener-Policy: same-origin`.
- `X-Robots-Tag: noindex, nofollow`, while the site is for you alone. When it
  opens to other people, build with `siteHeaders(html, { noindex: false })`.
- Files under `/assets/` carry their content hash in the name, so they are
  cached for good.

Checked on 15 November in Chrome, with the folder served under these headers
(and again on the live site after the first deploy): a
Chinese sounding (ElevenLabs hearing, Claude stood in), the wrap, saving the
picture and the text file, and reopening after a reload. Nothing was blocked.

## Deploying (you run these)

First deployed on 15 November 2026 at **https://sounding-2j1.pages.dev/**
(`sounding.pages.dev` was already someone else's). Wrangler is not installed:
`bunx` fetches the pinned version, and the login is the one Archipelago's
deploys left on the mini.

To deploy again, from the repo, with `main` checked out:

    bun run deploy:own

Then check that it serves its headers:
`curl -sI https://sounding-2j1.pages.dev | grep -i content-security`

### How the project was made, if it ever has to be made again

Wrangler 4.148 hands `pages project create` to Cloudflare's newer Workers
setup, which tries to turn the repo into a Workers project: it adds
`wrangler` and `@cloudflare/vite-plugin`, rewrites `package.json` and
`vite.config.ts`, and then fails on this repo's Vite config. `--force` makes a
plain Pages project instead, and running it from an empty folder (`--cwd`)
keeps it away from the repo:

    mkdir -p /tmp/empty && bunx wrangler@4.148.0 pages project create sounding --production-branch main --force --cwd /tmp/empty

Once the project exists, Wrangler deploys to it directly. If a deploy ever
starts installing packages or changing files, stop it and run
`git checkout -- package.json vite.config.ts bun.lock` and a fresh
`bun install --frozen-lockfile`.

Each later `bun run deploy:own` replaces the live site. Pages keeps every
deployment, so **Deployments → Rollback** in the dashboard goes back to any
earlier one.

### The address

In the dashboard: **Workers & Pages → sounding → Custom domains → Set up a
domain**, then `sounding.funclosure.xyz`. If `funclosure.xyz` is on Cloudflare
DNS, it adds the record itself. Otherwise, add a CNAME `sounding` →
`sounding-2j1.pages.dev` where the domain's DNS lives.

### For you alone, if you want it shut

`noindex` keeps the address out of search but does not lock it. To lock it, put
a Cloudflare Access application (Zero Trust → Access → Applications, type
*self-hosted*) on the address that allows only your own email. Remove it when
the site opens.

### Taking it down

`bunx wrangler@4.148.0 pages project delete sounding` removes the project and
every deployment of it.

## What reaches whom

- **Cloudflare:** the request for the page and its files, the way any host sees
  visits. Web Analytics is not switched on.
- **The visitor's browser:** both keys and every sounding (IndexedDB). Nothing
  is sent back to the site.
- **ElevenLabs:** the sound while a sounding runs, on the visitor's key. A
  pasted key is checked by asking for a single-use token, which costs nothing.
- **Anthropic:** the words heard and the wrap request, on the visitor's key. A
  pasted key is checked with one message answered in one token, on the model
  the marks use, so that an account with no credit is caught at setup. It
  costs a few millionths of a dollar.

The setup says the same to the visitor before they paste anything.

Friends you invite use the same site on your keys instead of their own,
through a relay at `/api` on the site: see `docs/FRIENDS.md`.

### Carrying the keys to a phone

Once both keys are in, the keys sheet can show a QR code holding the site's
address with both keys after the `#`. A browser never sends the part after `#`
to the site, so the keys go from one screen to the other through the camera
only. The page that opens takes them out of its address before anything else
runs (`src/own/keys.ts`, `takeCarried`), and keeps them only after the visitor
says they are theirs, since whoever makes such a link chooses whose accounts
hear them. The code closes by itself after two minutes: anyone who
photographs it has both keys.
