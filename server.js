// Zero-dependency server for the ID-JAG MCP caller UI.
//
// It serves the static UI from ./public and exposes POST /api/relay, which performs the
// MCP HTTP call server-side and reports the exact request headers written to the wire and
// every response header received (order, casing and duplicates preserved). Doing the call
// from here, instead of from the browser, avoids two blind spots that matter when you
// validate ID-JAG behavior through a gateway:
//   - the browser hides the headers it adds itself (Host, Cookie, User-Agent, Origin, ...);
//   - cross-origin, JS only sees the CORS-safelisted response headers unless the gateway
//     sends Access-Control-Expose-Headers (so WWW-Authenticate would be invisible).
//
// The relay forwards to any URL it is given, so it binds to 127.0.0.1 by default.

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 5173);
const DEFAULT_MCP_URL = process.env.MCP_URL ?? 'http://localhost:8000/mcp';
const INSECURE_TLS = process.env.INSECURE_TLS === '1';
const USER_AGENT = 'idjag-mcp-caller-ui/0.1.0';
const MAX_RELAY_INPUT = 1024 * 1024; // 1 MiB request from the UI
const MAX_RESPONSE_BODY = 5 * 1024 * 1024; // 5 MiB kept from the upstream response
const DEFAULT_TIMEOUT_MS = 30_000;

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Node keeps the exact header block it wrote in `_header` (a long-standing internal field).
// Parsing it shows what actually went on the wire, including anything Node added on its own.
function parseWireHeaderBlock(block) {
  const lines = block.split('\r\n').filter(Boolean);
  const requestLine = lines.shift() ?? '';
  const headers = lines.map((line) => {
    const i = line.indexOf(':');
    return [line.slice(0, i), line.slice(i + 1).trim()];
  });
  return { requestLine, headers };
}

function pairs(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  return out;
}

function decodeBody(buf, encoding) {
  const enc = (encoding ?? '').trim().toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return { text: zlib.gunzipSync(buf).toString('utf8'), decodedFrom: enc };
    if (enc === 'br') return { text: zlib.brotliDecompressSync(buf).toString('utf8'), decodedFrom: enc };
    if (enc === 'deflate') return { text: zlib.inflateSync(buf).toString('utf8'), decodedFrom: enc };
  } catch {
    // fall through and show the raw bytes as text
  }
  return { text: buf.toString('utf8'), decodedFrom: null };
}

function relay({ url, method = 'POST', headers = [], body = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only http(s) URLs are supported');
    } catch (e) {
      resolve({ error: { code: 'BAD_URL', message: e.message } });
      return;
    }

    const lib = target.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body ?? '', 'utf8');
    const userHeaders = headers.filter(([n]) => typeof n === 'string' && n.trim() !== '');
    const has = (name) => userHeaders.some(([n]) => n.toLowerCase() === name);

    // Every header is set explicitly so nothing is implied: what you see is what is sent.
    const finalHeaders = [];
    if (!has('host')) finalHeaders.push(['Host', target.host]);
    if (!has('user-agent')) finalHeaders.push(['User-Agent', USER_AGENT]);
    finalHeaders.push(...userHeaders.map(([n, v]) => [n.trim(), String(v ?? '')]));
    if (method !== 'GET' && method !== 'HEAD' && !has('content-length')) {
      finalHeaders.push(['Content-Length', String(payload.length)]);
    }
    if (!has('connection')) finalHeaders.push(['Connection', 'close']);

    const startedAt = Date.now();
    const t0 = performance.now();
    let ttfb = null;

    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || undefined,
      path: target.pathname + target.search,
      method,
      agent: false,
      setHost: false,
      rejectUnauthorized: !INSECURE_TLS,
      // Flat [name, value, name, value, ...] keeps order, casing and duplicates.
      headers: finalHeaders.flat(),
    });

    const requestInfo = () => {
      const wire = typeof req._header === 'string' ? parseWireHeaderBlock(req._header) : null;
      return {
        method,
        url: target.href,
        requestLine: wire?.requestLine ?? `${method} ${target.pathname}${target.search} HTTP/1.1`,
        headers: wire?.headers ?? finalHeaders,
        headersSource: wire ? 'wire' : 'configured',
        body: payload.toString('utf8'),
      };
    };

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        request: requestInfo(),
        timing: { startedAt, ttfbMs: ttfb, totalMs: Math.round(performance.now() - t0) },
      });
    };

    let response = null;
    const chunks = [];
    let received = 0;
    let truncated = null;

    const buildResponse = () => {
      const buf = Buffer.concat(chunks);
      const encoding = response.headers['content-encoding'];
      const { text, decodedFrom } = decodeBody(buf, encoding);
      return {
        httpVersion: response.httpVersion,
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: pairs(response.rawHeaders),
        trailers: pairs(response.rawTrailers ?? []),
        body: text,
        bodyBytes: received,
        decodedFrom,
        truncated,
        tls: response.socket?.getProtocol ? response.socket.getProtocol() : null,
      };
    };

    // An event-stream may stay open (e.g. subscriptions/listen): on timeout we still report
    // the headers and whatever arrived.
    const timer = setTimeout(() => {
      if (response) {
        truncated = 'timeout';
        finish({ response: buildResponse() });
      } else {
        finish({ error: { code: 'TIMEOUT', message: `No response within ${timeoutMs} ms` } });
      }
      req.destroy();
    }, timeoutMs);

    req.on('response', (res) => {
      response = res;
      ttfb = Math.round(performance.now() - t0);
      res.on('data', (c) => {
        received += c.length;
        if (received <= MAX_RESPONSE_BODY) chunks.push(c);
        else truncated = 'size';
      });
      res.on('end', () => finish({ response: buildResponse() }));
      res.on('error', (e) => finish({ response: buildResponse(), error: { code: e.code ?? 'ERROR', message: e.message } }));
    });
    req.on('error', (e) => {
      if (response) return; // already reported through the response handlers
      // "localhost" may resolve to several addresses: Node then reports an AggregateError
      // with an empty message and the per-address failures in `errors`.
      const message = e.message || (e.errors ?? []).map((x) => x.message).join('; ') || 'Connection failed';
      finish({ error: { code: e.code ?? 'ERROR', message } });
    });

    if (method === 'GET' || method === 'HEAD') req.end();
    else req.end(payload);
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      sendJson(res, 200, { defaultUrl: DEFAULT_MCP_URL, userAgent: USER_AGENT, insecureTls: INSECURE_TLS });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/relay') {
      const raw = await readBody(req, MAX_RELAY_INPUT);
      const input = JSON.parse(raw.toString('utf8'));
      sendJson(res, 200, await relay(input));
      return;
    }
    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }
    res.writeHead(405).end();
  } catch (e) {
    sendJson(res, e.status ?? 400, { error: { code: 'RELAY_INPUT', message: e.message } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ID-JAG MCP caller UI on http://${HOST}:${PORT}  (default MCP endpoint: ${DEFAULT_MCP_URL})`);
  if (INSECURE_TLS) console.log('INSECURE_TLS=1: TLS certificates are not verified.');
});

// As PID 1 in a container, Node gets no default SIGTERM/SIGINT handling: stop accepting
// connections and exit, so Kubernetes rollouts don't wait for the full grace period.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
