# Hosting the own-keys page

The own-keys page is Sounding running wholly in the browser, on the visitor's
own Claude and ElevenLabs keys (`src/own/`). It needs no server: the build is a
folder of static files. This note is how that folder goes on Cloudflare Pages.
Your mini is not part of it and keeps running as it does.

Where it lives and what address it opens at are still open on the hosting plan.
This follows the picks marked there (Cloudflare Pages, `sounding.funclosure.xyz`).
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

Checked on 15 November in Chrome, with the folder served under these headers: a
Chinese sounding (ElevenLabs hearing, Claude stood in), the wrap, saving the
picture and the text file, and reopening after a reload. Nothing was blocked.

## Deploying (you run these)

Nothing here has been run. Wrangler is not installed: `bunx` fetches the pinned
version, as Archipelago does. A Wrangler login file is already on the mini
(from Archipelago's deploys), so step 1 should just confirm the account.

1. Check the login: `bunx wrangler@4.148.0 whoami`
2. Build and deploy: `bun run deploy:own`
   The first time, Wrangler asks to create the Pages project `sounding` (say
   yes, with production branch `main`). The site is then at
   `https://sounding.pages.dev`, or a suffixed name if `sounding` is taken.
3. Check that it serves its headers:
   `curl -sI https://sounding.pages.dev | grep -i content-security`
4. Open it, paste both keys, and run a short sounding. Then the phone.

Each later `bun run deploy:own` replaces the live site. Pages keeps every
deployment, so **Deployments → Rollback** in the dashboard goes back to any
earlier one.

### The address

In the dashboard: **Workers & Pages → sounding → Custom domains → Set up a
domain**, then `sounding.funclosure.xyz`. If `funclosure.xyz` is on Cloudflare
DNS, it adds the record itself. Otherwise, add a CNAME `sounding` →
`sounding.pages.dev` where the domain's DNS lives.

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
- **ElevenLabs:** the sound while a sounding runs, on the visitor's key.
- **Anthropic:** the words heard and the wrap request, on the visitor's key.

The keys sheet says the same to the visitor before they paste anything.
