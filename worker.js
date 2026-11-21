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

function toolbarScript(pageUrl) {
  return '<script>window.__WB_REAL_BASE = ' + JSON.stringify(pageUrl) + ';</script>\n' +
         '<script src="/toolbar.js"></script>\n';
}

function toolbarHtml() {
  const btn = 'display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;' +
              'background:#2b2f3a;color:#e8eaf0;border:1px solid #3c414f;border-radius:5px;' +
              'cursor:pointer;font-size:14px;flex:none;';
  return '<div id="__wb_bar" style="position:fixed;top:0;left:0;right:0;height:40px;' +
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

function injectToolbar(html, pageUrl) {
  let out = html;

  // Neutralise meta CSP and base tags which would break rewriting / inline scripts.
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/\btarget\s*=\s*(["']?)_blank\1/gi, 'target="_self"');

  const script = toolbarScript(pageUrl);
  const bar = toolbarHtml();

  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + script);
  else out = script + out;

  if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, (m) => m + bar);
  else out = bar + out;

  return out;
}

function rewriteHtml(html, pageUrl) {
  let out = String(html);

  out = out.replace(URL_ATTR_RE, (m, prefix, quote, quoted, unquoted) => {
    const value = quote ? quoted : unquoted;
    const rewritten = safeUrl(value, pageUrl);
    if (!rewritten) return m;
    return quote ? prefix + quote + rewritten + quote : prefix + '"' + rewritten + '"';
  });

  out = out.replace(/\b(srcset|imagesrcset)\s*=\s*(["'])([^"']*)\2/gi, (m, name, q, val) => {
    const parts = val.split(',').map((part) => {
      const bits = part.trim().split(/\s+/);
      const r = safeUrl(bits[0], pageUrl);
      if (r) bits[0] = r;
      return bits.join(' ');
    });
    return name + '=' + q + parts.join(', ') + q;
  });

  // Inline scripts: only fix module specifiers / import.meta.url, never arbitrary strings.
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, code) => {
    if (/\bsrc\s*=/i.test(attrs)) return m;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (type && !/^(text\/javascript|application\/javascript|module|text\/ecmascript)$/i.test(type[1])) {
      return m;
    }
    return '<script' + attrs + '>' + rewriteJsSafe(code, pageUrl) + '</script>';
  });

  out = rewriteCssUrls(out, pageUrl);

  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, (m) => {
    return m.replace(/url\s*=\s*([^;"'\s>]+)/i, (mm, u) => {
      const r = safeUrl(u, pageUrl);
      return r ? 'url=' + r : mm;
    });
  });

  return injectToolbar(out, pageUrl);
}

// Never rewrite arbitrary string literals: minified bundles contain strings
// like '/bQ`OG27VO' or '/g,' that merely look like paths. Rewriting those
// corrupts the script (this broke most modern sites, incl. WebGPU demos).
// Only module specifiers and import.meta.url are safe to touch here.
function rewriteJsSafe(js, pageUrl) {
  let out = String(js);

  out = out.replace(/\bimport\.meta\.url\b/g, 'globalThis.__WB_REAL_BASE');

  const safeSpecifier = (spec) => {
    if (!/^\.{1,2}\//.test(spec)) return null;
    if (!/^[\w./?=&%+#~-]+$/.test(spec)) return null;
    return safeUrl(spec, pageUrl);
  };

  out = out.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]+)\2/g, (m, pre, q, spec) => {
    const r = safeSpecifier(spec);
    return r ? pre + q + r + q : m;
  });

  out = out.replace(/\bimport\s+(["'])(\.{1,2}\/[^"'\n]+)\1/g, (m, q, spec) => {
    const r = safeSpecifier(spec);
    return r ? 'import ' + q + r + q : m;
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

const FORWARD_REQUEST_HEADERS = [
  'accept', 'accept-language', 'accept-charset', 'x-requested-with',
  'authorization', 'range'
];

function decodeProxyReferer(referer) {
  try {
    const u = new URL(referer);
    if (u.pathname.startsWith('/p/')) return decodeURIComponent(u.pathname.slice(3));
  } catch (_) {}
  return undefined;
}

async function fetchUpstream(target, method, bodyBuffer, reqHeaders, session) {
  let url = target;
  let curMethod = method;
  let curBody = bodyBuffer;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    if (isBlockedTarget(url)) throw new HttpError(403, 'Blocked: private or invalid address');

    const parsed = new URL(url);
    const headers = {
      'user-agent': UA,
      'accept': reqHeaders.get('accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': reqHeaders.get('accept-language') || 'en-US,en;q=0.9'
    };

    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = reqHeaders.get(name);
      if (value && !headers[name]) headers[name] = value;
    }

    const cookie = buildCookieHeader(session.jar, parsed.hostname, parsed.pathname);
    if (cookie) headers.cookie = cookie;

    const realReferer = decodeProxyReferer(reqHeaders.get('referer'));
    if (realReferer) headers.referer = realReferer;

    if (curBody && curBody.byteLength && reqHeaders.get('content-type')) {
      headers['content-type'] = reqHeaders.get('content-type');
    }

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

async function rewriteResponse(response, finalUrl, method, session) {
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const raw = new Uint8Array(await response.arrayBuffer());
  const decoder = new TextDecoder('utf-8');
  let output = raw;
  let textual = false;

  if (/text\/html/i.test(contentType)) {
    textual = true;
    output = new TextEncoder().encode(rewriteHtml(decoder.decode(raw), finalUrl));
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
  if (session.setCookie) headers.append('set-cookie', session.setCookie);

  const bodyless = method === 'HEAD' || response.status === 204 || response.status === 304;
  return new Response(bodyless ? null : output, { status: response.status, headers });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

function handleSearch(request, url) {
  const session = getSession(request);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });

  let target;
  if (/^https?:\/\//i.test(q)) {
    target = q;
  } else if (/^[\w.-]+(\.[\w-]+)+/i.test(q)) {
    target = 'https://' + q;
  } else {
    const engine = url.searchParams.get('engine') || 'ddg';
    const encoded = encodeURIComponent(q);
    if (engine === 'bing') target = 'https://www.bing.com/search?q=' + encoded;
    else if (engine === 'brave') target = 'https://search.brave.com/search?q=' + encoded;
    else target = 'https://html.duckduckgo.com/html/?q=' + encoded;
  }

  const headers = { location: proxyUrl(target), 'cache-control': 'no-store' };
  if (session.setCookie) headers['set-cookie'] = session.setCookie;
  return new Response(null, { status: 302, headers });
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

export default worker;
