/*
 * Real-browser mode.
 *
 * Instead of rewriting HTML on a server, this runs an actual headless Chromium,
 * navigates it to the requested URL, and streams screenshots back to the page.
 * Mouse, wheel and keyboard input is forwarded over the DevTools Protocol.
 * Sites therefore see a genuine Chrome browser, not a rewriting proxy.
 *
 * Node-only. The Cloudflare Worker cannot run this module.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const FRAME_MS = Math.max(60, Number(process.env.BROWSER_FRAME_MS || 120));
const SCREENCAST_FORMAT = process.env.BROWSER_SCREENCAST_FORMAT === 'jpeg' ? 'jpeg' : 'webp';
const SCREENCAST_QUALITY = Math.min(100, Math.max(30,
  Number(process.env.BROWSER_QUALITY || process.env.BROWSER_JPEG_QUALITY || 70)));
const INFO_MS = Math.max(250, Number(process.env.BROWSER_INFO_MS || 700));
const USE_SCREENCAST = process.env.BROWSER_DISABLE_SCREENCAST !== '1';
const GPU_MODE = process.env.BROWSER_GPU || 'gl';
const ANGLE_BACKEND = process.env.BROWSER_ANGLE || (GPU_MODE === 'off' ? '' : GPU_MODE);
const GPU_RASTERIZATION = process.env.BROWSER_GPU_RASTERIZATION === '1';
const GPU_COMPOSITING = process.env.BROWSER_GPU_COMPOSITING === '1';
const GPU_STATUS = process.env.BROWSER_GPU_STATUS !== '0';
const ANTI_BOT = process.env.BROWSER_ANTI_BOT !== '0';
const MAX_SESSIONS = 12;

const sessions = new Map();
let chromeProcess = null;
let devtoolsPort = null;
let browserCdp = null;
let initPromise = null;

const ANTI_BOT_BOOTSTRAP = `
(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_) {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (_) {}
})();
`;

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const name of readdirSync(cache)) {
      if (!name.startsWith('chromium-')) continue;
      const exe = path.join(cache, name, 'chrome-linux64', 'chrome');
      if (existsSync(exe)) return exe;
    }
  } catch (_) {}

  for (const candidate of [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const exe = findChrome();
    if (!exe) {
      throw new Error('Chromium was not found. Install it or set CHROME_PATH to a Chrome/Chromium binary.');
    }

    const profile = mkdtempSync(path.join(os.tmpdir(), 'webproxy-browser-'));
    const gpuArgs = GPU_MODE === 'off'
      ? ['--disable-gpu']
      : [
          '--enable-unsafe-webgpu',
          ...(GPU_RASTERIZATION ? ['--enable-gpu-rasterization'] : []),
          ...(ANGLE_BACKEND ? ['--use-angle=' + ANGLE_BACKEND] : []),
          ...(GPU_COMPOSITING ? [] : ['--disable-gpu-compositing']),
          ...(process.env.BROWSER_EXTRA_FLAGS || '').split(/\s+/).filter(Boolean)
        ];

    chromeProcess = spawn(exe, [
      '--headless=new',
      '--no-sandbox',
      '--force-device-scale-factor=1',
      ...gpuArgs,
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--user-data-dir=' + profile,
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    devtoolsPort = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chromium did not start in time.')), 20000);
      chromeProcess.stderr.on('data', (chunk) => {
        output += chunk.toString();
        const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      chromeProcess.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    try {
      const version = await fetch('http://127.0.0.1:' + devtoolsPort + '/json/version')
        .then((r) => r.json());
      browserCdp = version.webSocketDebuggerUrl ? new CDP(version.webSocketDebuggerUrl) : null;
    } catch (_) {
      browserCdp = null;
    }

    chromeProcess.on('exit', () => {
      devtoolsPort = null;
      initPromise = null;
      chromeProcess = null;
      if (browserCdp) browserCdp.close();
      browserCdp = null;
      for (const session of sessions.values()) session.destroy();
      sessions.clear();
    });

    return devtoolsPort;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

async function devtools(pathname) {
  const port = await init();
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method: pathname.startsWith('/json/new') ? 'PUT' : 'GET'
  });
  if (!response.ok) throw new Error('DevTools request failed: ' + response.status);
  return response.json();
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Could not connect to Chromium DevTools.'));
    });
    this.ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.method) {
        const handlers = this.listeners.get(message.method);
        if (handlers) {
          for (const handler of [...handlers]) {
            try { handler(message.params || {}); } catch (_) {}
          }
        }
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || 'DevTools error'));
      else entry.resolve(message.result);
    };
    this.ws.onclose = () => {
      const error = new Error('Chromium connection closed.');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method).delete(handler);
  }

  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

async function chromeUserAgent(cdp) {
  try {
    const info = await cdp.send('Browser.getVersion');
    const match = /Chrome\/([\d.]+)/.exec(info.product || info.userAgent || '');
    const version = match ? match[1] : '131.0.0.0';
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/' + version + ' Safari/537.36';
  } catch (_) {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36';
  }
}

const SITE_ALIASES = {
  youtube: 'https://www.youtube.com/',
  chatgpt: 'https://chatgpt.com/',
  google: 'https://www.google.com/'
};

function safeUrl(input) {
  if (!input) return SITE_ALIASES.youtube;
  const value = String(input).trim();
  if (SITE_ALIASES[value.toLowerCase()]) return SITE_ALIASES[value.toLowerCase()];
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch (_) {}
  if (/^[\w-]+(?:\.[\w-]+)+(?:[/?#]|$)/.test(value)) return 'https://' + value;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(value);
}

function deviceMetrics(width, height) {
  return {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
    scale: 1
  };
}

async function resizeBrowserWindow(session, width, height) {
  if (!browserCdp) return;
  try {
    const win = await browserCdp.send('Browser.getWindowForTarget', { targetId: session.target.id });
    const vp = await session.cdp.send('Runtime.evaluate', {
      expression: '({w:innerWidth,h:innerHeight})',
      returnByValue: true
    });
    const current = vp.result && vp.result.value ? vp.result.value : {};
    const bounds = win.bounds || {};
    const extraW = Math.max(0, (bounds.width || width) - (current.w || width));
    const extraH = Math.max(0, (bounds.height || height) - (current.h || height));
    await browserCdp.send('Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: {
        width: width + extraW,
        height: height + extraH,
        windowState: bounds.windowState || 'normal'
      }
    });
  } catch (_) {}
}

class BrowserSession {
  static async create(input) {
    await init();
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.values().next().value;
      if (oldest) oldest.destroy();
      else break;
    }

    const target = await devtools('/json/new?about:blank');
    const session = new BrowserSession(target);
    await session.cdp.send('Page.enable');
    await session.cdp.send('Runtime.enable');
    await session.cdp.send('Network.enable');
    await session.cdp.send('Network.setUserAgentOverride', {
      userAgent: await chromeUserAgent(session.cdp),
      acceptLanguage: 'en-US,en;q=0.9'
    });
    if (ANTI_BOT) {
      await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: ANTI_BOT_BOOTSTRAP
      });
    }
    await session.cdp.send('Emulation.setDeviceMetricsOverride',
      deviceMetrics(session.width, session.height));
    await session.navigate(input);
    sessions.set(session.id, session);
    return session;
  }

  constructor(target) {
    this.id = Math.random().toString(36).slice(2, 12);
    this.target = target;
    this.cdp = new CDP(target.webSocketDebuggerUrl);
    this.width = 1280;
    this.height = 800;
    this.clients = new Set();
    this.timer = null;
    this.timerBusy = false;
    this.infoTimer = null;
    this.idleTimer = null;
    this.destroyed = false;
    this.streaming = false;
    this.streamMode = null;
    this.needsStreamRestart = false;
    this.gpu = null;
    this.gpuPending = false;
    this.frameSeq = 0;
    this.infoBusy = false;
    this.lastInfoKey = '';
    this.url = '';

    this.cdp.on('Page.screencastFrame', (params) => this.onScreencastFrame(params));
    this.cdp.on('Page.screencastStopped', () => { this.streamMode = null; });
  }

  async navigate(input) {
    this.url = safeUrl(input);
    await this.cdp.send('Page.navigate', { url: this.url });
  }

  async history(action) {
    if (action === 'reload') {
      await this.cdp.send('Page.reload', { ignoreCache: false });
      return;
    }
    const state = await this.cdp.send('Page.getNavigationHistory');
    const index = state.currentIndex + (action === 'back' ? -1 : 1);
    const entry = state.entries[index];
    if (entry) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  async info() {
    try {
      const result = await this.cdp.send('Runtime.evaluate', {
        expression: '({url: location.href, title: document.title})',
        returnByValue: true
      });
      return result.result.value || { url: this.url, title: '' };
    } catch (_) {
      return { url: this.url, title: '' };
    }
  }

  async historyState() {
    try {
      const state = await this.cdp.send('Page.getNavigationHistory');
      return {
        canBack: state.currentIndex > 0,
        canForward: state.currentIndex < state.entries.length - 1
      };
    } catch (_) {
      return { canBack: false, canForward: false };
    }
  }

  async gpuInfo() {
    try {
      const result = await this.cdp.send('Runtime.evaluate', {
        expression: [
          '(async () => {',
          '  if (!navigator.gpu) return { present: false, adapter: false };',
          '  try {',
          '    const adapter = await navigator.gpu.requestAdapter();',
          '    if (!adapter) return { present: true, adapter: false };',
          '    const info = adapter.info || {};',
          '    return { present: true, adapter: true, vendor: info.vendor || "", architecture: info.architecture || "", device: info.device || "" };',
          '  } catch (err) { return { present: true, adapter: false, error: String(err) }; }',
          '})()'
        ].join('\n'),
        awaitPromise: true,
        returnByValue: true
      });
      return result.result.value || { present: false, adapter: false };
    } catch (_) {
      return { present: false, adapter: false };
    }
  }

  sendGpu() {
    if (this.gpu) this.broadcast({ type: 'gpu', ...this.gpu });
  }

  scheduleGpuInfo() {
    if (!GPU_STATUS || this.gpu || this.gpuPending || this.destroyed) return;
    this.gpuPending = true;
    const timer = setTimeout(() => {
      if (this.destroyed) return;
      this.gpuInfo().then((info) => {
        this.gpu = info;
        this.sendGpu();
      }).catch(() => {}).finally(() => { this.gpuPending = false; });
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async frame() {
    const base = {
      format: SCREENCAST_FORMAT,
      quality: SCREENCAST_QUALITY,
      captureBeyondViewport: false
    };
    try {
      const result = await this.cdp.send('Page.captureScreenshot', {
        ...base,
        optimizeForSpeed: true
      });
      return result.data;
    } catch (_) {
      try {
        const result = await this.cdp.send('Page.captureScreenshot', base);
        return result.data;
      } catch (_) {
        return null;
      }
    }
  }

  broadcast(message) {
    const payload = Buffer.from(JSON.stringify(message));
    const frame = encodeFrame(0x1, payload);
    for (const socket of this.clients) {
      if (!socket.destroyed && socket.writable) {
        try { socket.write(frame); } catch (_) {}
      }
    }
  }

  broadcastFrame(data) {
    if (!data || this.clients.size === 0) return;
    this.broadcast({
      type: 'frame',
      seq: ++this.frameSeq,
      mime: 'image/' + SCREENCAST_FORMAT,
      data
    });
  }

  onScreencastFrame(params) {
    if (!params || !params.data) return;
    this.broadcastFrame(params.data);
    if (params.sessionId) {
      this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }
  }

  async pushInfo() {
    if (this.infoBusy || this.clients.size === 0) return;
    this.infoBusy = true;
    try {
      const info = await this.info();
      const key = info.url + '\n' + info.title;
      if (key !== this.lastInfoKey) {
        this.lastInfoKey = key;
        const history = await this.historyState();
        this.broadcast({ type: 'info', ...info, ...history });
      }
    } catch (_) {}
    this.infoBusy = false;
  }

  async startStreaming() {
    if (this.streaming || this.destroyed) return;
    this.streaming = true;
    this.lastInfoKey = '';

    let screencast = false;
    if (USE_SCREENCAST) {
      try {
        await this.startScreencast();
        screencast = true;
        this.streamMode = 'screencast';
        if (this.needsStreamRestart) {
          this.needsStreamRestart = false;
          await this.cdp.send('Page.stopScreencast').catch(() => {});
          await this.startScreencast();
        }
      } catch (_) {}
    }

    if (!screencast) {
      this.streamMode = 'poll';
      this.timer = setInterval(async () => {
        if (this.clients.size === 0 || this.timerBusy) return;
        this.timerBusy = true;
        const data = await this.frame();
        if (data) this.broadcastFrame(data);
        this.timerBusy = false;
      }, FRAME_MS);
    }

    const initial = await this.frame();
    if (initial) this.broadcastFrame(initial);
    this.scheduleGpuInfo();

    this.pushInfo().catch(() => {});
    this.infoTimer = setInterval(() => this.pushInfo().catch(() => {}), INFO_MS);
  }

  stopStreaming() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.infoTimer) clearInterval(this.infoTimer);
    this.infoTimer = null;
    if (this.streamMode === 'screencast') {
      this.streamMode = null;
      this.cdp.send('Page.stopScreencast').catch(() => {});
    }
    this.streaming = false;
  }

  async startScreencast() {
    await this.cdp.send('Page.startScreencast', {
      format: SCREENCAST_FORMAT,
      quality: SCREENCAST_QUALITY,
      everyNthFrame: 1,
      useOpaqueBackground: true
    });
  }

  async setViewport(width, height) {
    const w = Math.max(320, Number(width) || this.width);
    const h = Math.max(240, Number(height) || this.height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    await resizeBrowserWindow(this, w, h);
    await this.cdp.send('Emulation.setDeviceMetricsOverride', deviceMetrics(w, h));
    if (this.streaming && this.streamMode === 'screencast') {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      await this.startScreencast();
      const data = await this.frame();
      if (data) this.broadcastFrame(data);
    } else if (this.streaming && !this.streamMode) {
      this.needsStreamRestart = true;
    }
  }

  async input(message) {
    try {
      if (message.type === 'mouse') {
        const button = message.button === 2 ? 'right' : message.button === 1 ? 'middle' : 'left';
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: message.action,
          x: message.x,
          y: message.y,
          button,
          buttons: message.buttons || 0,
          clickCount: message.clickCount || 1
        });
      } else if (message.type === 'wheel') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: message.x,
          y: message.y,
          button: 'none',
          buttons: 0,
          deltaX: message.deltaX || 0,
          deltaY: message.deltaY || 0
        });
      } else if (message.type === 'text') {
        await this.cdp.send('Input.insertText', { text: String(message.text || '') });
      } else if (message.type === 'key') {
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: message.action || 'keyDown',
          key: message.key,
          code: message.code || '',
          windowsVirtualKeyCode: message.keyCode || 0,
          nativeVirtualKeyCode: message.keyCode || 0,
          modifiers: message.modifiers || 0,
          text: message.text || undefined
        });
      } else if (message.type === 'resize') {
        await this.setViewport(message.width, message.height);
      }
    } catch (_) {}
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopStreaming();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.cdp.close();
    sessions.delete(this.id);
    if (devtoolsPort) {
      fetch('http://127.0.0.1:' + devtoolsPort + '/json/close/' + this.target.id).catch(() => {});
    }
  }
}

export async function createBrowserSession(input) {
  const session = await BrowserSession.create(input);
  return session.id;
}

export function browserSessionExists(id) {
  return sessions.has(id);
}

export function browserErrorPage(message) {
  const text = String(message || 'Browser mode is unavailable.').replace(/[<>&]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;'
  }[c]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser mode unavailable — Classroom Browser</title>
<link rel="stylesheet" href="/style.css"></head>
<body><main><h1>Browser mode unavailable</h1>
<p class="sub">${text}</p>
<p class="sub"><a href="/">Back to Classroom Browser</a></p></main></body></html>`;
}

export function browserPage(id) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Classroom Web Browser</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#000;color:#e8eaf0;font:13px system-ui,sans-serif;overflow:hidden}
#wrap{position:fixed;inset:0;overflow:hidden;background:#000}
canvas{display:block;width:100%;height:100%;background:#fff;cursor:default;outline:none}
#bar{position:fixed;left:0;right:0;bottom:0;height:46px;display:flex;align-items:center;gap:6px;padding:0 8px;background:#171a21e6;backdrop-filter:blur(8px);border-top:1px solid #2b3040;z-index:10;transition:transform .18s ease,opacity .18s ease}
#bar.hidden{transform:translateY(100%);opacity:0;pointer-events:none}
#bar input{flex:1;min-width:0;height:28px;padding:0 9px;background:#0f1117;color:#e8eaf0;border:1px solid #3c414f;border-radius:5px;outline:none;font:inherit}
button{height:28px;padding:0 10px;background:#2b2f3a;color:#e8eaf0;border:1px solid #3c414f;border-radius:5px;cursor:pointer;font:inherit;white-space:nowrap}
button:hover{border-color:#7aa2ff}
button:disabled{opacity:.4;cursor:default}
#gpu{font-size:11px;color:#97a0b5;border:1px solid #2c3446;padding:3px 7px;border-radius:999px;white-space:nowrap}
#gpu.ok{color:#8be29a;border-color:#2f6a41}
#gpu.off{color:#d99a9a;border-color:#6a3535}
#status{font-size:11px;color:#9ec5ff;white-space:nowrap;padding:0 4px}
</style></head><body>
<div id="bar">
  <button id="back" title="Back">&#8592;</button>
  <button id="forward" title="Forward">&#8594;</button>
  <button id="reload" title="Reload">&#8635;</button>
  <button id="home" title="Classroom Browser home">&#8962;</button>
  <button id="full" title="Fullscreen">&#9974;</button>
  <span id="gpu" title="WebGPU status">GPU …</span>
  <span id="status">connecting…</span>
  <input id="url" spellcheck="false" autocomplete="off" aria-label="Address bar">
  <button id="go">Go</button>
  <button id="proxy" title="Open in standard web mode">Standard mode</button>
</div>
<div id="wrap"><canvas id="screen" width="1280" height="800" tabindex="0"></canvas></div>
<script>
(function(){
  var id=${JSON.stringify(id)};
  var canvas=document.getElementById('screen'),ctx=canvas.getContext('2d');
  var bar=document.getElementById('bar');
  var input=document.getElementById('url'),status=document.getElementById('status');
  var back=document.getElementById('back'),forward=document.getElementById('forward');
  var gpu=document.getElementById('gpu'),hideTimer=null;
  var ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/bws/'+id);
  var lastSeq=0,drawing=false,queued=null;
  function send(m){ if(ws.readyState===1) ws.send(JSON.stringify(m)); }
  function base64Bytes(b64){
    var bin=atob(b64),len=bin.length,out=new Uint8Array(len);
    for(var i=0;i<len;i++)out[i]=bin.charCodeAt(i);
    return out;
  }
  function drawSource(src){
    var sw=src.naturalWidth||src.width||canvas.width;
    var sh=src.naturalHeight||src.height||canvas.height;
    var scale=Math.min(canvas.width/sw,canvas.height/sh);
    var dw=Math.max(1,Math.round(sw*scale)),dh=Math.max(1,Math.round(sh*scale));
    var dx=Math.floor((canvas.width-dw)/2),dy=Math.floor((canvas.height-dh)/2);
    ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(src,dx,dy,dw,dh);
    window.__lastFrameSize={source:[sw,sh],dest:[dw,dh],offset:[dx,dy],scale:scale};
  }
  function render(m){
    drawing=true;
    var mime=m.mime||'image/jpeg';
    function done(){drawing=false;if(queued){var q=queued;queued=null;render(q);}}
    if(typeof createImageBitmap==='function'){
      createImageBitmap(new Blob([base64Bytes(m.data)],{type:mime})).then(function(bitmap){
        drawSource(bitmap);
        if(bitmap.close)bitmap.close();
        done();
      }).catch(done);
    } else {
      var img=new Image();
      img.onload=function(){drawSource(img);done();};
      img.onerror=done;
      img.src='data:'+mime+';base64,'+m.data;
    }
  }
  function normalize(v){
    v=String(v||'').trim();
    if(!v) return '';
    if(/^[a-z][a-z0-9+.-]*:\\/\\//i.test(v)) return v;
    if(/^[\\w-]+(?:\\.[\\w-]+)+(?:[/?#]|$)/.test(v)) return 'https://'+v;
    return 'https://duckduckgo.com/?q='+encodeURIComponent(v);
  }
  function coords(e){
    var r=canvas.getBoundingClientRect();
    var x=(e.clientX-r.left)*canvas.width/r.width;
    var y=(e.clientY-r.top)*canvas.height/r.height;
    var f=window.__lastFrameSize;
    if(f&&f.scale&&f.source&&f.offset){
      x=(x-f.offset[0])/f.scale;
      y=(y-f.offset[1])/f.scale;
    }
    return {x:Math.max(0,Math.round(x)),y:Math.max(0,Math.round(y)),buttons:e.buttons||0};
  }
  function modifiers(e){return (e.ctrlKey?1:0)|(e.altKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);}
  function showBar(){
    bar.classList.remove('hidden');
    clearTimeout(hideTimer);
    hideTimer=setTimeout(function(){if(document.activeElement!==input&&!bar.matches(':hover'))bar.classList.add('hidden');},2500);
  }
  function resize(){
    var w=Math.max(320,window.innerWidth||1280),h=Math.max(240,window.innerHeight||800);
    canvas.width=w;canvas.height=h;
    send({type:'resize',width:w,height:h});
  }
  ws.onopen=function(){status.textContent='connected';resize();showBar();};
  ws.onclose=function(){status.textContent='disconnected';};
  ws.onerror=function(){status.textContent='connection error';};
  ws.onmessage=function(e){
    var m;
    try{m=JSON.parse(e.data);}catch(_){return;}
    if(m.type==='frame'){
      if(m.seq&&m.seq<=lastSeq)return;
      lastSeq=m.seq||lastSeq+1;
      if(drawing){queued=m;return;}
      render(m);
      if(status.textContent!=='live')status.textContent='live';
    } else if(m.type==='gpu'){
      if(m.adapter){
        gpu.textContent='GPU '+(m.architecture||m.vendor||'on');
        gpu.className='gpu ok';
        gpu.title='WebGPU: '+[m.vendor,m.architecture,m.device].filter(Boolean).join(' / ');
      } else {
        gpu.textContent=m.present?'GPU no adapter':'GPU -';
        gpu.className='gpu off';
        gpu.title='WebGPU is unavailable in this browser context';
      }
    } else if(m.type==='info'){
      if(document.activeElement!==input) input.value=m.url||'';
      document.title=(m.title||'Classroom Browser')+' — Classroom Browser';
      back.disabled=!m.canBack;
      forward.disabled=!m.canForward;
    }
  };
  function go(){var v=normalize(input.value);if(!v)return;status.textContent='loading…';send({type:'navigate',url:v});}
  document.getElementById('go').onclick=go;
  input.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();go();}};
  back.onclick=function(){send({type:'history',action:'back'});};
  forward.onclick=function(){send({type:'history',action:'forward'});};
  document.getElementById('reload').onclick=function(){send({type:'history',action:'reload'});};
  document.getElementById('home').onclick=function(){location.href='/';};
  document.getElementById('proxy').onclick=function(){var v=normalize(input.value);if(v)location.href='/p/'+encodeURIComponent(v);};
  document.getElementById('full').onclick=function(){
    if(document.fullscreenElement){document.exitFullscreen();}
    else{document.documentElement.requestFullscreen().catch(function(){});}
  };
  window.addEventListener('resize',resize);
  document.addEventListener('mousemove',function(e){if(e.clientY>window.innerHeight-70)showBar();});
  bar.addEventListener('mouseenter',function(){clearTimeout(hideTimer);});
  bar.addEventListener('mouseleave',showBar);
  input.addEventListener('focus',showBar);
  canvas.addEventListener('mousedown',function(e){var p=coords(e);canvas.focus();input.blur();send({type:'mouse',action:'mousePressed',x:p.x,y:p.y,button:e.button,buttons:p.buttons});e.preventDefault();});
  canvas.addEventListener('mouseup',function(e){var p=coords(e);send({type:'mouse',action:'mouseReleased',x:p.x,y:p.y,button:e.button,buttons:p.buttons});});
  canvas.addEventListener('mousemove',function(e){var p=coords(e);send({type:'mouse',action:'mouseMoved',x:p.x,y:p.y,buttons:p.buttons});});
  canvas.addEventListener('wheel',function(e){var p=coords(e);send({type:'wheel',x:p.x,y:p.y,deltaX:e.deltaX,deltaY:e.deltaY});e.preventDefault();},{passive:false});
  canvas.addEventListener('contextmenu',function(e){e.preventDefault();});
  window.addEventListener('keydown',function(e){
    if(document.activeElement===input)return;
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
      send({type:'text',text:e.key});
      e.preventDefault();
      return;
    }
    send({type:'key',action:'keyDown',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e),text:e.key.length===1?e.key:undefined});
  });
  window.addEventListener('keyup',function(e){
    if(document.activeElement===input)return;
    send({type:'key',action:'keyUp',key:e.key,code:e.code,keyCode:e.keyCode,modifiers:modifiers(e)});
  });
})();
</script></body></html>`;
}

export function attachBrowserWS(req, socket) {
  let id;
  try {
    id = decodeURIComponent(new URL('http://' + (req.headers.host || 'localhost') + req.url).pathname.slice(5));
  } catch (_) {
    socket.destroy();
    return;
  }

  const session = sessions.get(id);
  if (!session || session.destroyed) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = String(req.headers['sec-websocket-key'] || '');
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  session.clients.add(socket);
  session.startStreaming();
  session.sendGpu();

  let pending = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;

  function handle(frame) {
    if (frame.opcode === 0x8) {
      session.clients.delete(socket);
      try { socket.end(encodeFrame(0x8, Buffer.alloc(0))); } catch (_) {}
      return;
    }
    if (frame.opcode === 0x9) {
      try { socket.write(encodeFrame(0xa, frame.payload)); } catch (_) {}
      return;
    }
    if (frame.opcode === 0xa) return;

    let payload = frame.payload;
    if (!frame.fin) {
      fragmentOpcode = frame.opcode || fragmentOpcode;
      fragments.push(frame.payload);
      return;
    }
    if (fragments.length) {
      fragments.push(frame.payload);
      payload = Buffer.concat(fragments);
      fragments = [];
    }
    if (fragmentOpcode && fragmentOpcode !== 0x1) return;

    let message;
    try { message = JSON.parse(payload.toString('utf8')); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'navigate') session.navigate(message.url).catch(() => {});
    else if (message.type === 'history') session.history(message.action).catch(() => {});
    else session.input(message).catch(() => {});
  }

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const consumed = readFrames(pending, handle);
    pending = pending.slice(consumed);
  });

  socket.on('close', () => {
    session.clients.delete(socket);
    if (session.clients.size === 0) {
      session.stopStreaming();
      session.idleTimer = setTimeout(() => session.destroy(), 60000);
      if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
    }
  });
  socket.on('error', () => {});
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function readFrames(buffer, onFrame) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let pos = offset + 2;

    if (length === 126) {
      if (pos + 2 > buffer.length) return offset;
      length = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (length === 127) {
      if (pos + 8 > buffer.length) return offset;
      length = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }

    let mask = null;
    if (masked) {
      if (pos + 4 > buffer.length) return offset;
      mask = buffer.slice(pos, pos + 4);
      pos += 4;
    }
    if (pos + length > buffer.length) return offset;

    let payload = buffer.slice(pos, pos + length);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }

    onFrame({ fin, opcode, payload });
    offset = pos + length;
  }
  return offset;
}

process.on('exit', () => {
  if (chromeProcess && !chromeProcess.killed) {
    try { chromeProcess.kill('SIGTERM'); } catch (_) {}
  }
});
