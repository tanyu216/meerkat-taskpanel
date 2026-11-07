# Security checklist — the reviewer's manual audit

Read this beside `SKILL.md`. Every row gets one disposition and an anchor:
`met` (and how you checked), `not_met`, or `n/a — <reason>`. A blank row is an omission.
Tier 1 is answered on every code-changing card; Tiers 2 and 3 are answered for the surface
the card changes. A documentation-only card records one `n/a — <reason>` per tier.
The scanner supplies evidence; you classify the row.

For a **code-changing change** the checklist is a mandatory part of the verdict: the
verdict carries the row table, and a blank row, an unwalked tier or a missing table is a
`REJECT`, whatever the code's quality.

The list is a floor, not a ceiling. A security check this card's surface calls for and no
row above names is still yours: run it with any available read-only method, and record it the
same way. An extra security finding can block APPROVE.

## Tier 1 — core (always)

| # | Topic | What proves it |
|---|---|---|
| C1 | Authorization and ownership | every read and write checks the caller's role and the object's owner; every request id is validated; a list returns only the caller's tenant rows |
| C2 | Input validation and output encoding | one validation at the boundary; parameterised queries; raw-HTML sinks take escaped input; template expressions use trusted values |
| C3 | Secrets and configuration | secrets stay out of the change, fixtures, logs and errors; the value comes from configuration; environment files are untracked |
| C4 | Injection and dangerous sinks | SQL, shell, `eval`, `Function`, template compilation; child processes take argument arrays |
| C5 | Path traversal and file access | a user-supplied path is resolved and proven under one root; uploads carry size and type limits; static serving stays inside its directory |
| C6 | SSRF and outbound calls | the host comes from an allowlist rather than user input; a redirect limit and a timeout; the metadata endpoint stays out of the allowlist |

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

Read the target level the project records in `docs/tech-spec.md` (project-level design) and
answer at that depth. Where the project records none, answer at **L2** and record the default
as the reason; the project's recorded level always wins.

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

## Recording a finding

`<source: checklist row / standard / advisory id or rule id> · <severity> · <disposition> · <anchor>`

An unwaived high or critical, an unresolved ASVS row at the target level, or a committed
secret is a REJECT unless a human accepts the risk under E4. On a code-changing change, an
incomplete row table is the same kind of REJECT: every applicable row carries its
disposition and its anchor. A committed secret is rotated
and purged rather than waivered. A `.vue` or Svelte single-file component has no SAST extractor — answer
C2 and C4 here, by hand, and record the scanner gap as `n/a — no extractor`.
