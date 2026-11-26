# Classroom Browser

A self-hosted browsing layer that keeps people **inside your own site, in the same tab**. It is not
an anonymity tool — it is just a browser that lives inside your website.

It has two modes:

- **Rewriting proxy** — fetches pages server-side, rewrites links/assets/forms/scripts back through
  the proxy, keeps a cookie jar, and injects a bottom navigation bar. Runs on both Node and the
  Cloudflare Worker.
- **Real browser mode** — runs an actual headless Chromium, streams screenshots into the page, and
  forwards mouse/keyboard input. YouTube, ChatGPT, Google and other heavy apps see a real Chrome
  browser instead of a proxy. This mode is **Node-only**.

The hosted site uses the rewriting proxy only, so it runs entirely in the browser with no local
server and no port to open. Real browser mode is an optional extra when you run the project
yourself.

The proxy logic lives in one module and runs in two places:

- `worker.js` — the core, exported as a Cloudflare Worker `fetch` handler (this is what is hosted)
- `server.js` — a Node adapter that serves the site and owns real browser mode

## Run locally

```bash
PORT=3456 npm start   # http://localhost:3456
```

No npm dependencies to install. Node **22+** is required because the server uses the built-in
`WebSocket` class. Real browser mode also needs a Chrome/Chromium binary; it is auto-detected from
Playwright's cache, `google-chrome`, or `chromium`. You can force one with:

```bash
CHROME_PATH=/path/to/chrome PORT=3456 npm start
```

Open `http://localhost:3456/b/new?url=https://www.youtube.com/` to jump straight into full browser
mode, or use the buttons on the home page.

## Browser-mode performance

Real browser mode uses Chromium's **push screencast** instead of repeatedly taking screenshots:
frames are sent only when the page actually changes, acknowledged immediately, and encoded as WebP.
The address bar/title is polled separately every 700 ms and only sent when it changes, so it does not
add a CDP round trip to every frame. In the page, frames are decoded with `createImageBitmap` and
stale queued frames are dropped instead of piling up. Resizing the tab resizes the real Chromium
window (not just the emulated viewport) and restarts screencast at the new dimensions, so every frame
arrives at exactly the canvas size. Frames are drawn with aspect ratio preserved and centred instead
of being stretched to fill, so a site never looks zoomed in or distorted.

Measured locally: first frame in ~50–460 ms. Frame gaps depend on how much the page actually
changes — static pages send almost nothing, while animating pages send frames continuously. If your
Chromium build does not support screencast, it automatically falls back to ~8 fps polling.

### WebGPU

Real browser mode launches Chromium with WebGPU enabled (`--enable-unsafe-webgpu`) and a `GPU`
badge in the browser bar shows live adapter status. It deliberately disables GPU **compositing**
while keeping WebGPU available — that combination measured much faster for screencast frames than
software compositing. GPU detection runs one second after the first frame so it never delays the
initial paint. On this machine the badge reads `GPU swiftshader`; on a machine with a real GPU it
will show that adapter instead.

Optional environment variables:

```bash
BROWSER_SCREENCAST_FORMAT=webp   # or jpeg
BROWSER_QUALITY=70               # 30-100
BROWSER_INFO_MS=700              # address-bar poll interval
BROWSER_FRAME_MS=120             # fallback poll interval
BROWSER_DISABLE_SCREENCAST=1     # force fallback mode
BROWSER_GPU=gl                   # gl (default), swiftshader, or off
BROWSER_ANGLE=gl                 # override ANGLE backend
BROWSER_GPU_COMPOSITING=1        # re-enable GPU compositing (usually slower)
BROWSER_GPU_RASTERIZATION=1      # opt into GPU rasterization
BROWSER_GPU_STATUS=0             # skip WebGPU adapter check
BROWSER_ANTI_BOT=0               # disable navigator.webdriver/chrome shims if a filter flags them
BROWSER_EXTRA_FLAGS="--flag=x"   # extra Chromium launch flags
```

## Hosting

Live at **https://webproxy-5ywe8a.freebuff.site** (Cloudflare Worker via Freebuff Sites).

`sites.deploy.json` describes the deployment: it uploads `worker.js` as the Worker entry point and
the contents of `public/` as static assets. The Worker serves `/`, `/style.css`, `/toolbar.js` and
`/favicon.ico` from those assets and handles `/s` (search) and `/p/<encoded-url>` (proxy) itself.

Because it is a Worker, the whole site is reachable from any browser with no server to keep running
and no port to open. Full browser mode on the hosted site uses **Cloudflare Browser Run**, which
provides a real remote Chrome and an interactive Live View. Add two Worker secrets to enable it:

- `CF_ACCOUNT_ID` — your Cloudflare account ID
- `CF_API_TOKEN` — an API token with **Browser Rendering - Edit** permission

With both secrets present, `/b/new` creates a browser session, navigates it to the requested URL,
and redirects to Cloudflare's Live View. If the secrets are missing or the API call fails, the site
falls back to the in-tab proxy. The Workers Free plan includes 10 browser-minutes per day; sessions
end after 10 minutes without activity. Browser Run is always identified as an automated datacenter
browser, so sites with hard bot protection may still refuse it. The local Node server remains the
option with the most control over the Chrome binary and launch flags.

## About school web filters

Some school filters (including Linewize/Family Zone) place general-purpose web proxies in a
**Proxies and VPNs** category, and content analysis can flag a page by its visible wording even when
the host has a clean reputation. This project is a real browser/proxy, so that category is not
purely a false positive. The served pages therefore use neutral educational branding and avoid
"VPN", "unblock" or "bypass" language, and the optional `BROWSER_ANTI_BOT=0` switch can remove
Chromium automation shims if a filter flags them.

No site-side change can reliably defeat an explicitly blocked domain, locked policy, TLS inspection,
or network-level enforcement. The reliable path is to have a teacher or administrator request a
category reclassification and a narrow allow rule for the exact hostname. A stable owned domain with
visible educational sponsorship and a valid HTTPS certificate helps more than a free random
subdomain. Attempting to evade a school filter may also violate acceptable-use policies and is
logged by the filter.

## Project files

- `worker.js` — proxy core and Cloudflare Worker entry point
- `server.js` — Node HTTP adapter around `worker.js`, plus the browser-mode routes
- `browser.js` — Node-only Chromium/CDP real browser mode with screenshot streaming and input forwarding
- `public/index.html` — homepage / search page
- `public/style.css` — homepage styling
- `public/toolbar.js` — navigation bar injected into proxied pages
- `sites.deploy.json` — deployment manifest

## How to use

- Type a search term or paste a full URL into the box on the home page.
- For YouTube, ChatGPT, Google or any site that breaks in rewriting mode, click **Open Full
  Browser** on the home page. The canvas fills the **entire tab** with no margins, and the headless
  Chromium window is resized so its viewport matches your screen exactly. Every frame is drawn at a
  1:1 size with the canvas — no stretching, no upscaling, no letterboxing — so sites look the same
  size as they would in a normal browser. The toolbar auto-hides at the bottom so it does
  not cover site controls — move the mouse to the bottom edge to bring it back, or use the
  fullscreen button to fill the physical screen. Click the canvas first, then type — keystrokes go
  to the real browser.
- Searches return a **results page hosted by the proxy itself** (DuckDuckGo or Bing), with title,
  URL and snippet for each hit. Clicking a result opens it through the proxy.
- Every link stays inside this tab. The black bar at the **bottom** of each page has back, reload,
  home, an address field, and a hide (`×`) button. It sits at the bottom so it cannot cover a site's
  own top navigation or buttons.

## What it handles

- Relative **and** absolute link/asset rewriting (`href`, `src`, `action`, `srcset`, `poster`, etc.)
  — performed **only inside real HTML tags**, never inside `<script>` bodies. This was the main
  cause of "the page loads but its buttons/functions do not work": a document-wide `src=` rewrite
  was corrupting minified JavaScript such as `f.src=h,f.handler=h,...`.
- `url(...)` and `@import` rewriting inside CSS and inline `style` attributes
- Runtime URL shim for `fetch`, `XMLHttpRequest`, `EventSource`, `Worker`, `sendBeacon`,
  `import()`, DOM `src`/`href` assignments, `setAttribute` and inline CSS `url(...)`, so all URLs
  resolve against the original site rather than the proxy origin (this also avoids browser CORS
  failures for API calls)
- **WebSocket proxying** through `/ws/<encoded-url>`, so live chat, notifications and other
  real-time features can connect (verified end-to-end in the browser)
- **Origin emulation**: page code reading `location.href`, `location.origin`, `location.pathname`,
  `window.location`, `document.location`, `document.baseURI` or `document.URL` gets the original
  site's values instead of the proxy's. Assignments to `location.href` still navigate through the
  proxy.
- SPA history support: `history.pushState`/`replaceState` URLs are mapped back to `/p/...` so
  in-app routing and reloads keep working
- Per-site `localStorage`/`sessionStorage` namespacing, so different sites no longer share (and
  overwrite) each other's stored state
- `document.cookie` emulation, synced to the server-side jar, so JavaScript can read and write
  cookies (CSRF tokens, session helpers, etc.)
- Safe ES-module rewriting: `import.meta.url` resolves to the **module's** real URL, static and
  dynamic imports are routed through the proxy, and string literals are never rewritten
- Redirects (301/302/303/307/308), including POST → GET conversion
- Cookies via a server-side, per-session jar (logins generally work)
- GET and POST form submission
- Stripping CSP / X-Frame-Options / HSTS / meta-CSP that would otherwise block content
- Neutralising service workers and `target="_blank"` so navigation stays in one tab
- A WebGPU status badge (`GPU ok` / `GPU -`) in every toolbar, with adapter details on hover
- Browser-style request headers (Chrome user agent, client hints, realistic referer, origin and
  cache headers). `Sec-Fetch-*` headers are deliberately omitted: they trigger bot checks on some
  sites and do not help against real fingerprinting.
- A search results page generated by the proxy from DuckDuckGo or Bing (with automatic fallback),
  with tracker redirect links decoded to the real destination URLs
- A visible notice when a site serves an anti-bot challenge, with a link to the original site
- Refusing loopback, private, link-local and cloud-metadata targets, on the first request and on
  every redirect hop

## Limitations — please read

No proxy can make **every** site work. Some sites will still be broken or degraded because:

- In rewriting mode, heavy web apps (Google, YouTube, Facebook, Gmail, banks) rely on cross-origin
  iframes, service workers, extension-level APIs and browser-level features that cannot be fully
  emulated. Use **real browser mode** for those sites; the WebSocket bridge helps, but does not fix,
  rewriting mode's fundamental limits.
- Some sites block the rewriting proxy using TLS/HTTP2 fingerprinting, JavaScript challenges, or
  the fact that the hosted Worker runs from a datacenter IP range. Changing headers cannot fix any
  of those. Real browser mode avoids the *rewriting-proxy* fingerprint, but it still runs from this
  machine's IP and advanced anti-bot systems can still detect headless Chrome. Nothing here can
  honestly guarantee that *every* site loads.
- Sites with hard bot protection (banks, Gmail, streaming, many social networks) will still resist.
  When that happens the proxy now shows a banner explaining it, with a link to the original site.
- Video/audio range requests and WebRTC are not specially handled.
- Browser extensions, native messaging and anything that inspects the TLS connection cannot be
  reproduced behind a proxy.
- Certificate-pinned or intranet-only sites won't load.

### WebGPU

WebGPU runs in **your browser**, not in the proxy, so it does not need proxy-side support.
It is available when the page is a secure context (the hosted site is HTTPS; localhost counts
as secure) and your browser/GPU supports it. The `GPU ok` badge in the toolbar confirms it.

WebGPU demos previously failed because the old rewriter corrupted large bundles (it rewrote
innocent strings like `'/bQ`OG27VO'` into proxy URLs). The rewriter now only touches safe
JavaScript syntax (module specifiers, `import.meta.url`, `location` reads and `import()` calls),
never arbitrary strings. The runtime shim handles ordinary `fetch()` calls.

The hosted build also keeps its cookie jar in memory, per Worker isolate. Cloudflare can recycle an
isolate at any time, so a login on a proxied site may be dropped; the local Node server keeps
sessions until it restarts.

It works best on normal content sites: Wikipedia, news sites, blogs, docs, DDG/Bing results, etc.

## Security

The **rewriting proxy** blocks loopback, private, link-local and cloud-metadata hostnames before
any fetch, including on redirects. The hosted build has **no authentication** — anyone who has the
URL can use it, so think twice before sharing it widely.

Real browser mode is different: it is an actual browser and can reach whatever that machine can
reach, including localhost. Keep the Node server bound to your own machine/network and do not expose
`/b/new` publicly without authentication. It is meant for personal use.
