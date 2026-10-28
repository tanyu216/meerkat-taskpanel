# IM Integration

**Status:** Planned. The roadmap lists this above the Epic view and iteration management.
Nothing in this document is implemented yet.

This document is a requirements and design record, not an implementation guide. It fixes the
boundary between the engine and the messaging platforms so the work can be split into
independent adapter packages without changing the engine later.

## 1. Summary

Meerkat TaskPanel has no direct way to reach a human. The supervisor writes card state and
comments; `--notify <cmd>` covers SLA, workflow and no-resident alerts, but it deliberately
does **not** cover the three states that actually need a person:

- `awaiting` (E1–E5 escalation),
- an unanswered agent `question` on an `in_progress` card,
- a pending acceptance (`in_review`).

This document specifies an IM integration that closes that gap, while keeping the engine
zero-dependency and free of platform-specific code:

1. **Push** a “needs a human” item to an IM conversation immediately.
2. **Decide in IM** — a reply is anchored to a card from conversation context and recorded
   as a human comment (`awaiting → todo`), or closes/rejects an acceptance.
3. **Ask for progress in IM** — fixed commands answer deterministically; free text goes to a
   resident IM session.

The engine provides a **plugin host + `channel-kit` contract**; each IM platform is an
**independent adapter package** built on a third-party SDK. The engine never imports an IM
SDK and never implements a platform protocol.

## 2. Goals

- Make every “needs a human” transition visible on IM without a human polling the board.
- Let the human answer, accept or reject from IM with the same authority as a
  `taskctl --as-human` write.
- Answer progress questions in IM without a model when the answer is deterministic.
- Keep the board the single source of truth: IM is a front-end, not a second dispatcher.
- Make adding a platform a matter of adding an adapter package, not changing the engine.
- Preserve the repo’s hard constraints: zero runtime dependencies for the engine, offline
  engine, single writer, loop speaks only `taskctl`.

## 3. Non-goals

- Implementing Slack, Feishu, WeChat, WhatsApp, Teams, Telegram or Signal in this repository.
- Building the first real adapter as part of this design record.
- Group chats, media, reactions, multi-tenant isolation or per-project IM sessions.
- Replacing the board UI or the web front-end.
- A second control turn: the IM session never claims, polls, dispatches or moves cards.

## 4. Requirements

### R1 — Push the three “needs a human” classes

When any of these appears, push an IM message:

| Class | Source | Push content |
|---|---|---|
| `awaiting` | `loop console` `questions[]` with `kind: awaiting` | ref, title, E1–E5 reason, question |
| Agent question | `questions[]` with `kind: agent-question` | ref, title, question |
| Pending acceptance | `pending_acceptance[]` | ref, title, accept/reject hint |

`loop console --json` is the projection. `pending_acceptance[]` is **mode-agnostic**, so the
host MUST enrich `in_review` refs with `issue list --status in_review --json` and filter by
`acceptance_mode`: only a `human` card awaits a person, while an `agent` card is reviewed and
closed by the loop. If enrichment fails, acceptance pushes fail closed.

### R2 — Decide in IM

A reply is anchored to a card by, in order:

1. an explicit command (`/accept`, `/reject`, `/status`, …),
2. an explicit ref (`#ABC-123`),
3. the platform reply/quote anchor (`replyTo`),
4. the conversation’s active set (exactly one unresolved item),
5. a numbered clarification (`1`, `2`, …) when several are active.

Writes:

| Intent | Command |
|---|---|
| Answer `awaiting` | `taskctl --as-human comment add <ref> --kind decision --body "<text>"` |
| Answer an agent question | `taskctl --as-human comment add <ref> --kind note --body "<text>"` |
| Accept | `taskctl --as-human issue move <ref> done` |
| Reject / rework | `comment add --kind change` then `issue move <ref> in_progress` |

Before writing, re-read the card with `issue get <ref>` and refuse if the status moved.
Relay `ACCEPTANCE_UNVERIFIED`, `ACCEPTANCE_INCOMPLETE`, `REVIEW_PENDING` and
`ACCEPTANCE_FORBIDDEN` to the user; do not retry blindly.

**Identity:** the human name is **shared with `taskctl`** via `TASKCTL_HUMAN` (written by the
installer). The channel does not configure, override or persist it. The internal actor id is
resolved and maintained by the board’s actor dictionary; the channel never sees it. The IM
allowlist only decides which platform users may trigger the write.

### R3 — Ask for progress in IM

Deterministic commands answer without a model:

| Command | Source |
|---|---|
| `/status <ref>` | `issue get` + `report list` + `comment list --limit 1` |
| `/list [status]` | `issue list --limit 10` |
| `/pending` | `loop console --json` |
| `/help` | local |

Free text with no deterministic answer goes to a **resident IM session** (R6). The session is
**board-wide / cross-project**: `loop console` is board-wide and refs are globally unique
(project prefix). It does not bind to a project directory and does not edit files.

### R4 — Plugin host + `channel-kit`

The engine provides:

- a long-lived **host** that owns needs-human projection, dedupe, context resolution,
  commands, progress, the resident session and the supervisor heartbeat;
- a **`channel-kit`** (zero-dependency) with the stdio protocol, normalization helpers,
  capabilities and a fake-host test harness;
- a **protocol** that any language can implement.

The host spawns one **adapter process per platform**; adapters are independent packages with
their own dependencies and lockfiles.

### R5 — One adapter per platform, not one process for all SDKs

Slack, Feishu, discord.js, Baileys, the Teams SDK and an iLink client have different
dependencies, Node requirements, transport shapes (Socket Mode / WebSocket / webhook /
browser / long-poll), licences and failure domains. They are **separate processes**, sharing
`channel-kit`, not one process that imports every SDK.

A meta installer/CLI may provide a one-command UX, but it still installs and starts multiple
adapter processes.

### R6 — Resident IM session

- One agent child per IM conversation, owned by the host; it is **not** a resident-pool role
  and is not written into `sessions.state.json`.
- Session id is persisted and resumed; a fatal error recreates it.
- One turn in flight; FIFO; timeout; “the previous message is still running” when busy.
- Tools: read-only + `taskctl`. Claude uses a role allowlist; Codex uses a read-only
  sandbox; **Pi has no verified read-only switch and is off by default**
  (`SESSION_ALLOW_PI=yes` to opt in).
- The prompt states the boundary: user-facing front-end, not the control turn; no claim,
  poll, dispatch, card move; decisions only through `--as-human`; do not invent board facts.
- If the session is unavailable, deterministic commands still work; free text degrades to a
  “try /status <ref>” reply.

### R7 — Supervisor observability and lifecycle

- The host writes a heartbeat and its plugin/session state; `loop status` / `loop console`
  report `im: live | stale | absent`, per-plugin `ready/restarts/lastError`, and session
  state.
- `ping` logs `channel_stale` when the heartbeat is old; the OS unit’s `KeepAlive` restarts
  the host. The supervisor does **not** participate in IM decisions.
- The channel host is **not** added to the supervisor’s `KINDS`; `--supervisor=enable` does
  not load it. Installation is an explicit `--channel=enable|disable|status`.

### R8 — Security

- **Allowlist**: platform user ids only; the human name is the shared `TASKCTL_HUMAN`.
- **Plugin isolation**: the adapter never receives board tokens or `TASKCTL_*`/`TASKD_*`/
  `MEERKAT_TASKPANEL_*`; it exchanges only normalized messages and its own config.
- **Injection**: inbound text is data; `taskctl` is spawned with argv, never a shell; the
  session is read-only; model output is never parsed into commands.
- **Single instance**: `O_EXCL` lock; stale reclaim by pid.
- **Isolation**: one adapter crash/quarantine does not stop the others or the deterministic
  commands.

### R9 — Degradation

Without a session or an adapter, the host still answers deterministic commands and records
decisions. A missing `context_token`-style capability is an adapter concern, declared through
`capabilities.proactive`; it is not a core rule.

## 5. Architecture

```text
board (taskd / SQLite)
   ▲  only taskctl
   │
channel host (engine-owned)
   ├─ needs-human projection + dedupe + acceptance filter
   ├─ context resolver + commands + progress
   ├─ resident IM session (agent child; read-only + taskctl)
   ├─ supervisor heartbeat
   └─ plugin manager (one child per adapter)
          │ stdio NDJSON
          ▼
   adapter process (external package)
     · platform SDK / client
     · auth + transport + normalization + formatting
     · capabilities
```

The host owns board semantics; the adapter owns the platform. They exchange normalized
messages only.

## 6. Protocol (`stdio` NDJSON)

One JSON object per line; stdout is protocol only, stderr is logs. Strict LF framing.

```text
host  → adapter  {"type":"hello","protocol":1,"config":{...},"stateDir":"..."}
adapter → host   {"type":"ready","name":"...","version":"...","capabilities":{...}}

host  → adapter  {"type":"outbound","id":"out-1","conversationKey":"...","replyTo":"...",
                  "text":"...","actions":[{"id":"accept","label":"Accept"}],"meta":{}}
adapter → host   {"type":"ack","id":"out-1","ok":true,"messageId":"..."}

adapter → host   {"type":"inbound","id":"in-1","conversationKey":"...","threadKey":"...",
                  "messageId":"...","text":"...","replyTo":"...",
                  "from":{"id":"...","display":"..."},"raw":{}}
host  → adapter  {"type":"ack","id":"in-1","ok":true}

host  → adapter  {"type":"shutdown"}
```

`capabilities`:

```json
{
  "edit": false, "cards": false, "buttons": true, "threads": true,
  "groups": false, "media": false,
  "proactive": "always | after-inbound | window-24h",
  "maxChars": 1800
}
```

A reserved `transport: "http"` mode uses the same schema over loopback HTTP + SSE for
webhook/remote/multi-tenant adapters. It is not implemented in this design record.

## 7. Board semantics

### Needs-human projection

`taskctl loop console --json` (raw object, not `{ok,data}`) is the only projection covering
all three classes. Other reads (`issue get/list`, `report list`, `comment list`) use the
normal `{ok,data}` envelope; two parsers are required.

Trigger: `events follow` (with `--actor-kind`/`--agent`) + debounce + a 60s safety poll.
`comment_added` carries no body; re-read `console` for question text.

Dedupe keys:

```text
awaiting:<ref>:<awaiting_reason ?? "-">:<asked_at ?? sha1(question)>
agent-question:<ref>:<asked_at ?? sha1(question)>:<sha1(question)>
acceptance:<ref>:<delivery_round>
```

Invalidate on `task_resumed`, `task_delivered` and `report_written`. A failed console read
must not mark anything resolved.

### Context anchoring

The host stores, per `conversationKey`, the active set, a `pendingChoice` and an outbound
index (`messageId → ref/kind`). The adapter supplies `replyTo` from the platform’s quote or
thread anchor; the host applies the precedence in R2. Re-read the card before writing.

### Commands and messages

Text commands are the universal fallback. Adapters that declare `buttons`/`cards` may render
the same semantic actions; the host does not depend on the rendering.

## 8. Resident session scope

The session is **board-wide / cross-project**. It uses a neutral working directory
(`<state-dir>/channel/workspace`), never a project directory. It answers from `taskctl`; if
it needs a project's directory it asks `taskctl project dir` (or `project map show`). It
never reads, writes or edits `projects.json` itself.
Per-project sessions and `/project` switching are out of scope.

## 9. Platform strategy

Each platform is an independent adapter package. The SDK selection is **advisory**, dated and
reviewed again when the adapter work starts.

| Platform | Recommended SDK | Why / caveat |
|---|---|---|
| Slack | `@slack/bolt` (official; includes `@slack/web-api`) | Socket Mode, mature, MIT |
| Feishu | `@larksuiteoapi/node-sdk` (`larksuite/node-sdk`) | Official, active; the older `oapi-sdk-nodejs` is archived |
| Discord | `discord.js` | Community standard, active |
| Telegram | `grammy` | Active npm; Telegraf has more stars but an older npm release |
| Teams | `microsoft/teams-sdk` | `botbuilder-js` is archived; needs Azure + public HTTPS |
| WhatsApp | `baileys` (or Cloud API) | Baileys is headless but an RC and unofficial; Cloud API is the compliant route |
| WeChat | no dominant standalone SDK | Choose direct iLink, OpenClaw + Tencent plugin, or CLI-WeChat-Bridge (AGPL) — an explicit adapter decision |

The full dated matrix (stars, last push, licence, npm version) lives in the adapter track, not
in this document’s contract.

## 10. Roadmap and priority

IM integration is the **next planned item**, ahead of the Epic view, iteration management and
OpenClaw loop/setup support. The reason: the supervisor currently has no human-facing
channel, and every `awaiting` card depends on a human polling the board.

The first real adapter is a separate decision. Feishu or Slack is the recommended way to
validate `channel-kit`; WeChat iLink is the least clean SDK ecosystem and should follow.

## 11. Acceptance criteria (for the future implementation)

- A fake adapter can receive pushes for all three classes and inject replies that become
  human comments; `awaiting → todo` is observed.
- `acceptance_mode=agent` cards are not pushed as human-needed.
- An IM reply anchors by quote, explicit ref, single active item and numbered clarification.
- `TASKCTL_HUMAN` is the only identity; the channel neither overrides nor persists it.
- Deterministic commands work with the session and adapter stopped.
- The host reports `im: live|stale|absent` and per-plugin state; the supervisor does not
  load the channel unit via `--supervisor=enable`.
- Adapters are separate processes; one crash does not stop the others.

## 12. Risks and open questions

- **Adapter quality and supply chain**: adapters are local trusted processes; they must not
  receive board tokens.
- **iLink**: no clean SDK; licence/ToS is an adapter decision.
- **WhatsApp**: Baileys/whatsapp-web.js are unofficial; Cloud API needs a business number
  and a public webhook.
- **Teams**: Azure Bot registration and a public HTTPS endpoint.
- **Session cost**: a resident agent consumes model tokens; deterministic commands are free.
- **Cross-project context**: one conversation may span projects; inject only needs-human and
  the anchored card, query the rest on demand.
- **Open**: whether the dated SDK matrix belongs in this document or the adapter package, and
  which platform validates `channel-kit` first.

## 13. References

- [`scheduling.md`](scheduling.md) — the loop, the resident pool and the control turn.
- [`events.md`](events.md) — the activity catalogue and the “signal, not payload” rule.
- [`install.md`](install.md) — the install targets and the installed tree.
- [`contract.md`](contract.md) — the CLI/HTTP contracts the integration must reuse.
- [`README.md`](README.md) — documentation index.
