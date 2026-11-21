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
           p.indexOf('/p/') === 0 || p === '/ws' || p.indexOf('/ws/') === 0;
  }

  function proxied(u) {
    return '/p/' + encodeURIComponent(u.href);
  }

  // Map a URL as the browser sees it back onto the proxy.
  function toProxy(input) {
    if (input == null) return input;
    var str;
    if (typeof input === 'string' || input instanceof URL) str = String(input);
    else return input;
    if (!str) return str;

    if (/^\/p\//.test(str) || /^\/s(?:\?|$)/.test(str) || /^\/ws\//.test(str)) return str;

    var a;
    try { a = new URL(str, location.href); } catch (e) { return str; }
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return str;

    if (a.origin === location.origin) {
      if (isOurPath(a.pathname)) return a.pathname + a.search + a.hash;
      // A relative URL got resolved against OUR origin by the browser.
      // Rebase it on the original page instead.
      return proxied(new URL(a.pathname + a.search + a.hash, real.href));
    }

    if (a.origin === real.origin) return proxied(a);
    return str; // genuinely cross-origin: leave it alone
  }

  /* ---------------- Runtime patches ---------------- */

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      if (typeof input === 'string' || input instanceof URL) input = toProxy(input);
      else if (input && typeof input.url === 'string') {
        try { input = new Request(toProxy(input.url), input); } catch (e) {}
      }
      return origFetch.call(this, input, init);
    };
  }

  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      arguments[1] = toProxy(url);
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
