# The board frontend is local-first (remote token access is not implemented)

This page documents a **known limitation**, on purpose, so nobody reads the roadmap or the
`/token` route and concludes that a browser on another machine can drive the board. It
cannot, yet. What is missing is small and named at the end of this page.

## What works

**Loopback.** `taskd` serves the built frontend (`web/dist`) from the same origin it serves
`/api/v1/**`, and the frontend talks to it with **relative** URLs (`services/api.js` uses a
fixed `/api/v1` prefix; `services/events.js` opens `/api/v1/events`). There is no API-base
switch and no cross-origin hop. A browser on the **same machine** as `taskd` — whether
reached at `http://127.0.0.1:9527` or `http://localhost:9527` — is a loopback caller, which
the server trusts without a token (`src/server/auth.mjs`: `127.0.0.0/8`, `::1`,
`::ffff:127.0.0.1`). Everything the board does works there: initial load, moves, the live
SSE stream, reconnect and `?after=` resync.

## What does **not** work

**A remote browser.** With `taskd` reachable over the network, a request from a non-loopback
address must carry the access token — `Authorization: Bearer <token>` for ordinary requests,
or `?token=<token>` for the SSE stream (the query form exists precisely because
`EventSource` cannot set headers). The frontend **injects no token anywhere**:

- `web/src/services/api.js` sends `content-type` on writes and nothing else — no
  `Authorization` header, no `?token=`;
- `web/src/services/events.js` builds `/api/v1/events` with only a `?after=` cursor.

So on a remote deployment essentially **every** request the board makes — `/meta`,
`/projects`, `/tasks`, `/assignees`, `/events` — is answered **401**, and the panel renders
its error state rather than a board. This is a **missing feature, not a security hole**: the
server is doing exactly what §7 says it should. The board has no way to *present* a token, so
it simply is not a remote client.

The B19 "Access & token" panel in the UI does **not** change this. Its token is authored,
in-memory stand-in markup (`web/src/components/review/AccessPanel.vue`: a `td_`-prefixed
string with a mask, "no storage, no network"); it is a states-gallery exhibit, not a client
credential.

## The workaround today

You do not need remote access to be implemented to use the board from another machine — move
the *socket*, not the token, onto loopback:

```bash
# on the machine running taskd
taskctl project list          # ensures taskd is up (or: node src/server/main.mjs)
# from the client machine
ssh -N -L 9527:127.0.0.1:9527 <host-running-taskd>
# then browse http://127.0.0.1:9527
```

The forwarded connection arrives at `taskd` from `127.0.0.1`, so the loopback exemption
applies and no token is needed. This is the supported way to reach the board from elsewhere
today.

## What implementing remote access would require

Two viable shapes. Neither is implemented; this card only documents the gap.

1. **Token injection (frontend-side).** Give the page a token on load — e.g. `?token=<t>` on
   the initial navigation — have the shell stash it (in memory, or `sessionStorage` if it must
   survive a reload), and teach `services/api.js` to attach `Authorization: Bearer <t>` and
   `services/events.js` to append `?token=<t>`. Required care: never put the token in a URL
   that gets logged, never send it on a cross-origin request, and clear it on 401 so a stale
   token cannot wedge the UI.
2. **Same-origin cookie (server-side).** Have `taskd` set an `HttpOnly`, `SameSite=Strict`
   cookie after a token-bearing handshake, and accept that cookie in `src/server/auth.mjs`.
   The browser then attaches it automatically to both `/api/v1/**` and the SSE request, and no
   frontend code changes. Required care: a CSRF story for the state-changing POSTs, and a
   cookie lifetime / rotation policy.

Until one of those lands, treat the panel as **loopback-only**. Do not describe remote Web
access as working.
