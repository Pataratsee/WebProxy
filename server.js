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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

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
  'cookie', 'accept', 'accept-language', 'content-type', 'range',
  'referer', 'authorization', 'x-requested-with', 'user-agent'
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
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  try {
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

server.listen(PORT, HOST, () => {
  console.log('Web proxy running at http://localhost:' + PORT);
});
