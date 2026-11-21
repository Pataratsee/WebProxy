# WebProxy

A small, dependency-free web proxy that loads websites **inside your own site, in the same tab**.
It fetches pages on the server, rewrites links, assets, forms and scripts to route back through the
proxy, keeps a per-session cookie jar, follows redirects, and injects a navigation bar into every page.

The proxy logic lives in one module and runs in two places:

- `worker.js` — the core, exported as a Cloudflare Worker `fetch` handler (this is what is hosted)
- `server.js` — a thin Node adapter so the exact same site runs locally

## Run locally

```bash
npm start          # http://localhost:3000
PORT=8080 npm start
```

No dependencies to install — Node 18+ only.

## Hosting

Live at **https://webproxy-5ywe8a.freebuff.site** (Cloudflare Worker via Freebuff Sites).

`sites.deploy.json` describes the deployment: it uploads `worker.js` as the Worker entry point and
the contents of `public/` as static assets. The Worker serves `/`, `/style.css`, `/toolbar.js` and
`/favicon.ico` from those assets and handles `/s` (search) and `/p/<encoded-url>` (proxy) itself.

Because it is a Worker, the site is reachable from any browser with no server to keep running.

## Project files

- `worker.js` — proxy core and Cloudflare Worker entry point
- `server.js` — Node HTTP adapter around `worker.js`
- `public/index.html` — homepage / search page
- `public/style.css` — homepage styling
- `public/toolbar.js` — navigation bar injected into proxied pages
- `sites.deploy.json` — deployment manifest

## How to use

- Type a search term or paste a full URL into the box on the home page.
- Pick DuckDuckGo, Bing, or Brave for searches.
- Every link stays inside this tab. The black bar at the top of each page has back, reload, home,
  an address field, and a hide (`×`) button.

## What it handles

- Relative **and** absolute link/asset rewriting (`href`, `src`, `action`, `srcset`, `poster`, etc.)
- `url(...)` and `@import` rewriting inside CSS and inline `style` attributes
- Runtime URL shim for `fetch`, `XMLHttpRequest`, `EventSource`, `Worker` and `sendBeacon`, so
  relative URLs resolve against the original site rather than the proxy origin
- Safe ES-module rewriting (`import.meta.url` and relative module specifiers only)
- Redirects (301/302/303/307/308), including POST → GET conversion
- Cookies via a server-side, per-session jar (logins generally work)
- GET and POST form submission
- Stripping CSP / X-Frame-Options / HSTS / meta-CSP that would otherwise block content
- Neutralising service workers and `target="_blank"` so navigation stays in one tab
- A WebGPU status badge (`GPU ok` / `GPU -`) in every toolbar, with adapter details on hover
- Refusing loopback, private, link-local and cloud-metadata targets, on the first request and on
  every redirect hop

## Limitations — please read

No proxy can make **every** site work. Some sites will still be broken or degraded because:

- Heavy web apps (Google, YouTube, Facebook, Gmail, banks) rely on WebSockets, CORS,
  cross-origin iframes, and browser APIs that read `location.origin` — those are not proxied.
- Some sites detect proxies/bot user agents and block them.
- Video/audio range requests and WebRTC are not specially handled.
- Code that derives URLs from `location.origin` or `document.baseURI` still sees the proxy origin.
- Certificate-pinned or intranet-only sites won't load.

### WebGPU

WebGPU runs in **your browser**, not in the proxy, so it does not need proxy-side support.
It is available when the page is a secure context (the hosted site is HTTPS; localhost counts
as secure) and your browser/GPU supports it. The `GPU ok` badge in the toolbar confirms it.

The reason WebGPU demos failed before was that the old JavaScript rewriter corrupted their
large bundles (it rewrote innocent strings like `'/bQ`OG27VO'` into proxy URLs). Bundles are
now left byte-for-byte intact; only module specifiers and `import.meta.url` are rewritten,
and the runtime shim handles ordinary `fetch()` calls.

The hosted build also keeps its cookie jar in memory, per Worker isolate. Cloudflare can recycle an
isolate at any time, so a login on a proxied site may be dropped; the local Node server keeps
sessions until it restarts.

It works best on normal content sites: Wikipedia, news sites, blogs, docs, DDG/Bing results, etc.

## Security

Loopback, private, link-local and cloud-metadata hostnames are blocked before any fetch, including
on redirects. The hosted build has **no authentication** — anyone who has the URL can use it, so
think twice before sharing it widely. The local server is meant for personal use on your own machine.
