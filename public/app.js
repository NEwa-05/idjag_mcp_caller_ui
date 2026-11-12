// ID-JAG MCP caller: a small MCP (2026-07-28, stateless streamable HTTP) client that records
// every HTTP exchange and shows request and response headers side by side.

const CLIENT_INFO = { name: 'idjag-mcp-caller-ui', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2026-07-28';
const NAME_BEARING_METHODS = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };
const BROWSER_ADDED_HEADERS = 'Host, Origin, Referer, User-Agent, Cookie, Accept-Encoding, Accept-Language, Connection, Content-Length, Sec-Fetch-*, Sec-CH-*';
const AUTH_HEADER = /^(authorization|proxy-authorization|www-authenticate|proxy-authenticate|cookie|set-cookie|dpop|dpop-nonce)$|auth|token|jag|identity|x-forwarded-user|x-user|x-email|x-client/i;
const JWT_IN_VALUE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- persisted settings (per browser; storage may be unavailable) ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`idjag-ui:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`idjag-ui:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

const state = {
  nextId: 1,
  seq: 0,
  tools: [],
  customHeaders: store.get('customHeaders', [
    { enabled: false, name: 'Authorization', value: 'Bearer <token>' },
  ]),
};

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function pretty(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

// Mirrors the SDK's encode_header_value: printable ASCII passes verbatim, anything else is
// base64-wrapped in the =?base64?...?= sentinel.
function encodeHeaderValue(value) {
  const safe = /^[\x20-\x7E]*$/.test(value) && value === value.trim() && !/^=\?base64\?.*\?=$/.test(value);
  if (safe) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`;
}

function b64urlDecode(seg) {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(seg.length / 4) * 4, '=');
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function decodeJwt(token) {
  try {
    const [h, p] = token.split('.');
    return { header: JSON.parse(b64urlDecode(h)), payload: JSON.parse(b64urlDecode(p)) };
  } catch { return null; }
}

function describeTime(seconds) {
  if (typeof seconds !== 'number') return null;
  const d = new Date(seconds * 1000);
  const delta = Math.round(seconds - Date.now() / 1000);
  const rel = Math.abs(delta) < 120 ? `${Math.abs(delta)}s` : Math.abs(delta) < 7200 ? `${Math.round(Math.abs(delta) / 60)}m` : `${Math.round(Math.abs(delta) / 3600)}h`;
  return `${d.toISOString()} (${delta >= 0 ? 'in ' + rel : rel + ' ago'})`;
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = 'copied';
      setTimeout(() => { button.textContent = label; }, 1200);
    }
  } catch { /* clipboard blocked: nothing to do */ }
}

// ---------- SSE parsing (responses may be text/event-stream) ----------
function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const ev = { event: 'message', data: [] };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'data') ev.data.push(value);
      else if (field === 'event') ev.event = value;
      else if (field === 'id') ev.id = value;
    }
    ev.data = ev.data.join('\n');
    try { ev.json = JSON.parse(ev.data); } catch { /* keep raw */ }
    events.push(ev);
  }
  return events;
}

function headerLookup(headers, name) {
  const found = headers.find(([n]) => n.toLowerCase() === name);
  return found ? found[1] : undefined;
}

function extractJsonRpc(response, id) {
  if (!response || !response.body) return null;
  const ct = headerLookup(response.headers, 'content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const events = parseSse(response.body);
    const msgs = events.map((e) => e.json).filter(Boolean);
    return { message: msgs.find((m) => m.id === id) ?? msgs.at(-1) ?? null, events };
  }
  try { return { message: JSON.parse(response.body) }; } catch { return { message: null }; }
}

// ---------- transports ----------
async function sendViaRelay({ url, headers, body }) {
  const res = await fetch('/api/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method: 'POST', headers, body }),
  });
  return res.json();
}

async function sendViaBrowser({ url, headers, body }) {
  const t0 = performance.now();
  const request = {
    method: 'POST',
    url,
    requestLine: `POST ${url}`,
    headers,
    headersSource: 'browser',
    body,
  };
  try {
    const res = await fetch(url, { method: 'POST', headers, body, credentials: 'include', redirect: 'manual' });
    const ttfbMs = Math.round(performance.now() - t0);
    const text = await res.text();
    return {
      request,
      response: {
        httpVersion: null,
        status: res.status,
        statusText: res.statusText,
        type: res.type,
        headers: [...res.headers.entries()],
        trailers: [],
        body: text,
        bodyBytes: text.length,
      },
      timing: { startedAt: Date.now(), ttfbMs, totalMs: Math.round(performance.now() - t0) },
    };
  } catch (e) {
    return {
      request,
      error: { code: 'FETCH_FAILED', message: `${e.message}. Cross-origin calls need CORS on the gateway (Access-Control-Allow-Origin, -Allow-Headers for Mcp-* and Authorization, -Allow-Credentials). Switch to Relay mode to bypass it.` },
      timing: { startedAt: Date.now(), ttfbMs: null, totalMs: Math.round(performance.now() - t0) },
    };
  }
}

// ---------- MCP call ----------
function paramHeadersFor(toolName, args) {
  const tool = state.tools.find((t) => t.name === toolName);
  const out = [];
  const walk = (schema, value) => {
    if (!schema || typeof schema !== 'object' || !schema.properties) return;
    for (const [key, sub] of Object.entries(schema.properties)) {
      const v = value?.[key];
      if (sub && typeof sub['x-mcp-header'] === 'string' && v !== undefined && v !== null && typeof v !== 'object') {
        out.push([`Mcp-Param-${sub['x-mcp-header']}`, encodeHeaderValue(typeof v === 'boolean' ? String(v) : String(v))]);
      }
      if (v && typeof v === 'object') walk(sub, v);
    }
  };
  walk(tool?.inputSchema, args);
  return out;
}

async function mcpCall(method, params = {}) {
  const protocol = $('#protocol-version').value.trim() || DEFAULT_PROTOCOL;
  const url = $('#endpoint').value.trim();
  const mode = $('#mode').value;
  const id = state.nextId++;

  const envelope = {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...(params._meta ?? {}),
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };

  const headers = [
    ['Accept', 'application/json, text/event-stream'],
    ['Content-Type', 'application/json'],
    ['MCP-Protocol-Version', protocol],
    ['Mcp-Method', method],
  ];
  const nameKey = NAME_BEARING_METHODS[method];
  if (nameKey && typeof params[nameKey] === 'string') headers.push(['Mcp-Name', encodeHeaderValue(params[nameKey])]);
  if (method === 'tools/call') headers.push(...paramHeadersFor(params.name, params.arguments ?? {}));
  for (const h of state.customHeaders) {
    if (h.enabled && h.name.trim()) headers.push([h.name.trim(), h.value]);
  }

  const body = JSON.stringify(envelope);
  const label = nameKey ? params[nameKey] : '';
  const card = addExchangeCard({ method, label, mode });

  if (!url) {
    const result = { request: { method: 'POST', url: '', requestLine: '', headers, body }, error: { code: 'NO_URL', message: 'Set the MCP endpoint first.' } };
    renderExchange(card, result, { method, id, mode });
    return null;
  }

  let result;
  try {
    result = mode === 'browser' ? await sendViaBrowser({ url, headers, body }) : await sendViaRelay({ url, headers, body });
  } catch (e) {
    result = { request: { method: 'POST', url, requestLine: '', headers, body }, error: { code: 'RELAY_UNREACHABLE', message: e.message } };
  }
  const rpc = renderExchange(card, result, { method, id, mode });
  return rpc?.message ?? null;
}

// ---------- exchange log ----------
function addExchangeCard({ method, label, mode }) {
  const list = $('#exchanges');
  $('.empty', list)?.remove();
  for (const other of list.querySelectorAll('.exchange')) setCollapsed(other, true);

  const card = $('#exchange-template').content.firstElementChild.cloneNode(true);
  state.seq += 1;
  card.classList.add('pending');
  $('.seq', card).textContent = `#${state.seq}`;
  $('.method', card).textContent = method;
  $('.name', card).textContent = label ?? '';
  $('.status', card).textContent = 'pending';
  $('.status', card).className = 'status pending';
  $('.meta', card).textContent = `${mode} · ${new Date().toLocaleTimeString()}`;
  $('.toggle', card).addEventListener('click', () => setCollapsed(card, !card.classList.contains('collapsed')));
  for (const d of card.querySelectorAll('.body-section')) d.open = $('#expand-bodies').checked;
  list.prepend(card);
  $('#log-count').textContent = String(state.seq);
  return card;
}

function setCollapsed(card, collapsed) {
  card.classList.toggle('collapsed', collapsed);
  $('.toggle', card).setAttribute('aria-expanded', String(!collapsed));
}

function headerClass(name) {
  if (/^mcp-/i.test(name)) return 'mcp';
  if (AUTH_HEADER.test(name)) return 'auth';
  return '';
}

function renderHeaders(container, headers) {
  container.replaceChildren();
  if (!headers || headers.length === 0) {
    container.append(el('div', { class: 'no-headers', text: 'No headers' }));
    return;
  }
  for (const [name, value] of headers) {
    const kind = headerClass(name);
    const jwts = String(value).match(JWT_IN_VALUE) ?? [];
    const row = el('div', { class: `header-row ${kind}` },
      el('div', { class: 'header-name' }, name, kind ? el('span', { class: 'tag', text: kind }) : null),
      el('div', { class: 'header-value', text: value }),
    );
    const tools = el('div', { class: 'header-tools' });
    if (jwts.length) {
      const panel = el('div', { class: 'jwt', hidden: true });
      for (const token of jwts) {
        const decoded = decodeJwt(token);
        if (!decoded) continue;
        const times = ['iat', 'nbf', 'exp']
          .filter((k) => typeof decoded.payload[k] === 'number')
          .map((k) => `${k}: ${describeTime(decoded.payload[k])}`)
          .join('\n');
        panel.append(
          el('h4', { text: `JWT header${decoded.header.typ ? ` · typ ${decoded.header.typ}` : ''}` }),
          el('pre', { text: JSON.stringify(decoded.header, null, 2) }),
          el('h4', { text: 'JWT payload (not verified)' }),
          el('pre', { text: JSON.stringify(decoded.payload, null, 2) }),
          times ? el('pre', { text: times }) : null,
        );
      }
      if (panel.childElementCount) {
        tools.append(el('button', {
          class: 'ghost small', type: 'button', title: 'Decode the JWT in this header',
          onclick: () => { panel.hidden = !panel.hidden; },
        }, 'JWT'));
        row.append(tools, panel);
      } else row.append(tools);
    } else row.append(tools);
    container.append(row);
  }
}

function statusClass(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'warn';
  return 'err';
}

function buildCurl(request) {
  const skip = new Set(['host', 'content-length', 'connection']);
  const parts = ['curl -i -sS', '-X', request.method ?? 'POST', shellQuote(request.url)];
  for (const [n, v] of request.headers ?? []) {
    if (!skip.has(n.toLowerCase())) parts.push('-H', shellQuote(`${n}: ${v}`));
  }
  if (request.body) parts.push('--data-raw', shellQuote(request.body));
  return parts.join(' ');
}

function renderExchange(card, result, { method, id, mode }) {
  card.classList.remove('pending');
  const { request, response, error, timing } = result;
  const statusEl = $('.status', card);
  const alert = $('.alert', card);
  alert.hidden = true;
  alert.replaceChildren();

  if (response) {
    statusEl.textContent = `${response.status}${response.statusText ? ' ' + response.statusText : ''}`;
    statusEl.className = `status ${statusClass(response.status)}`;
  } else {
    statusEl.textContent = error?.code ?? 'error';
    statusEl.className = 'status err';
  }
  if (timing) $('.meta', card).textContent = `${mode} · ${new Date(timing.startedAt).toLocaleTimeString()} · ${timing.totalMs} ms`;

  // Request side
  const reqSec = $('.headers-section.request', card);
  $('.request-line', reqSec).textContent = request?.requestLine || `POST ${request?.url ?? ''}`;
  renderHeaders($('.headers-table', reqSec), request?.headers);
  $('h3 .count', reqSec).textContent = String(request?.headers?.length ?? 0);
  $('.section-note', reqSec).textContent =
    request?.headersSource === 'wire' ? 'Exact header block written to the socket by the relay.'
      : request?.headersSource === 'browser' ? `Headers set by the page. The browser also sends headers JS cannot see (${BROWSER_ADDED_HEADERS}); use Relay mode or DevTools for those.`
        : '';

  // Response side
  const resSec = $('.headers-section.response', card);
  if (response) {
    $('.status-line', resSec).textContent = `${response.httpVersion ? 'HTTP/' + response.httpVersion + ' ' : ''}${response.status} ${response.statusText ?? ''}`.trim();
    renderHeaders($('.headers-table', resSec), response.headers);
    $('h3 .count', resSec).textContent = String(response.headers.length);
    const notes = [];
    if (mode === 'browser') notes.push(response.type === 'cors' ? 'Cross-origin: only CORS-safelisted headers and those in Access-Control-Expose-Headers are visible. Names are lowercased and duplicates merged.' : 'Names are lowercased and duplicate headers merged by the browser.');
    if (response.trailers?.length) notes.push(`Trailers: ${response.trailers.map(([n, v]) => `${n}: ${v}`).join(', ')}`);
    if (response.decodedFrom) notes.push(`Body decoded from ${response.decodedFrom}.`);
    if (response.truncated) notes.push(response.truncated === 'timeout' ? 'Stream still open at timeout; body shows what arrived.' : 'Body truncated (size limit).');
    if (timing?.ttfbMs != null) notes.push(`TTFB ${timing.ttfbMs} ms, total ${timing.totalMs} ms, ${response.bodyBytes} bytes${response.tls ? ', ' + response.tls : ''}.`);
    $('.section-note', resSec).textContent = notes.join(' ');
  } else {
    $('.status-line', resSec).textContent = 'No response';
    renderHeaders($('.headers-table', resSec), []);
    $('h3 .count', resSec).textContent = '0';
  }

  // Bodies
  $('.request-body pre', card).textContent = pretty(request?.body ?? '');
  let rpc = null;
  if (response) {
    rpc = extractJsonRpc(response, id);
    const ct = headerLookup(response.headers, 'content-type') ?? '';
    $('.response-body pre', card).textContent = rpc?.events
      ? `${response.body}\n\n--- parsed events ---\n${rpc.events.map((e) => (e.json ? JSON.stringify(e.json, null, 2) : e.data)).join('\n\n')}`
      : ct.includes('json') ? pretty(response.body) : response.body;
  } else {
    $('.response-body pre', card).textContent = '';
  }

  // Summary line
  const messages = [];
  if (error) messages.push(['err', `${error.code}: ${error.message}`]);
  if (response && response.status === 401) {
    const wa = headerLookup(response.headers, 'www-authenticate');
    messages.push(['warn', `401 Unauthorized${wa ? ` · WWW-Authenticate: ${wa}` : ' · no WWW-Authenticate header (may be hidden by CORS in browser mode)'}`]);
  } else if (response && response.status >= 300 && response.status < 400) {
    const loc = headerLookup(response.headers, 'location');
    messages.push(['warn', `Redirect not followed${loc ? ` → ${loc}` : ''}`]);
  }
  const msg = rpc?.message;
  if (msg?.error) messages.push(['err', `JSON-RPC error ${msg.error.code}: ${msg.error.message}`]);
  if (method === 'tools/call' && msg?.result) {
    const text = (msg.result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (text) messages.push([msg.result.isError ? 'err' : 'info', text]);
  }
  if (messages.length) {
    alert.hidden = false;
    alert.className = `alert ${messages.some(([k]) => k === 'err') ? 'err' : messages.some(([k]) => k === 'warn') ? 'warn' : 'info'}`;
    alert.append(...messages.map(([, t]) => el('div', { text: t })));
  }

  $('.copy-curl', card).onclick = (e) => copy(buildCurl(request ?? {}), e.currentTarget);
  return rpc;
}

// ---------- custom headers editor ----------
function renderCustomHeaders() {
  const list = $('#custom-headers');
  list.replaceChildren();
  if (state.customHeaders.length === 0) list.append(el('p', { class: 'hint', text: 'None.' }));
  state.customHeaders.forEach((h, i) => {
    const save = () => store.set('customHeaders', state.customHeaders);
    list.append(el('div', { class: 'kv-row' },
      el('input', { type: 'checkbox', title: 'Send this header', checked: h.enabled, onchange: (e) => { h.enabled = e.target.checked; save(); } }),
      el('input', { type: 'text', placeholder: 'Header-Name', value: h.name, spellcheck: 'false', 'aria-label': 'Header name', oninput: (e) => { h.name = e.target.value; save(); } }),
      el('input', { type: 'text', placeholder: 'value', value: h.value, spellcheck: 'false', 'aria-label': 'Header value', oninput: (e) => { h.value = e.target.value; save(); } }),
      el('button', { class: 'ghost small remove', type: 'button', title: 'Remove', onclick: () => { state.customHeaders.splice(i, 1); save(); renderCustomHeaders(); } }, '×'),
    ));
  });
}

// ---------- tools ----------
function resolveType(schema) {
  if (!schema) return 'string';
  if (schema.enum) return 'enum';
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== 'null') ?? 'string';
  if (schema.type) return schema.type;
  const alt = (schema.anyOf ?? schema.oneOf ?? []).find((s) => s.type && s.type !== 'null');
  return alt ? resolveType(alt) : 'string';
}

function renderTools() {
  const box = $('#tools');
  box.replaceChildren();
  for (const tool of state.tools) {
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    const form = el('form', {});
    for (const [key, schema] of Object.entries(props)) {
      const type = resolveType(schema);
      const label = el('span', {}, schema.title ?? key, required.has(key) ? el('span', { class: 'req', text: ' *' }) : null, el('span', { text: ` (${type})` }));
      let input;
      if (type === 'boolean') input = el('input', { type: 'checkbox', name: key });
      else if (type === 'enum') input = el('select', { name: key }, el('option', { value: '', text: '' }), ...schema.enum.map((v) => el('option', { value: String(v), text: String(v) })));
      else if (type === 'object' || type === 'array') input = el('textarea', { name: key, rows: 3, placeholder: type === 'array' ? '[]' : '{}' });
      else input = el('input', { name: key, type: type === 'number' || type === 'integer' ? 'number' : 'text', step: type === 'integer' ? '1' : type === 'number' ? 'any' : undefined, required: required.has(key), spellcheck: 'false', placeholder: schema.description ?? '' });
      input.dataset.type = type;
      form.append(el('label', { class: 'field' }, label, input));
    }
    const btn = el('button', { type: 'submit' }, 'tools/call');
    form.append(btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const args = {};
      try {
        for (const input of form.querySelectorAll('[name]')) {
          const t = input.dataset.type;
          if (t === 'boolean') { if (input.checked) args[input.name] = true; continue; }
          const v = input.value.trim();
          if (v === '') continue;
          if (t === 'number' || t === 'integer') args[input.name] = Number(v);
          else if (t === 'object' || t === 'array') args[input.name] = JSON.parse(v);
          else args[input.name] = input.value;
        }
      } catch (err) {
        alert(`Invalid JSON argument: ${err.message}`);
        return;
      }
      btn.disabled = true;
      try { await mcpCall('tools/call', { name: tool.name, arguments: args }); } finally { btn.disabled = false; }
    });
    box.append(el('div', { class: 'tool' },
      el('div', { class: 'tool-name', text: tool.name }),
      tool.description ? el('p', { class: 'tool-desc', text: tool.description.trim() }) : null,
      form,
    ));
  }
}

// ---------- wiring ----------
function updateModeHint() {
  const hint = $('#mode-hint');
  if ($('#mode').value === 'browser') {
    hint.className = 'hint warn';
    hint.textContent = 'The page calls the endpoint with fetch(). Cookies for that site are sent, but JS cannot see the headers the browser adds, and cross-origin it only sees CORS-exposed response headers.';
  } else {
    hint.className = 'hint';
    hint.textContent = 'The local relay makes the call and reports the exact headers sent on the wire and every header received. Browser cookies are not sent: add them as extra headers if the gateway needs them.';
  }
}

async function withBusy(button, fn) {
  button.disabled = true;
  try { await fn(); } finally { button.disabled = false; }
}

async function init() {
  const theme = store.get('theme', null);
  if (theme) document.documentElement.dataset.theme = theme;
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', document.documentElement.dataset.theme);
  });

  let defaultUrl = 'http://localhost:8000/mcp';
  try {
    const cfg = await (await fetch('/api/config')).json();
    defaultUrl = cfg.defaultUrl ?? defaultUrl;
  } catch {
    // No relay (page opened as a static file): only browser mode can work.
    $('#mode').value = 'browser';
    $('#mode option[value="relay"]').disabled = true;
  }

  const endpoint = $('#endpoint');
  endpoint.value = store.get('endpoint', defaultUrl);
  endpoint.addEventListener('change', () => store.set('endpoint', endpoint.value.trim()));

  const mode = $('#mode');
  if (!mode.querySelector('option[value="relay"]').disabled) mode.value = store.get('mode', 'relay');
  mode.addEventListener('change', () => { store.set('mode', mode.value); updateModeHint(); });
  updateModeHint();

  const proto = $('#protocol-version');
  proto.value = store.get('protocol', DEFAULT_PROTOCOL);
  proto.addEventListener('change', () => store.set('protocol', proto.value.trim()));

  const expand = $('#expand-bodies');
  expand.checked = store.get('expandBodies', false);
  expand.addEventListener('change', () => store.set('expandBodies', expand.checked));

  renderCustomHeaders();
  $('#add-header').addEventListener('click', () => {
    state.customHeaders.push({ enabled: true, name: '', value: '' });
    store.set('customHeaders', state.customHeaders);
    renderCustomHeaders();
    $('#custom-headers .kv-row:last-child input[type="text"]')?.focus();
  });

  $('#btn-discover').addEventListener('click', (e) => withBusy(e.currentTarget, () => mcpCall('server/discover')));
  $('#btn-list-tools').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const msg = await mcpCall('tools/list');
    if (msg?.result?.tools) {
      state.tools = msg.result.tools;
      renderTools();
    }
  }));
  $('#btn-raw').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    let params;
    try { params = JSON.parse($('#raw-params').value || '{}'); } catch (err) { alert(`Params are not valid JSON: ${err.message}`); return; }
    const method = $('#raw-method').value.trim();
    if (!method) return;
    const msg = await mcpCall(method, params);
    if (method === 'tools/list' && msg?.result?.tools) { state.tools = msg.result.tools; renderTools(); }
  }));
  $('#btn-clear').addEventListener('click', () => {
    state.seq = 0;
    $('#log-count').textContent = '0';
    $('#exchanges').replaceChildren(el('div', { class: 'empty' }, 'Log cleared.'));
  });
}

init();
