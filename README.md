# idjag_mcp_caller_ui

UI for ID-JAG validation with an MCP backend: call the
[mcp-openweathermap](../mcp-openweathermap) server (directly or through Traefik Hub) and see
**every request header and every response header** of each call, in separate sections.

ID-JAG itself is handled by Traefik Hub; this UI only makes the MCP calls and shows what goes over the wire.

## Run

No dependencies, Node 20 or newer.

```bash
npm start
```

Open http://127.0.0.1:5173. Settings:

| Variable       | Default                     | Purpose                                         |
| -------------- | --------------------------- | ----------------------------------------------- |
| `MCP_URL`      | `http://localhost:8000/mcp` | Endpoint pre-filled in the UI                   |
| `PORT`         | `5173`                      | UI port                                         |
| `HOST`         | `127.0.0.1`                 | Bind address (the relay is an open forwarder: keep it local) |
| `INSECURE_TLS` | unset                       | `1` skips TLS certificate checks (self-signed gateways) |

## Make targets

`make` lists them. Variables can be overridden on the command line.

```bash
make run                                   # local Node on http://127.0.0.1:5173
make run MCP_URL=https://hub.example.com/mcp
make image                                 # build linux/amd64, then linux/arm64
make image-arm64                           # or just one: image-amd64 / image-arm64
make image-run                             # build and run your machine's image hardened on :5173
make push IMAGE=ghcr.io/acme/idjag-mcp-caller-ui TAG=v0.1.0   # one multi-arch tag, pushed
make clean
```

`image` builds two local images, `idjag-mcp-caller-ui:<git describe>-amd64` and `...-arm64`.
`image-run` builds and starts the one matching your Docker engine (arm64 on Apple Silicon) and
points the UI at `http://host.docker.internal:8000/mcp` so it can reach an MCP server running on
your machine (override with `DOCKER_MCP_URL`). `push` builds `PLATFORMS`
(`linux/amd64,linux/arm64`) into a single multi-arch tag, which is what a cluster should pull.

## Container / Kubernetes

The image ships only the `node` binary on Alpine (no npm, about 52 MB compressed), listens on
`8080`, runs as UID `65532` and writes nothing to disk. Set `MCP_URL` in the Deployment env.
Pod spec essentials:

```yaml
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
readinessProbe: { httpGet: { path: /healthz, port: 8080 } }
livenessProbe:  { httpGet: { path: /healthz, port: 8080 } }
```

`/api/relay` forwards to any URL it is given, from inside the cluster. Only expose the Service
behind an authenticated route (e.g. a Traefik Hub OIDC middleware), never on a public Ingress as is.

## What it does

- Speaks MCP `2026-07-28` over stateless streamable HTTP, like the official SDK client:
  `_meta` envelope (protocol version, client info, capabilities) and the
  `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (and `Mcp-Param-*`) routing headers.
- Buttons for `server/discover` and `tools/list`, a form per tool from its `inputSchema`
  for `tools/call`, and a raw JSON-RPC sender for anything else.
- **Extra request headers** (e.g. `Authorization: Bearer …`) sent on every call, saved in the browser.
- Each call is logged as a card with **Request headers** and **Response headers** side by side,
  the request line and status line, timing, and request/response bodies (JSON or parsed SSE).
- Auth-related headers (`Authorization`, `WWW-Authenticate`, `Set-Cookie`, `X-Forwarded-*`, …)
  and `Mcp-*` headers are highlighted. A JWT inside a header value can be decoded in place
  (header, claims, `iat`/`exp` in readable time; the signature is not verified).
- 401 responses surface `WWW-Authenticate`; redirects are not followed so you see the `Location`.
- **curl** button copies the exact call to replay it in a terminal.

## Transport modes

**Relay (default).** The UI posts to `/api/relay` on the local Node server, which makes the HTTP call.
The request headers shown are parsed from the exact header block Node wrote to the socket,
and response headers come from the raw header list (original order, casing and duplicates).
Browser cookies are not sent: add them as extra headers if the gateway needs a session.

**Browser fetch.** The page calls the endpoint with `fetch()`, with credentials. Useful when the UI is
served behind the same Traefik router and you want the browser's own cookies. Limits: JS cannot see
headers the browser adds (`Host`, `Cookie`, `Origin`, `User-Agent`, `Sec-Fetch-*`, …), and cross-origin
it only sees CORS-safelisted response headers plus those in `Access-Control-Expose-Headers`.

## Files

- `server.js`: static file server + `/api/relay`
- `public/index.html`, `public/styles.css`, `public/app.js`: the UI (no build step)
