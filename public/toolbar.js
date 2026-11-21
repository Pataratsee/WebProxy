/* Injected into every proxied page. window.__WB_REAL_BASE is set by server.js. */
(function () {
  var REAL_BASE = window.__WB_REAL_BASE || location.href;

  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
    }
  } catch (e) {}

  window.open = function (u) {
    if (!u) return null;
    try {
      var a = new URL(String(u), REAL_BASE);
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
    if (input) input.value = REAL_BASE;

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
      document.getElementById('__wb_bar').style.display = 'none';
    };

    var form = document.getElementById('__wb_form');
    if (form) form.onsubmit = function (e) {
      e.preventDefault();
      go(document.getElementById('__wb_input').value);
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
