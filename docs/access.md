# Access and security design

The board is **local-first**: the machine that owns the SQLite file is the trust root, and
every other caller has to be let in. This page is the design record for that gate — who may
call `taskd`, how a caller proves it, how remote reach is granted and changed, and what every
surface is refused for.

The decision lives in [`src/server/auth.mjs`](../src/server/auth.mjs); the policy it reads is
built by [`src/server/access-config.mjs`](../src/server/access-config.mjs) and
[`src/server/cidr.mjs`](../src/server/cidr.mjs); the credential is
[`src/core/storage/secrets/token-store.mjs`](../src/core/storage/secrets/token-store.mjs).
What a client may *do* once inside — claiming, delivering, reviewing — is the `meerkat`
skill's rules; this page is only about reaching the service at all.

## 1. The trust model: loopback is the owner's console

`taskd` listens on `0.0.0.0:9527` by default (`DEFAULT_HOST` / `DEFAULT_PORT`, overridable with
`TASKD_HOST` / `TASKD_PORT`), so the network can reach it without any extra step. The controls
below are what make that default defensible — they are not an optional hardening pass.

- A **loopback** connection — `127.0.0.0/8`, `::1`, or the IPv4-mapped `::ffff:127.0.0.1` — is
  trusted: no token, and the allow-list is never applied. The CLI and the loop start their own
  board on loopback and depend on this.
- The allow-list deliberately does **not** gate loopback. An over-tight list must never lock
  the owner out of the board on the machine that owns it.
- Loopback is not an identity. It answers "is this the machine", not "who is this". Every local
  caller is the owner; the actor headers on a write are attribution, not authentication (§7).
- Local-first is a data statement too: one writer owns one SQLite file, work and credentials
  stay on one machine, and remote reach is an explicit extension of that boundary — never the
  default.

## 2. The request gate

Every request except `/health` passes one check before it reaches anything: the JSON router, the
SSE stream, attachment bytes, **and the built frontend**. The check is `authorize()`; there is
no second place where a path can become reachable.

| Order | Question | Result |
|---|---|---|
| 1 | Is the connection from loopback? | let through, with no further checks |
| 2 | Is the client address inside the enabled allow-list? | `403`, `details.reason: "ip_not_allowed"` |
| 3 | Is this an owner-only verb (`POST /token`, `GET` / `PUT /access`)? | `403`, `details.reason: "loopback_only"` |
| 4 | Did the caller present a token? | `401`, `details.reason: "missing_token"` |
| 5 | Does it match the board's token? | `401`, `details.reason: "bad_token"` |

The order is load-bearing. The allow-list is a network filter and answers before the token is
looked at, so an address outside the list cannot probe whether a token is valid.

Two consequences worth stating separately:

- **The built frontend is behind the gate too.** A remote browser is answered `401` for the
  HTML document itself, so it never reaches the app shell — not even its error state. The
  server is doing exactly what this design says; the missing piece is on the client side (§6).
- **`/health` is the one unauthenticated route, on purpose.** It is the liveness probe the CLI
  polls to discover a board, before a token exists, and it exposes only "I am here".

Every refusal keeps the ordinary error envelope —
`{ok:false,error:{code,message,http,details,hint}}` — and names itself in `details.reason`, so
a client branches on the reason and never on the server's prose.

## 3. The access token

**Shape and storage.** A token is `td_` followed by 64 hex characters — 32 random bytes
(`TOKEN_PREFIX`, `TOKEN_BYTES`). The board mints it on first start (`ensureToken` in
`src/core/bootstrap.mjs`); it lives at `<dataDir>/token`, never in the database. The data
directory is created `0700`, and the token file is `0600` whatever the umask says — re-hardened
on every start. The write is atomic (temp file → fsync → rename → chmod), so a reader never
sees half a token and a crash never leaves a truncated one. An existing file is never silently
overwritten: if it does not look like a token, that is `TOKEN_FILE_CORRUPT`, and a human
decides.

**Verification.** The presented value is compared in constant time (`timingSafeEqual`; a length
mismatch short-circuits to false). An empty token never matches, so a board without a token
file does not accept an empty credential.

**Presentation.** Ordinary requests carry `Authorization: Bearer <token>`. The gate also accepts
`?token=<token>`, because `EventSource` cannot set headers — that is the form a remote browser
board would need on its SSE stream (§6). The CLI and every client that goes through the
transport seam always send the header; the query form is the browser fallback, not the default,
since a URL is the part of a request that ends up in proxy and access logs.

**Which token a client presents.** Resolution is fixed, highest first:

| Order | Source | Notes |
|---|---|---|
| 1 | `--token <token>` | a pin |
| 2 | `TASKD_TOKEN` | |
| 3 | `TASKD_TOKEN_FILE` | strict: an unreadable or malformed file is a configuration error, and a POSIX mode wider than `0600` is `CONFIG_FILE_INSECURE` |
| 4 | the runtime pointer's `tokenFile` | the board's own credential, as written when it started |
| 5 | none | correct on loopback, where no token is required |

The *source* is reported (`token_source`); the value never is. The precedence lives in
`src/foundation/transport/token.mjs` and is shared by every entry point.

**Rotation.** `POST /api/v1/token` (loopback only) mints a fresh token and swaps the in-process
copy at once, so a remote holder of the old token is locked out on its next request. The
response names the file, never the token: the caller is by definition on the machine that owns
the file and reads it there, so a secret never crosses the socket. `taskctl token rotate` does
this and prints `td_****` plus the path; `--show` prints the value and says that it did.

**What the token is not.** It is a bearer credential, not an identity: whoever holds it is the
board. There is no per-client token, so the only revocation is rotation — which invalidates
the credential for everyone (§8).

## 4. The allow-list: who may even try

The allow-list is an optional network filter for **non-loopback** callers. Two keys own it,
both in the install-root `.env` and both honoured from the process environment:

| Key | Meaning |
|---|---|
| `TASKD_ALLOW_LIST_ENABLED` | `true` / `false` — whether the list is in force |
| `TASKD_ALLOW_CIDRS` | comma-, space- or semicolon-separated IPv4 / IPv6 ranges |

**Precedence**, as resolved by `readAccessConfig`:

1. the **process environment** — an operator override; the Access panel turns read-only,
   because a save would be silently undone by the next process start;
2. the **install-root `.env`** — what the Access panel writes;
3. the **defaults** — list **off**, seeded with `192.168.0.0/16` and `10.0.0.0/8`.

Off is the safe default: an upgrade must not silently start refusing callers the board used to
serve. Turning the list on while it is empty is a real, supported setting — it denies **every**
remote caller — and is not replaced by the defaults. A hand-written `.env` that names ranges
without the switch keeps the historic meaning: a list present means the list is in force.

**Parsing fails closed.** A malformed entry is dropped, never treated as a wildcard; a typo in a
security control must not widen access. Two spellings of one address are normalised together: a
dual-stack socket reports an IPv4 client as `::ffff:10.0.0.7`, so it is compared as `10.0.0.7`
and a `10.0.0.0/8` list matches it. IPv4 and IPv6 are compared as byte arrays, so one prefix
loop covers both families. A hand-written invalid range in the process environment is logged
(`allow_list_invalid`) and cannot match anything.

**Bounds.** At most 64 entries, each validated by the server's own parser (`parseCidr`), so the
Access panel cannot persist a range the request path would read differently. A save refuses an
invalid entry rather than dropping it, because dropping one entry is the mistake that narrows a
list without saying so.

## 5. Managing access

Three owner verbs, all refused from anywhere but loopback before the token is checked:

| Verb | Effect |
|---|---|
| `POST /api/v1/token` | rotate the token |
| `GET /api/v1/access` | the persisted credential and the policy in force |
| `PUT /api/v1/access` | validate and save the policy; optionally rotate in the same save |

A remote caller may *use* a token; it may never mint one or widen the list. That is why these
answer `403 loopback_only` rather than a token error: "do this on the machine" and "your token
is wrong" are different instructions.

`GET /access` returns the token **in clear, on purpose**. The Access panel must show the
persisted credential so a refresh does not appear to change it, and the read is the same trust
domain as the token file — it never crosses a socket off the machine.

`PUT /access` writes the install-root `.env`, not the database, because the policy is server
configuration that must be known before the first remote caller is judged. The write merges into
the existing file (unknown keys and operator comments survive), is atomic, and is `0600`. The new
policy applies to the very next request, with no restart; `rotate_token: true` rotates the
credential in the same save, so the panel's one Save covers every pending edit — including a
Reset the reader has not confirmed yet.

When the process environment owns the policy the response says `source: "env"`, the panel is
read-only, and a `PUT` is refused (`details.reason: "env_managed"`).

The UI for this is the **Access & token** panel
(`web/src/components/review/AccessPanel.vue`, B19): draft allow-list rows, the installed
credential with Copy and Reset, and one Save. Like the verbs it calls, it is usable only on
loopback — and it is never the credential that `/tasks`, `/projects` or `/events` present.

## 6. Remote clients

**What works today.** Any non-browser client — `taskctl`, the loop, a script, another agent —
reaches a remote board with a token from an allowed address:

```bash
taskctl issue list --url http://board-host:9527 --token td_…
# or: TASKD_TOKEN=td_… taskctl issue list --url http://board-host:9527
```

Every route works, including the SSE stream (the transport sends the header there too).

**What does not: the built web board.** The frontend is same-origin and relative by design —
`services/api.js` fixes `/api/v1` and sends no `Authorization` header; `services/events.js`
opens `/api/v1/events` with only an `?after=` cursor. From a remote browser every request,
including the document, is answered `401` before the app can start (§2). This is a missing
client capability, not a hole: the server behaves exactly as described above. The Access panel
does not change it — it is itself loopback-only.

**The supported workaround: move the socket, not the token.** Forward the port over SSH, so the
connection arrives at `taskd` from `127.0.0.1` and the loopback exemption applies:

```bash
# on the client machine
ssh -N -L 9527:127.0.0.1:9527 <host-running-taskd>
# then browse http://127.0.0.1:9527
```

**What implementing remote browser access would take.** Two shapes; neither is implemented.

1. **Token injection (frontend).** Hand the page a token on load — e.g. `?token=<t>` on the
   initial navigation — keep it in memory (`sessionStorage` only if it must survive a reload),
   and teach `services/api.js` to send `Authorization: Bearer` and `services/events.js` to
   append `?token=`. Required care: never let the token into a URL that gets logged, never send
   it cross-origin, and clear it on `401` so a stale token cannot wedge the UI.
2. **Same-origin cookie (server).** Have `taskd` set an `HttpOnly`, `SameSite=Strict` cookie
   after a token-bearing handshake and accept that cookie in `auth.mjs`. The browser then
   attaches it to both the API and the SSE request, and no frontend code changes. Required
   care: a CSRF story for state-changing verbs (there is none today, because there are no
   cookies), and a cookie lifetime / rotation policy.

Until one lands, treat the panel as **loopback-only**. Do not describe remote Web access as
working.

## 7. The API surface's other guards

Access control is one layer; the service also refuses malformed and leaking traffic.

- **Declared request schemas.** Every route declares the query and body shape it accepts
  (`src/server/requests.mjs`); a mismatch is `VALIDATION_FAILED` before the handler runs.
  `scripts/verify/route-request.mjs` gates that the declared schema is exactly what the handler
  reads, and the contract snapshot freezes the routes, wire fields and error codes.
- **Body ceilings.** A JSON body over 1 MiB (`MAX_BODY_BYTES`) is a readable `413`, never a
  connection reset; attachment bytes carry their own ceiling and their own error code, so a
  client can tell "too big" from "bad request".
- **One error vocabulary.** Every failure is the `{ok:false,error:{code,message,http,details,hint}}`
  envelope. The UI renders `code`, never the server's `message`; a 4xx is the caller's error and
  is not logged as a fault, a 5xx is.
- **Secrets never leave.** The token is never echoed in a response and never logged;
  `redactText` / `redactDeep` strip `td_…` and `Bearer …` from messages, errors and log records;
  the request log carries the pathname only, not the query string — which is the other reason
  `?token=` is the fallback form.
- **Headers are attributed, not trusted.** `x-taskctl-actor`, `x-taskctl-session` and
  `x-taskctl-seg` say who a write is *for*. They are claims recorded in the audit trail, not
  authentication: any caller holding the token may name any actor.
- **`x-request-id` is bounded.** A client-supplied id is believed only in a short,
  separator-free shape, so a header cannot forge a second log line.
- **Attachment bytes stay bytes.** The content route accepts only a safe single-segment id;
  downloads are served `content-disposition: attachment` with `nosniff` and `no-store`, so
  nothing the origin stores is rendered as a document and a removed attachment does not survive
  in a cache.
- **No cookies, no CORS.** The service sets no CORS headers and uses no cookies, so a browser
  can drive it only same-origin. The cookie-based remote design (§6) would introduce the CSRF
  surface this paragraph currently does not have.

## 8. What this design does not cover

Named rather than hidden:

- **The transport is plain HTTP.** A token over an untrusted network is in clear. Use the SSH
  forward (§6) or a TLS-terminating proxy — and note that behind a proxy the allow-list sees the
  proxy's socket address: no `X-Forwarded-For` is consulted, by design, because believing a
  forwarding header would let any client claim any address.
- **No per-user identity or authorization.** One board, one owner, one credential. The actor
  headers name intent; they grant nothing.
- **No rate limiting and no lockout.** Guessing the token is bounded by 256 bits of entropy, not
  by attempt counting.
- **No per-client credentials.** Rotation replaces the one token for everyone; there is no way
  to revoke a single client.
- **The allow-list is an application filter, not a firewall.** It is evaluated after the socket
  is accepted.
- **An SSH forward is loopback.** Every connection through the tunnel is trusted as the owner
  and bypasses both the list and the token; the tunnel itself is the control.
