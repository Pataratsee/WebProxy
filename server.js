/*
 * Node entry point for WebProxy.
 *
 * Adapts node:http to the fetch handler in worker.js, so the site behaves the
 * same locally as it does on Cloudflare Workers.
 *
 * Run:  node server.js
 * Then: open http://localhost:3000
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { isBlockedTarget } from './worker.js';
import {
  attachBrowserWS,
  browserErrorPage,
  browserPage,
  browserSessionExists,
  createBrowserSession
} from './browser.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ */
/* Static files, exposed to worker.js as env.ASSETS                    */
/* ------------------------------------------------------------------ */

async function fetchAsset(request) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch (_) {
    return new Response('Not found', { status: 404 });
  }

  const file = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      }
    });
  } catch (_) {
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
}

const ASSET_ENV = { ASSETS: { fetch: fetchAsset } };

/* ------------------------------------------------------------------ */
/* node:http <-> fetch                                                 */
/* ------------------------------------------------------------------ */

const FORWARDED_REQUEST_HEADERS = [
  'cookie', 'accept', 'accept-language', 'accept-charset', 'content-type', 'range',
  'referer', 'authorization', 'x-requested-with', 'user-agent',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toRequest(req) {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }

  const host = req.headers.host || 'localhost';
  const bodyless = req.method === 'GET' || req.method === 'HEAD';
  const body = bodyless ? undefined : await readBody(req);

  return new Request('http://' + host + (req.url || '/'), {
    method: req.method,
    headers,
    body
  });
}

async function sendResponse(res, response, method) {
  const body = Buffer.from(await response.arrayBuffer());
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];

  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') continue;
    res.setHeader(key, value);
  }
  if (setCookies.length) res.setHeader('set-cookie', setCookies);
  if (method !== 'HEAD' && response.status !== 204 && response.status !== 304) {
    res.setHeader('content-length', body.length);
  }
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* WebSocket bridge                                                    */
/* ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
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
    let len = b1 & 0x7f;
    let pos = offset + 2;

    if (len === 126) {
      if (pos + 2 > buffer.length) return offset;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buffer.length) return offset;
      len = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }

    let mask = null;
    if (masked) {
      if (pos + 4 > buffer.length) return offset;
      mask = buffer.slice(pos, pos + 4);
      pos += 4;
    }
    if (pos + len > buffer.length) return offset;

    let payload = buffer.slice(pos, pos + len);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }

    onFrame({ fin, opcode, payload });
    offset = pos + len;
  }
  return offset;
}

function handleUpgrade(req, socket) {
  let parsed;
  try { parsed = new URL('http://' + (req.headers.host || 'localhost') + req.url); } catch (_) {
    socket.destroy();
    return;
  }

  let target;
  try { target = decodeURIComponent(parsed.pathname.slice(4)); } catch (_) {
    socket.destroy();
    return;
  }
  target = target.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  if (isBlockedTarget(target) || !/^https?:\/\//i.test(target)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const protocols = parsed.searchParams.get('protocols');
  let upstream;
  try {
    upstream = protocols ? new WebSocket(target, protocols.split(',')) : new WebSocket(target);
  } catch (_) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  upstream.binaryType = 'arraybuffer';

  let handshaken = false;
  function handshake(protocol) {
    if (handshaken) return;
    handshaken = true;
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    let head = 'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n';
    if (protocol) head += 'Sec-WebSocket-Protocol: ' + protocol + '\r\n';
    socket.write(head + '\r\n');
  }

  upstream.onopen = () => handshake(upstream.protocol || '');
  upstream.onerror = () => {
    if (!handshaken) socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  };
  upstream.onmessage = (event) => {
    if (!handshaken) return;
    const payload = Buffer.from(typeof event.data === 'string'
      ? event.data
      : new Uint8Array(event.data));
    try { socket.write(encodeFrame(typeof event.data === 'string' ? 0x1 : 0x2, payload)); } catch (_) {}
  };
  upstream.onclose = (event) => {
    if (!handshaken) { socket.destroy(); return; }
    const code = event.code || 1000;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try { socket.end(encodeFrame(0x8, body)); } catch (_) {}
  };

  let pending = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;

  function sendToUpstream(opcode, data) {
    try {
      upstream.send(opcode === 0x2 || opcode === 0x0 ? new Uint8Array(data) : data.toString('utf8'));
    } catch (_) {}
  }

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const consumed = readFrames(pending, (frame) => {
      if (frame.opcode === 0x8) {
        try { upstream.close(); } catch (_) {}
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        try { socket.write(encodeFrame(0x0a, frame.payload)); } catch (_) {}
        return;
      }
      if (frame.opcode === 0x0a) return;
      if (frame.opcode === 0x0) {
        fragments.push(frame.payload);
        if (frame.fin) {
          const data = Buffer.concat(fragments);
          fragments = [];
          sendToUpstream(fragmentOpcode, data);
        }
        return;
      }
      if (!frame.fin) {
        fragmentOpcode = frame.opcode;
        fragments = [frame.payload];
        return;
      }
      sendToUpstream(frame.opcode, frame.payload);
    });
    pending = pending.slice(consumed);
  });
  socket.on('close', () => { try { upstream.close(); } catch (_) {} });
  socket.on('error', () => { try { upstream.close(); } catch (_) {} });
}

/* ------------------------------------------------------------------ */
/* Real-browser mode (Node only)                                       */
/* ------------------------------------------------------------------ */

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function handleBrowserRoute(req, res) {
  let url;
  try {
    url = new URL('http://' + (req.headers.host || 'localhost') + (req.url || '/'));
  } catch (_) {
    return false;
  }

  if (url.pathname === '/b/new') {
    const target = url.searchParams.get('url') || 'https://www.youtube.com/';
    try {
      const id = await createBrowserSession(target);
      res.writeHead(302, { Location: '/b/' + id, 'cache-control': 'no-store' });
      res.end();
    } catch (err) {
      sendHtml(res, 500, browserErrorPage(err && err.message ? err.message : String(err)));
    }
    return true;
  }

  const match = /^\/b\/([A-Za-z0-9]+)$/.exec(url.pathname);
  if (match) {
    if (!browserSessionExists(match[1])) {
      sendHtml(res, 404, browserErrorPage('That browser session has expired. Open a new one from the home page.'));
    } else {
      sendHtml(res, 200, browserPage(match[1]));
    }
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  try {
    if (await handleBrowserRoute(req, res)) return;
    const request = await toRequest(req);
    const response = await worker.fetch(request, ASSET_ENV);
    await sendResponse(res, response, request.method);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Server error: ' + (err && err.message ? err.message : String(err)));
  }
});

server.on('upgrade', (req, socket) => {
  let pathname;
  try {
    pathname = new URL('http://' + (req.headers.host || 'localhost') + req.url).pathname;
  } catch (_) {
    socket.destroy();
    return;
  }
  if (pathname.startsWith('/bws/')) {
    attachBrowserWS(req, socket);
    return;
  }
  handleUpgrade(req, socket);
});

server.listen(PORT, HOST, () => {
  console.log('Web proxy running at http://localhost:' + PORT);
  console.log('Real browser mode: /b/new?url=https://www.youtube.com/');
});
