/*
 * Injected into every proxied page.
 *
 * globalThis.__WB_REAL_BASE is supplied by worker.js. This script:
 *  - adds the navigation bar
 *  - reports WebGPU availability
 *  - patches URL-based browser APIs so relative URLs resolve against the
 *    ORIGINAL page instead of the proxy origin (without mangling JS bundles)
 */
(function () {
  var REAL_BASE = globalThis.__WB_REAL_BASE || location.href;
  var real;
  try { real = new URL(REAL_BASE); } catch (e) { real = new URL(location.href); }

  globalThis.__WB_REAL_BASE = real.href;
  var currentReal = new URL(real.href);

  /* ---------------- Subresource Integrity ---------------- */

  // An SRI hash describes the original file, but proxied scripts are rewritten
  // (module specifiers, import.meta.url, location reads), so the browser would
  // block the resource. Drop integrity attributes, including ones assigned at
  // runtime by page scripts (e.g. Cloudflare's analytics beacon).
  try {
    var nativeSetAttributeSRI = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name) {
      if (String(name).toLowerCase() === 'integrity') return;
      return nativeSetAttributeSRI.apply(this, arguments);
    };

    ['HTMLScriptElement', 'HTMLLinkElement'].forEach(function (ctor) {
      var C = globalThis[ctor];
      if (!C) return;
      try {
        Object.defineProperty(C.prototype, 'integrity', {
          get: function () { return ''; },
          set: function () {},
          configurable: true
        });
      } catch (e) {}
    });

    document.addEventListener('DOMContentLoaded', function () {
      var nodes = document.querySelectorAll('[integrity]');
      for (var i = 0; i < nodes.length; i++) {
        try { nodes[i].removeAttribute('integrity'); } catch (e) {}
      }
    });
  } catch (e) {}

  /* ---------------- document.cookie emulation ---------------- */

  function parseCookies(s) {
    var out = {};
    String(s || '').split(';').forEach(function (part) {
      var i = part.indexOf('=');
      if (i < 0) return;
      var k = part.slice(0, i).trim();
      if (k) out[k] = part.slice(i + 1).trim();
    });
    return out;
  }

  var cookieMap = parseCookies(globalThis.__WB_COOKIES);
  function cookieString() {
    return Object.keys(cookieMap).map(function (k) { return k + '=' + cookieMap[k]; }).join('; ');
  }

  try {
    Object.defineProperty(document, 'cookie', {
      get: function () { return cookieString(); },
      set: function (value) {
        var parts = String(value || '').split(';');
        var first = parts.shift();
        var eq = first.indexOf('=');
        if (eq < 0) return;
        var name = first.slice(0, eq).trim();
        if (!name) return;
        var expires = Infinity;
        parts.forEach(function (part) {
          var i = part.indexOf('=');
          var key = (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase();
          var val = i >= 0 ? part.slice(i + 1) : '';
          if (key === 'expires') {
            var t = Date.parse(val);
            if (!isNaN(t)) expires = t;
          } else if (key === 'max-age') {
            var n = parseInt(val, 10);
            if (!isNaN(n)) expires = Date.now() + n * 1000;
          }
        });
        if (expires <= Date.now()) delete cookieMap[name];
        else cookieMap[name] = first.slice(eq + 1).trim();

        // Keep the server-side jar in sync, so subsequent requests carry it.
        try {
          fetch('/__wb/cookie?site=' + encodeURIComponent(currentReal.origin), {
            method: 'POST',
            headers: { 'content-type': 'text/plain;charset=utf-8' },
            body: String(value),
            keepalive: true
          }).catch(function () {});
        } catch (e) {}
      },
      configurable: true
    });
  } catch (e) {}

  function syncRealFromProxy() {
    var p = location.pathname;
    if (p.indexOf('/p/') === 0) {
      try { currentReal = new URL(decodeURIComponent(p.slice(3))); } catch (e) {}
    }
  }

  // A stand-in for window.location that reports the ORIGINAL site's URL.
  // worker.js rewrites location.* reads in page scripts to point here.
  var emulatedLocation = {
    get href() { return currentReal.href; },
    set href(v) { navigateTo(v); },
    get origin() { return currentReal.origin; },
    get protocol() { return currentReal.protocol; },
    get host() { return currentReal.host; },
    get hostname() { return currentReal.hostname; },
    get port() { return currentReal.port; },
    get pathname() { return currentReal.pathname; },
    get search() { return currentReal.search; },
    get hash() { return currentReal.hash; },
    assign: function (v) { navigateTo(v); },
    replace: function (v) { navigateTo(v); },
    reload: function () { location.reload(); },
    toString: function () { return currentReal.href; },
    valueOf: function () { return currentReal.href; }
  };
  globalThis.__WB_LOCATION = emulatedLocation;

  /* ---------------- WebGPU status ---------------- */

  function reportGpu() {
    var el = document.getElementById('__wb_gpu');
    if (!el) return;

    if (!navigator.gpu) {
      el.textContent = 'GPU -';
      el.title = 'WebGPU unavailable: browser lacks it, or this page is not a secure context';
      return;
    }

    el.textContent = 'GPU ok';
    el.title = 'WebGPU available';
    try {
      navigator.gpu.requestAdapter().then(function (adapter) {
        if (!adapter) {
          el.textContent = 'GPU -';
          el.title = 'No WebGPU adapter found';
          return;
        }
        var info = adapter.info || {};
        var label = [info.vendor, info.architecture].filter(Boolean).join(' ');
        el.title = 'WebGPU: ' + (label || 'available');
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- URL mapping ---------------- */

  function isOurPath(p) {
    return p === '/' || p === '/index.html' || p === '/s' || p === '/favicon.ico' ||
           p === '/style.css' || p === '/toolbar.js' || p === '/p' ||
           p.indexOf('/p/') === 0 || p.indexOf('/__wb/') === 0 ||
           p === '/ws' || p.indexOf('/ws/') === 0;
  }

  function proxied(u) {
    return '/p/' + encodeURIComponent(u.href);
  }

  function decodeProxyUrl(str) {
    var m = /^\/p\/([^?#]*)/.exec(String(str || ''));
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return null; }
  }

  // Map a URL as the browser sees it back onto the proxy.
  function toProxy(input) {
    if (input == null) return input;
    var str;
    if (typeof input === 'string' || input instanceof URL) str = String(input);
    else return input;
    if (!str) return str;

    if (/^\/p\//.test(str) || /^\/s(?:\?|$)/.test(str) || /^\/ws\//.test(str) ||
        /^\/__wb\//.test(str)) return str;

    var a;
    try { a = new URL(str, currentReal.href); } catch (e) { return str; }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return str;

    if (a.origin === location.origin) {
      if (isOurPath(a.pathname)) return a.pathname + a.search + a.hash;
      // A relative URL got resolved against OUR origin by the browser.
      // Rebase it on the original page instead.
      return proxied(new URL(a.pathname + a.search + a.hash, real.href));
    }

    // Route ALL http(s) URLs through the proxy. Leaving cross-origin URLs
    // alone makes the browser issue a direct request, which then fails CORS
    // and breaks most site functionality (API calls, auth, analytics).
    return proxied(a);
  }

  /* ---------------- Runtime patches ---------------- */

  // WebSockets: connect to our /ws/ bridge and keep the original ws(s) URL
  // visible to page code. This restores live features (chat, notifications,
  // progress updates) that otherwise fail because ws:// is not proxied.
  var OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    function ProxiedWebSocket(url, protocols) {
      var original = String(url);
      var target = null;
      try {
        var a = new URL(original, currentReal.href);
        if (a.protocol === 'ws:' || a.protocol === 'wss:') {
          a.protocol = a.protocol === 'ws:' ? 'http:' : 'https:';
          target = a.href;
        }
      } catch (e) {}

      var connectTo = original;
      if (target) {
        connectTo = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' +
                    location.host + '/ws/' + encodeURIComponent(target);
        if (protocols != null) {
          var list = Array.isArray(protocols) ? protocols : [protocols];
          connectTo += '?protocols=' + encodeURIComponent(list.join(','));
        }
      }

      var ws = new OrigWebSocket(connectTo, protocols);
      try {
        Object.defineProperty(ws, 'url', {
          get: function () { return original; }, configurable: true
        });
      } catch (e) {}
      return ws;
    }
    ProxiedWebSocket.prototype = OrigWebSocket.prototype;
    try { Object.setPrototypeOf(ProxiedWebSocket, OrigWebSocket); } catch (e) {}
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
      try { ProxiedWebSocket[k] = OrigWebSocket[k]; } catch (e) {}
    });
    window.WebSocket = ProxiedWebSocket;
  }

  // Dynamic import() uses the document base URL, which is the proxy path.
  // Route its specifier through the proxy too.
  globalThis.__WB_IMPORT = function (spec, base) {
    if (base) {
      try { return import(proxied(new URL(String(spec), base))); } catch (e) {}
    }
    return import(toProxy(spec));
  };

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var mapped = input;
      if (typeof input === 'string' || input instanceof URL) mapped = toProxy(input);
      else if (input && typeof input.url === 'string') {
        try { mapped = new Request(toProxy(input.url), input); } catch (e) {}
      }
      return origFetch.call(this, mapped, init).then(function (res) {
        // Sites often read response.url; expose the original URL instead of
        // the proxy path. The server supplies the final URL after redirects.
        try {
          var realUrl = res.headers.get('x-wb-real-url') ||
                        decodeProxyUrl(mapped && mapped.url ? mapped.url : String(mapped));
          if (realUrl) Object.defineProperty(res, 'url', { value: realUrl, configurable: true });
        } catch (e) {}
        return res;
      });
    };
  }

  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var mapped = toProxy(url);
      arguments[1] = mapped;
      var fallback = decodeProxyUrl(mapped) || String(url || '');
      try {
        Object.defineProperty(this, 'responseURL', {
          get: function () {
            try {
              var h = this.getResponseHeader && this.getResponseHeader('x-wb-real-url');
              if (h) return h;
            } catch (e) {}
            return fallback;
          },
          configurable: true
        });
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  }

  function wrapGlobal(name) {
    var Orig = window[name];
    if (typeof Orig !== 'function') return;
    function Wrapper() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) args[0] = toProxy(args[0]);
      return Reflect.construct(Orig, args);
    }
    Wrapper.prototype = Orig.prototype;
    try { Object.setPrototypeOf(Wrapper, Orig); } catch (e) {}
    window[name] = Wrapper;
  }
  wrapGlobal('EventSource');
  wrapGlobal('Worker');
  wrapGlobal('SharedWorker');

  try {
    if (navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) { return origBeacon(toProxy(url), data); };
    }
  } catch (e) {}

  // JS-created elements (img.src = '/x.png', link.href, etc.) bypass HTML
  // rewriting. Patch the DOM APIs so those URLs go through the proxy too.
  var URL_ATTRS_RT = ['href', 'src', 'action', 'poster', 'data', 'formaction',
                      'background', 'srcset', 'imagesrcset', 'cite'];

  function mapAttrValue(name, value) {
    if (value == null) return value;
    if (/^(srcset|imagesrcset)$/i.test(name)) {
      return String(value).split(',').map(function (part) {
        var bits = part.trim().split(/\s+/);
        if (bits[0]) bits[0] = toProxy(bits[0]);
        return bits.join(' ');
      }).join(', ');
    }
    return toProxy(value);
  }

  if (window.Element && Element.prototype.setAttribute) {
    var origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (URL_ATTRS_RT.indexOf(String(name).toLowerCase()) >= 0) value = mapAttrValue(name, value);
      return origSetAttribute.call(this, name, value);
    };
  }

  ['HTMLAnchorElement', 'HTMLAreaElement', 'HTMLImageElement', 'HTMLScriptElement',
   'HTMLLinkElement', 'HTMLIFrameElement', 'HTMLSourceElement', 'HTMLVideoElement',
   'HTMLAudioElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLObjectElement',
   'HTMLEmbedElement', 'HTMLTrackElement'].forEach(function (name) {
    var proto = window[name] && window[name].prototype;
    if (!proto) return;
    ['src', 'href', 'action', 'formAction', 'poster', 'data'].forEach(function (prop) {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return;
      try {
        Object.defineProperty(proto, prop, {
          get: desc.get,
          set: function (v) { desc.set.call(this, mapAttrValue(prop, v)); },
          configurable: true,
          enumerable: desc.enumerable
        });
      } catch (e) {}
    });
  });

  function mapCss(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/\burl\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi, function (m, q, val) {
      var p = toProxy(val);
      return p === val ? m : 'url(' + q + p + q + ')';
    });
  }

  if (window.CSSStyleDeclaration) {
    var origSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
      return origSetProperty.call(this, name, mapCss(value), priority);
    };
    ['background', 'backgroundImage', 'borderImage', 'borderImageSource',
     'mask', 'maskImage', 'listStyle', 'listStyleImage', 'content'].forEach(function (prop) {
      var desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, prop);
      if (!desc || !desc.set) return;
      try {
        Object.defineProperty(CSSStyleDeclaration.prototype, prop, {
          get: desc.get,
          set: function (v) { desc.set.call(this, mapCss(v)); },
          configurable: true,
          enumerable: desc.enumerable
        });
      } catch (e) {}
    });
  }

  try {
    var observer = new MutationObserver(function (records) {
      records.forEach(function (rec) {
        if (rec.type === 'attributes' && rec.target.nodeType === 1) {
          var name = rec.attributeName;
          if (URL_ATTRS_RT.indexOf(String(name).toLowerCase()) >= 0) {
            var v = rec.target.getAttribute(name);
            if (v != null) {
              var mapped = mapAttrValue(name, v);
              if (mapped !== v) {
                try { rec.target.setAttribute(name, mapped); } catch (e) {}
              }
            }
          }
        }
        (rec.addedNodes || []).forEach(function (node) {
          if (!node || node.nodeType !== 1) return;
          URL_ATTRS_RT.forEach(function (name) {
            var v = node.getAttribute && node.getAttribute(name);
            if (v != null) {
              var mapped = mapAttrValue(name, v);
              if (mapped !== v) {
                try { node.setAttribute(name, mapped); } catch (e) {}
              }
            }
          });
          (node.querySelectorAll || function () { return []; }).call(node,
            '[src],[href],[action],[poster],[data],[formaction],[background],[srcset],[imagesrcset],[cite]'
          ).forEach(function (child) {
            URL_ATTRS_RT.forEach(function (name) {
              var v = child.getAttribute(name);
              if (v != null) {
                var mapped = mapAttrValue(name, v);
                if (mapped !== v) {
                  try { child.setAttribute(name, mapped); } catch (e) {}
                }
              }
            });
          });
        });
      });
    });
    observer.observe(document.documentElement || document, {
      childList: true, subtree: true, attributes: true, attributeFilter: URL_ATTRS_RT
    });
  } catch (e) {}

  // SPA routing: map pushState/replaceState URLs onto proxy URLs so a reload
  // still resolves, and keep the emulated location in sync.
  // Patch the prototype, not the instance: page code that reaches the native
  // methods through History.prototype (or history.constructor.prototype) would
  // otherwise bypass the mapping and rewrite the tab URL to a bare path such as
  // '/', which then reloads our homepage instead of the proxied site.
  var origPushState = History.prototype.pushState;
  var origReplaceState = History.prototype.replaceState;

  function mappedStateUrl(u) {
    if (u == null || u === '') return null;
    var s = String(u);
    if (/^\/p\//.test(s)) {
      try { currentReal = new URL(decodeURIComponent(s.slice(3))); } catch (e) {}
      return null;
    }
    try {
      var a = new URL(s, currentReal.href);
      currentReal = a;
      return '/p/' + encodeURIComponent(a.href);
    } catch (e) {
      return null;
    }
  }

  History.prototype.pushState = function (state, title, url) {
    var mapped = mappedStateUrl(url);
    return origPushState.call(this, state, title, mapped || location.href);
  };
  History.prototype.replaceState = function (state, title, url) {
    var mapped = mappedStateUrl(url);
    return origReplaceState.call(this, state, title, mapped || location.href);
  };
  window.addEventListener('popstate', syncRealFromProxy);

  // Keep each site's localStorage/sessionStorage separate. Everything behind
  // this proxy shares one origin, so without namespacing sites collide.
  function namespacedStorage(store, prefix) {
    function keys() {
      var out = [];
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        if (k && k.indexOf(prefix) === 0) out.push(k);
      }
      return out;
    }
    return new Proxy(store, {
      get: function (target, prop) {
        if (prop === 'length') return keys().length;
        if (prop === 'getItem') return function (k) { return target.getItem(prefix + k); };
        if (prop === 'setItem') return function (k, v) { return target.setItem(prefix + k, v); };
        if (prop === 'removeItem') return function (k) { return target.removeItem(prefix + k); };
        if (prop === 'clear') return function () { keys().forEach(function (k) { target.removeItem(k); }); };
        if (prop === 'key') return function (i) {
          var k = keys()[i];
          return k == null ? null : k.slice(prefix.length);
        };
        var value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: function (target, prop, value) {
        if (typeof prop === 'string' && typeof value === 'string') target.setItem(prefix + prop, value);
        else target[prop] = value;
        return true;
      }
    });
  }

  var storagePrefix = '__WB_' + real.host + '|';
  try {
    Object.defineProperty(window, 'localStorage', {
      value: namespacedStorage(window.localStorage, storagePrefix), configurable: true
    });
    Object.defineProperty(window, 'sessionStorage', {
      value: namespacedStorage(window.sessionStorage, storagePrefix), configurable: true
    });
  } catch (e) {}

  // Service workers registered from a proxied page would live on OUR origin.
  // Stub them, but keep feature detection from throwing.
  if (navigator.serviceWorker) {
    var swStub = {
      register: function () { return Promise.resolve({ update: function () { return Promise.resolve(); } }); },
      getRegistration: function () { return Promise.resolve(undefined); },
      getRegistrations: function () { return Promise.resolve([]); },
      addEventListener: function () {},
      removeEventListener: function () {},
      startMessages: function () {},
      controller: null,
      ready: new Promise(function () {})
    };
    try { Object.defineProperty(navigator, 'serviceWorker', { value: swStub, configurable: true }); } catch (e) {}
  }

  /* ---------------- Navigation bar ---------------- */

  window.open = function (u) {
    if (!u) return null;
    try {
      var a = new URL(String(u), real.href);
      location.href = '/p/' + encodeURIComponent(a.href);
    } catch (e) {}
    return null;
  };

  // Navigate to a URL from page code (location.href = x, location.assign(x)).
  // Relative URLs are resolved against the ORIGINAL page, then sent through
  // the proxy. This is deliberately separate from go(), which treats plain
  // text as a search query.
  function navigateTo(v) {
    if (v == null) return;
    var s = String(v).trim();
    if (!s) return;
    var a;
    try { a = new URL(s, currentReal.href); } catch (e) { return; }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return;
    currentReal = a;
    location.href = proxied(a);
  }

  function go(v) {
    v = String(v || '').trim();
    if (!v) return;
    if (/^https?:\/\//i.test(v)) location.href = '/p/' + encodeURIComponent(v);
    else if (/^[\w.-]+(?:\.[\w-]+)+/i.test(v)) location.href = '/p/' + encodeURIComponent('https://' + v);
    else location.href = '/s?q=' + encodeURIComponent(v);
  }

  function setup() {
    var input = document.getElementById('__wb_input');
    if (input) input.value = real.href;

    var back = document.getElementById('__wb_back');
    if (back) back.onclick = function () {
      if (history.length > 1) history.back();
      else location.href = '/';
    };

    var reload = document.getElementById('__wb_reload');
    if (reload) reload.onclick = function () { location.reload(); };

    var home = document.getElementById('__wb_home');
    if (home) home.onclick = function () { location.href = '/'; };

    var hide = document.getElementById('__wb_hide');
    if (hide) hide.onclick = function () {
      var bar = document.getElementById('__wb_bar');
      if (bar) bar.style.display = 'none';
    };

    var form = document.getElementById('__wb_form');
    if (form) form.onsubmit = function (e) {
      e.preventDefault();
      go(document.getElementById('__wb_input').value);
    };

    reportGpu();
  }

  // The bar is injected at the top of <body>, so it exists long before
  // DOMContentLoaded. Big pages can sit in "loading" for many seconds (or never
  // finish a blocked resource), and waiting for that event leaves the address
  // bar empty and every button dead. Start as soon as the bar is in the DOM.
  var started = false;
  function start() {
    if (started || !document.getElementById('__wb_bar')) return;
    started = true;
    setup();
  }

  start();
  if (!started) {
    document.addEventListener('DOMContentLoaded', start);
    var attempts = 0;
    var timer = setInterval(function () {
      start();
      if (started || ++attempts > 200) clearInterval(timer);
    }, 50);
  }
})();
