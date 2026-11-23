/*
 * WebProxy core.
 *
 * A dependency-free web proxy: it fetches pages on the server, rewrites
 * links/assets/scripts so navigation stays on this origin, keeps a
 * per-session cookie jar, follows redirects, and injects a navigation bar.
 *
 * The same module runs as a Cloudflare Worker (the default export) and under
 * Node via server.js, which adapts node:http to this fetch handler.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 12;
const TIMEOUT_MS = 30000;
const MAX_SESSIONS = 2000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// sid -> Map<"domain|path|name", cookie>. In-memory: per process on Node,
// per isolate on Workers (Cloudflare may recycle isolates, so upstream logins
// are best-effort on the hosted site).
const sessions = new Map();

/* ------------------------------------------------------------------ */
/* Cookie jar                                                          */
/* ------------------------------------------------------------------ */

function getSession(request) {
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(request.headers.get('cookie') || '');
  const existing = match && match[1];
  if (existing && sessions.has(existing)) return { jar: sessions.get(existing), setCookie: null };

  const sid = globalThis.crypto.randomUUID().replace(/-/g, '');
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const jar = new Map();
  sessions.set(sid, jar);

  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return { jar, setCookie: 'sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax' + secure };
}

function storeCookies(jar, setCookieHeaders, defaultDomain) {
  for (const raw of setCookieHeaders) {
    const parts = String(raw).split(';').map((p) => p.trim());
    const first = parts.shift();
    const idx = first.indexOf('=');
    if (idx < 0) continue;

    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!name) continue;

    let domain = defaultDomain.toLowerCase();
    let path = '/';
    let expires = Infinity;

    for (const part of parts) {
      const eq = part.indexOf('=');
      const key = (eq >= 0 ? part.slice(0, eq) : part).toLowerCase();
      const val = eq >= 0 ? part.slice(eq + 1) : '';
      if (key === 'domain') domain = val.replace(/^\./, '').toLowerCase();
      else if (key === 'path') path = val || '/';
      else if (key === 'expires') {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t;
      } else if (key === 'max-age') {
        const n = parseInt(val, 10);
        if (!Number.isNaN(n)) expires = Date.now() + n * 1000;
      }
    }

    const key = domain + '|' + path + '|' + name;
    if (expires <= Date.now()) jar.delete(key);
    else jar.set(key, { name, value, domain, path, expires });
  }
}

function buildCookieHeader(jar, hostname, pathname) {
  const now = Date.now();
  const out = [];
  for (const [key, cookie] of jar) {
    if (cookie.expires <= now) {
      jar.delete(key);
      continue;
    }
    const host = hostname.toLowerCase();
    const domainOk = host === cookie.domain || host.endsWith('.' + cookie.domain);
    const pathOk = pathname === cookie.path ||
                   pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/') ||
                   cookie.path === '/';
    if (domainOk && pathOk) out.push(cookie.name + '=' + cookie.value);
  }
  return out.join('; ');
}

/* ------------------------------------------------------------------ */
/* Target safety                                                       */
/* ------------------------------------------------------------------ */

const PRIVATE_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal|metadata\.goog)$/i;

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    a >= 224;
}

// Refuse loopback/private/link-local targets. Cloudflare also blocks these at
// the network level; this keeps the check explicit (and covers Node).
function isBlockedTarget(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (_) {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (PRIVATE_HOST_RE.test(host)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^(?:fc|fd|fe80|::ffff:)/.test(host);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* URL rewriting                                                       */
/* ------------------------------------------------------------------ */

const SAFE_SCHEMES = /^(#|data:|javascript:|mailto:|tel:|about:|blob:|chrome:|edge:|view-source:)/i;

function proxyUrl(absolute) {
  return '/p/' + encodeURIComponent(absolute);
}

function safeUrl(value, baseUrl) {
  const v = String(value).trim();
  if (!v || SAFE_SCHEMES.test(v)) return null;
  try {
    const absolute = new URL(v, baseUrl);
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
    return proxyUrl(absolute.href);
  } catch (_) {
    return null;
  }
}

const URL_ATTRS = 'href|src|action|poster|data|cite|background|formaction|manifest|lowsrc|classid|codebase';
const URL_ATTR_RE = new RegExp('(\\b(?:' + URL_ATTRS + ')\\s*=\\s*)(?:(["\\\'])([^"\\\']*)\\2|([^\\s>]+))', 'gi');

function rewriteCssUrls(css, baseUrl) {
  return css
    .replace(/\burl\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi, (m, q, val) => {
      const r = safeUrl(val, baseUrl);
      return r ? 'url(' + q + r + q + ')' : m;
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, val) => {
      const r = safeUrl(val, baseUrl);
      return r ? '@import ' + q + r + q : m;
    });
}

function toolbarScript(pageUrl, session) {
  const u = new URL(pageUrl);
  const cookies = session ? buildCookieHeader(session.jar, u.hostname, u.pathname) : '';
  return '<script>window.__WB_REAL_BASE = ' + JSON.stringify(pageUrl) +
         ';window.__WB_COOKIES = ' + JSON.stringify(cookies) + ';</script>\n' +
         '<script src="/toolbar.js"></script>\n';
}

function toolbarHtml() {
  const btn = 'display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;' +
              'background:#2b2f3a;color:#e8eaf0;border:1px solid #3c414f;border-radius:5px;' +
              'cursor:pointer;font-size:14px;flex:none;';
  return '<div id="__wb_bar" style="position:fixed;bottom:0;left:0;right:0;height:40px;' +
    'display:flex;align-items:center;gap:6px;padding:0 8px;background:#171a21;color:#e8eaf0;' +
    'z-index:2147483647;font:13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.35);">' +
    '<span style="font-weight:700;letter-spacing:.5px;color:#7aa2ff;flex:none;">WB</span>' +
    '<span id="__wb_gpu" title="WebGPU status" style="font-size:11px;color:#8b93a7;flex:none;">GPU ?</span>' +
    '<button id="__wb_back" title="Back" style="' + btn + '">&#8592;</button>' +
    '<button id="__wb_reload" title="Reload" style="' + btn + '">&#8635;</button>' +
    '<button id="__wb_home" title="Home" style="' + btn + '">&#8962;</button>' +
    '<form id="__wb_form" style="display:flex;flex:1;gap:6px;min-width:0;">' +
    '<input id="__wb_input" autocomplete="off" spellcheck="false" ' +
    'style="flex:1;min-width:0;height:26px;padding:0 9px;background:#0f1117;color:#e8eaf0;' +
    'border:1px solid #3c414f;border-radius:5px;outline:none;font:inherit;">' +
    '<button type="submit" style="' + btn + 'width:auto;padding:0 12px;">Go</button>' +
    '</form>' +
    '<button id="__wb_hide" title="Hide bar" style="' + btn + '">&#215;</button>' +
    '</div>';
}

function injectToolbar(html, pageUrl, session) {
  let out = html;

  // Neutralise meta CSP and base tags which would break rewriting / inline scripts.
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/\btarget\s*=\s*(["']?)_blank\1/gi, 'target="_self"');

  const script = toolbarScript(pageUrl, session);
  const bar = toolbarHtml();
  // Keep the fixed toolbar from covering a site's own top controls.
  const spacer = '<style id="__wb_spacer">html{scroll-padding-bottom:44px}body{padding-bottom:44px!important}</style>\n';

  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + script + spacer);
  else out = script + spacer + out;

  if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, (m) => m + bar);
  else out = bar + out;

  return out;
}

function rewriteAttrs(tag, pageUrl) {
  // SRI hashes describe the ORIGINAL bytes of a file. This proxy rewrites
  // module specifiers and import.meta.url, so the hash no longer matches and
  // the browser silently refuses to run or apply the resource.
  tag = tag.replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  tag = tag.replace(URL_ATTR_RE, (m, prefix, quote, quoted, unquoted) => {
    const value = decodeEntities(quote ? quoted : unquoted);
    const rewritten = safeUrl(value, pageUrl);
    if (!rewritten) return m;
    return quote ? prefix + quote + rewritten + quote : prefix + '"' + rewritten + '"';
  });

  tag = tag.replace(/\b(srcset|imagesrcset)\s*=\s*(["'])([^"']*)\2/gi, (m, name, q, val) => {
    const parts = decodeEntities(val).split(',').map((part) => {
      const bits = part.trim().split(/\s+/);
      const r = safeUrl(bits[0], pageUrl);
      if (r) bits[0] = r;
      return bits.join(' ');
    });
    return name + '=' + q + parts.join(', ') + q;
  });

  // Inline event handlers (onclick="location.href=...") need the same origin
  // emulation as normal scripts.
  return tag.replace(/(\bon[a-z]+\s*=\s*)(["'])([\s\S]*?)\2/gi, (m, pre, q, code) => {
    return pre + q + rewriteJsSafe(code, pageUrl) + q;
  });
}

function rewriteScriptTag(tag, pageUrl) {
  const m = /^(<script\b[^>]*>)([\s\S]*)(<\/script\s*>)$/i.exec(tag);
  if (!m) return tag;
  const open = rewriteAttrs(m[1], pageUrl);
  if (/\bsrc\s*=/i.test(open)) return open + m[2] + m[3];
  const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(open);
  if (type && !/^(text\/javascript|application\/javascript|module|text\/ecmascript)$/i.test(type[1])) {
    return open + m[2] + m[3];
  }
  return open + rewriteJsSafe(m[2], pageUrl) + m[3];
}

function rewriteSegment(segment, pageUrl) {
  let out = segment.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, (tag) => rewriteAttrs(tag, pageUrl));
  out = rewriteCssUrls(out, pageUrl);
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, (m) => {
    return m.replace(/url\s*=\s*([^;"'\s>]+)/i, (mm, u) => {
      const r = safeUrl(u, pageUrl);
      return r ? 'url=' + r : mm;
    });
  });
  return out;
}

function rewriteHtml(html, pageUrl, session) {
  const source = String(html);

  // Split out <script> blocks BEFORE touching attributes. A document-wide
  // `src=` rewrite matches minified JS like `f.src=h,f.handler=h,...` and
  // replaces the rest of the script with a proxy URL, which silently kills
  // JavaScript on almost every modern site.
  const scriptRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
  const rebuilt = [];
  let cursor = 0;
  let match;

  while ((match = scriptRe.exec(source))) {
    rebuilt.push(rewriteSegment(source.slice(cursor, match.index), pageUrl));
    rebuilt.push(rewriteScriptTag(match[0], pageUrl));
    cursor = scriptRe.lastIndex;
  }
  rebuilt.push(rewriteSegment(source.slice(cursor), pageUrl));

  return injectToolbar(rebuilt.join(''), pageUrl, session);
}

// Never rewrite arbitrary string literals: minified bundles contain strings
// like '/bQ`OG27VO' or '/g,' that merely look like paths. Rewriting those
// corrupts the script (this broke most modern sites, incl. WebGPU demos).
// Only module specifiers and import.meta.url are safe to touch here.
function rewriteJsSafe(js, pageUrl) {
  let out = String(js);

  // import.meta.url is the URL of THIS module, not of the document. Replacing
  // it with a literal (rather than a global) keeps dynamically imported chunks
  // resolving against the correct directory.
  out = out.replace(/\bimport\.meta\.url\b/g, JSON.stringify(pageUrl));

  const safeSpecifier = (spec) => {
    if (/^https?:\/\//i.test(spec)) {
      return /^[\w./?=&%+#~:-]+$/.test(spec) ? safeUrl(spec, pageUrl) : null;
    }
    if (!/^\.{1,2}\//.test(spec)) return null;
    if (!/^[\w./?=&%+#~-]+$/.test(spec)) return null;
    return safeUrl(spec, pageUrl);
  };

  out = out.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])((?:\.{1,2}\/|https?:\/\/)[^"'\n]+)\2/gi, (m, pre, q, spec) => {
    const r = safeSpecifier(spec);
    return r ? pre + q + r + q : m;
  });

  out = out.replace(/\bimport\s+(["'])((?:\.{1,2}\/|https?:\/\/)[^"'\n]+)\1/gi, (m, q, spec) => {
    const r = safeSpecifier(spec);
    return r ? 'import ' + q + r + q : m;
  });

  // Origin emulation: code that reads location.* or document.baseURI sees the
  // proxy origin otherwise, so it builds URLs that point back here. Route
  // those reads through the emulated location object supplied by toolbar.js.
  out = out.replace(/(\bwindow\s*\.\s*|\bdocument\s*\.\s*)location\b/g, 'globalThis.__WB_LOCATION');
  out = out.replace(/(?<![\w.$])location\s*\./g, 'globalThis.__WB_LOCATION.');
  out = out.replace(/\bdocument\s*\.\s*(baseURI|URL)\b/g, 'globalThis.__WB_REAL_BASE');

  // Dynamic import() resolves against the proxy document URL. Send the
  // specifier through the runtime helper, which rebases it on the real site.
  out = out.replace(/\bimport\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (m, expr) => 'globalThis.__WB_IMPORT(' + expr + ', ' + JSON.stringify(pageUrl) + ')');

  return out;
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

const FORWARD_REQUEST_HEADERS = [
  'accept', 'accept-language', 'accept-charset', 'x-requested-with',
  'authorization', 'range', 'content-type'
];

// Keep the client hints consistent with UA above (Chrome 125, Windows).
const CLIENT_HINTS = '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"';

function decodeProxyReferer(referer) {
  try {
    const u = new URL(referer);
    if (u.pathname.startsWith('/p/')) return decodeURIComponent(u.pathname.slice(3));
  } catch (_) {}
  return undefined;
}

// Build a full browser-style header set. The browser's own fetch headers are
// preserved where they make sense, and the rest are filled in to match Chrome.
function browserHeaders(reqHeaders, parsed, realReferer) {
  const headers = {
    'user-agent': UA,
    'accept': reqHeaders.get('accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': reqHeaders.get('accept-language') || 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': CLIENT_HINTS,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'upgrade-insecure-requests': '1',
    'cache-control': 'max-age=0',
    'pragma': 'no-cache',
    'sec-gpc': '1'
  };

  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = reqHeaders.get(name);
    if (value && !headers[name]) headers[name] = value;
  }

  if (realReferer) headers.referer = realReferer;

  return headers;
}

async function fetchUpstream(target, method, bodyBuffer, reqHeaders, session) {
  let url = target;
  let curMethod = method;
  let curBody = bodyBuffer;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    if (isBlockedTarget(url)) throw new HttpError(403, 'Blocked: private or invalid address');

    const parsed = new URL(url);
    const realReferer = decodeProxyReferer(reqHeaders.get('referer'));
    const headers = browserHeaders(reqHeaders, parsed, realReferer);

    const cookie = buildCookieHeader(session.jar, parsed.hostname, parsed.pathname);
    if (cookie) headers.cookie = cookie;

    let response;
    try {
      response = await fetch(url, {
        method: curMethod,
        headers,
        body: (curBody && curBody.byteLength && curMethod !== 'GET' && curMethod !== 'HEAD') ? curBody : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      throw new HttpError(502, 'Could not reach ' + parsed.host + ' (' + (err && err.message ? err.message : err) + ')');
    }

    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
    storeCookies(session.jar, setCookies, parsed.hostname);

    const location = response.headers.get('location');
    if (location && [301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(location, url).href;
      if (response.status === 303 ||
          ((response.status === 301 || response.status === 302) && curMethod === 'POST')) {
        curMethod = 'GET';
        curBody = null;
      }
      try { await response.arrayBuffer(); } catch (_) {}
      continue;
    }

    return { response, finalUrl: url };
  }

  throw new HttpError(502, 'Too many redirects');
}

const SKIP_RESPONSE_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'upgrade-insecure-requests',
  'set-cookie', 'location', 'content-encoding', 'content-length',
  'transfer-encoding', 'link', 'cross-origin-embedder-policy',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'connection'
]);

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

function textResponse(status, message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function isChallengePage(html) {
  const head = html.slice(0, 20000);
  // Strong challenge markers only — generic words like "captcha" appear in
  // ordinary articles (e.g. Wikipedia) and would cause false positives.
  return /just a moment|attention required|verify you are (human|a person)|are you a robot|checking your browser|cf-challenge|enable javascript and cookies to continue|cloudflare ray id/i.test(head);
}

function blockedNotice(finalUrl) {
  const safe = escapeHtml(finalUrl);
  return '<div style="position:relative;z-index:2147483646;padding:14px 18px;background:#3a2410;' +
    'color:#ffd9a8;border-bottom:1px solid #6b4423;font:14px/1.5 system-ui,sans-serif;">' +
    '<strong>This site is blocking the proxy.</strong> Its anti-bot check cannot be bypassed by headers alone. ' +
    '<a href="' + safe + '" target="_blank" rel="noopener" style="color:#9ec5ff;">Open the original site</a>' +
    '</div>';
}

async function rewriteResponse(response, finalUrl, method, session) {
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const raw = new Uint8Array(await response.arrayBuffer());
  const decoder = new TextDecoder('utf-8');
  let output = raw;
  let textual = false;

  if (/text\/html/i.test(contentType)) {
    textual = true;
    let html = rewriteHtml(decoder.decode(raw), finalUrl, session);
    if (isChallengePage(html) || response.status === 403 || response.status === 429) {
      html = blockedNotice(finalUrl) + html;
    }
    output = new TextEncoder().encode(html);
  } else if (/text\/css/i.test(contentType)) {
    textual = true;
    output = new TextEncoder().encode(rewriteCssUrls(decoder.decode(raw), finalUrl));
  } else if (/javascript/i.test(contentType)) {
    textual = true;
    output = new TextEncoder().encode(rewriteJsSafe(decoder.decode(raw), finalUrl));
  }

  const headers = new Headers();
  for (const [key, value] of response.headers) {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  if (textual || /text\/(html|css)|javascript/i.test(contentType)) {
    headers.set('content-type', contentType.replace(/;\s*charset=[^;]+/i, '') + '; charset=utf-8');
  }
  headers.set('cache-control', 'no-store');
  headers.set('x-wb-real-url', finalUrl);
  if (session.setCookie) headers.append('set-cookie', session.setCookie);

  const bodyless = method === 'HEAD' || response.status === 204 || response.status === 304;
  return new Response(bodyless ? null : output, { status: response.status, headers });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ')).trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ddgResultUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
  } catch (_) {}
  return href;
}

function bingResultUrl(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const raw = u.searchParams.get('u');
    if (raw && /^a1/i.test(raw)) {
      const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
  } catch (_) {}
  return href;
}

function isTrackerRedirect(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)duckduckgo\.com$/.test(host) || /(^|\.)bing\.com$/.test(host);
  } catch (_) {
    return false;
  }
}

function parseDdg(html) {
  const results = [];
  const links = html.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/gi) || [];
  const snippets = html.match(/<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>[\s\S]*?<\/a>/gi) || [];
  links.forEach((tag, i) => {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!href) return;
    const url = ddgResultUrl(href[1]);
    if (isTrackerRedirect(url)) return;
    results.push({
      url,
      title: stripTags(tag),
      snippet: snippets[i] ? stripTags(snippets[i]) : ''
    });
  });
  return results;
}

function parseBing(html) {
  const results = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];
  blocks.forEach((block) => {
    const href = /<h2[^>]*>[\s\S]*?<a[^>]*href\s*=\s*["']([^"']+)["']/i.exec(block);
    if (!href) return;
    const title = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const url = bingResultUrl(decodeEntities(href[1]));
    if (isTrackerRedirect(url)) return;
    results.push({
      url,
      title: title ? stripTags(title[1]) : href[1],
      snippet: snippet ? stripTags(snippet[1]) : ''
    });
  });
  return results;
}

async function getSearchResults(query, engine) {
  const encoded = encodeURIComponent(query);
  const ddg = { url: 'https://html.duckduckgo.com/html/?q=' + encoded, parser: parseDdg };
  const bing = { url: 'https://www.bing.com/search?q=' + encoded + '&count=20', parser: parseBing };
  const attempts = engine === 'bing' ? [bing, ddg] : [ddg, bing];
  let lastError = null;

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        headers: browserHeaders(new Headers(), new URL(attempt.url), undefined),
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });
      const html = await response.text();
      const results = attempt.parser(html).slice(0, 20);
      if (results.length) return { results, searchUrl: attempt.url, error: null };
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
  }

  return { results: [], searchUrl: attempts[0].url, error: lastError };
}

function searchPage(query, engine, data) {
  const esc = escapeHtml;
  const selected = (value) => (engine === value ? ' selected' : '');
  const items = data.results.map((r) => (
    '<div class="result">' +
      '<a class="title" href="' + esc(proxyUrl(r.url)) + '">' + esc(r.title) + '</a>' +
      '<div class="url">' + esc(r.url) + '</div>' +
      (r.snippet ? '<div class="snippet">' + esc(r.snippet) + '</div>' : '') +
    '</div>'
  )).join('');

  const empty = items || (
    '<p class="empty">No results could be parsed' +
    (data.error ? ' (' + esc(data.error) + ')' : '') + '. ' +
    '<a href="' + esc(proxyUrl(data.searchUrl)) + '">Open the raw search page</a>.</p>'
  );

  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(query) + ' — WebProxy Search</title>' +
    '<link rel="stylesheet" href="/style.css"></head><body>' +
    '<header><div class="brand">Web<span>Proxy</span></div>' +
    '<div class="badge">search</div></header>' +
    '<main class="search-main">' +
      '<form action="/s" method="get" class="search-form">' +
        '<input name="q" value="' + esc(query) + '" aria-label="Search">' +
        '<select name="engine" aria-label="Search engine">' +
          '<option value="ddg"' + selected('ddg') + '>DuckDuckGo</option>' +
          '<option value="bing"' + selected('bing') + '>Bing</option>' +
        '</select>' +
        '<button type="submit">Go</button>' +
      '</form>' +
      '<div class="results">' + empty + '</div>' +
    '</main>' +
    '<footer>Results load inside this tab</footer></body></html>';
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleSearch(request, url) {
  const session = getSession(request);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });

  // A URL goes straight to the proxy; anything else is a real web search.
  if (/^https?:\/\//i.test(q) || /^[\w.-]+(\.[\w-]+)+/i.test(q)) {
    const target = /^https?:\/\//i.test(q) ? q : 'https://' + q;
    const headers = { location: proxyUrl(target), 'cache-control': 'no-store' };
    if (session.setCookie) headers['set-cookie'] = session.setCookie;
    return new Response(null, { status: 302, headers });
  }

  const engine = url.searchParams.get('engine') === 'bing' ? 'bing' : 'ddg';
  const data = await getSearchResults(q, engine);
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  };
  if (session.setCookie) headers['set-cookie'] = session.setCookie;
  return new Response(searchPage(q, engine, data), { headers });
}

async function handleProxy(request, url, target) {
  const session = getSession(request);

  // Query params on the proxy URL come from GET forms — append them to target.
  const extras = [...url.searchParams.entries()];
  if (extras.length) {
    const u = new URL(target);
    for (const [k, v] of extras) u.searchParams.append(k, v);
    target = u.href;
  }

  const isBodyless = request.method === 'GET' || request.method === 'HEAD';
  const body = isBodyless ? null : await request.arrayBuffer();
  const { response, finalUrl } = await fetchUpstream(
    target, request.method, body, request.headers, session
  );

  return rewriteResponse(response, finalUrl, request.method, session);
}

async function handleCookieWrite(request, url) {
  if (request.method !== 'POST') return textResponse(405, 'Method not allowed');

  let host = '';
  try { host = new URL(url.searchParams.get('site') || '').hostname; } catch (_) {}
  if (!host) return textResponse(400, 'Bad site');

  const raw = await request.text();
  const session = getSession(request);
  storeCookies(session.jar, [raw], host);

  const headers = { 'cache-control': 'no-store' };
  if (session.setCookie) headers['set-cookie'] = session.setCookie;
  return new Response('ok', { headers });
}

async function handleWebSocket(request, url) {
  let target;
  try {
    target = decodeURIComponent(url.pathname.slice(4));
  } catch (_) {
    return textResponse(400, 'Bad WebSocket URL');
  }
  target = target.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  if (isBlockedTarget(target)) return textResponse(403, 'Blocked WebSocket target');

  const pair = new WebSocketPair();
  const client = pair[0];
  const upstreamSide = pair[1];
  upstreamSide.accept();

  const headers = {};
  for (const name of ['upgrade', 'connection', 'sec-websocket-key',
                      'sec-websocket-version', 'sec-websocket-protocol']) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  headers['user-agent'] = UA;

  const parsed = new URL(target);
  const session = getSession(request);
  const cookie = buildCookieHeader(session.jar, parsed.hostname, parsed.pathname);
  if (cookie) headers.cookie = cookie;

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(target, { method: 'GET', headers });
  } catch (err) {
    upstreamSide.close(1011, 'Could not reach WebSocket upstream');
    return new Response(null, { status: 101, webSocket: client });
  }

  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    upstreamSide.close(1011, 'Upstream did not accept WebSocket');
    return new Response(null, { status: 101, webSocket: client });
  }
  upstream.accept();

  upstreamSide.addEventListener('message', (event) => {
    try { upstream.send(event.data); } catch (_) {}
  });
  upstream.addEventListener('message', (event) => {
    try { upstreamSide.send(event.data); } catch (_) {}
  });
  upstreamSide.addEventListener('close', (event) => {
    try { upstream.close(event.code, event.reason); } catch (_) {}
  });
  upstream.addEventListener('close', (event) => {
    try { upstreamSide.close(event.code, event.reason); } catch (_) {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function serveAsset(request, env, pathname) {
  if (!env || !env.ASSETS) return textResponse(404, 'Not found');
  return env.ASSETS.fetch(new Request(new URL(pathname, request.url), { method: 'GET' }));
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/s') return handleSearch(request, url);
      if (pathname === '/favicon.ico') return new Response(null, { status: 204 });
      if (pathname === '/__wb/cookie') return await handleCookieWrite(request, url);
      if (pathname.startsWith('/ws/')) return await handleWebSocket(request, url);

      if (pathname.startsWith('/p/')) {
        let target;
        try {
          target = decodeURIComponent(pathname.slice(3));
        } catch (_) {
          return textResponse(400, 'Bad URL');
        }
        if (!/^https?:\/\//i.test(target)) {
          return textResponse(400, 'Only http:// and https:// URLs are supported');
        }
        return await handleProxy(request, url, target);
      }

      return await serveAsset(request, env, pathname === '/' ? '/index.html' : pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      return textResponse(status, 'Proxy error: ' + (err && err.message ? err.message : String(err)));
    }
  }
};

export { isBlockedTarget };
export default worker;
