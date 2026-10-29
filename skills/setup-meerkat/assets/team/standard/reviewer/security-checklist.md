# Security checklist — the reviewer's manual audit

Read this beside `workflow.md`. Every row gets one disposition and an anchor:
`met` (and how you checked), `not_met`, or `n/a — <reason>`. A blank row is an omission.
Tier 1 is answered on every code-changing card; Tiers 2 and 3 are answered for the surface
the card changes. A documentation-only card records one `n/a — <reason>` per tier.
An automated scanner never answers a row for you: its finding is evidence you classify.

## Tier 1 — core (always)

| # | Topic | What proves it |
|---|---|---|
| C1 | Authorization and ownership | every read and write checks the caller's role and the object's owner; no id from the request is trusted; a list cannot leak another tenant's row |
| C2 | Input validation and output encoding | one validation at the boundary; parameterised queries; no raw-HTML sink on unescaped input; no user value in a template expression |
| C3 | Secrets and configuration | no secret in the change, a fixture, a log or an error; the value comes from configuration; environment files are untracked |
| C4 | Injection and dangerous sinks | SQL, shell, `eval`, `Function`, template compilation; child processes take argument arrays, never an interpolated string |
| C5 | Path traversal and file access | a user-supplied path is resolved and proven under one root; uploads carry size and type limits; static serving cannot escape its directory |
| C6 | SSRF and outbound calls | user input cannot choose the host; an allowlist, a redirect limit and a timeout; no metadata endpoint |

## Tier 2 — OWASP Top 10 (2025)

The 2021 edition is superseded; the official documents live at
https://github.com/OWASP/Top10 and https://owasp.org/Top10/2025/. Record which arm answers
each row: `sca`, `secret`, `sast`, or `manual`.

| ID | The question this change raises |
|---|---|
| A01 | Broken access control — can a caller act outside its role or tenant? Server-side request forgery sits here in 2025. |
| A02 | Security misconfiguration — defaults, headers, verbose errors, open admin paths? |
| A03 | Software supply chain failures — an unwaived advisory, an unpinned dependency or build input? |
| A04 | Cryptographic failures — weak algorithms, missing transport or at-rest encryption? |
| A05 | Injection — SQL, command, template or HTML built from untrusted input? |
| A06 | Insecure design — a business-flow guard missing rather than mistyped? |
| A07 | Authentication failures — session, token, password or multi-factor handling? |
| A08 | Software or data integrity failures — unsigned artefact, untrusted deserialisation? |
| A09 | Security logging and alerting failures — a security event that leaves no trace or no alert? |
| A10 | Mishandling of exceptional conditions — an error path that leaks, skips a check or fails open? |

## Tier 3 — OWASP ASVS, chapter level (ASVS 4.0.3; for 5.0 map by chapter name)

Record the level the project targets (L1, L2 or L3) and answer at that depth.

| Chapter | The question at the target level |
|---|---|
| V1 | Architecture, design and threat modelling — does the change keep them current? |
| V2 | Authentication — enrolment, credentials, recovery, multi-factor? |
| V3 | Session management — cookie flags, timeout, rotation, logout? |
| V4 | Access control — deny by default, least privilege, no insecure object reference? |
| V5 | Validation, sanitisation and encoding — every input and every output? |
| V6 | Stored cryptography — key management and algorithm choice? |
| V7 | Error handling and logging — no secret in an error, an audit trail where it matters? |
| V8 | Data protection — classification, retention, no personal data in logs? |
| V9 | Communication — transport encryption, certificate validation, no plaintext fallback? |
| V10 | Malicious code — no backdoor, no unbounded deserialisation? |
| V11 | Business logic — anti-automation, correct sequencing, no abuse of a flow? |
| V12 | Files and resources — upload, download, path handling? |
| V13 | API and web service — authentication, method and content-type rules? |
| V14 | Configuration — dependency inventory, secrets, build and deploy hardening? |

## Tier 4 — CWE Top 25

https://cwe.mitre.org/top25/ is the shared vocabulary: name a weakness (`CWE-79`) and its
rank in the finding. It is not a second pass.

## Recording a finding

`<source: checklist row / standard / advisory id or rule id> · <severity> · <disposition> · <anchor>`

An unwaived high or critical, an unresolved ASVS row at the target level, or a committed
secret is a REJECT unless a human accepts the risk under E4. A secret is never waivered:
rotate and purge. A `.vue` or Svelte single-file component has no SAST extractor — answer
C2 and C4 here, by hand, and record the scanner gap as `n/a — no extractor`.
