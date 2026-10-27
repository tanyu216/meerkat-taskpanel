# Team roles

A team is an **optional** roles root. `install.sh` never ships one; `setup-meerkat`
copies a template only after the user confirms. With no roles root the loop behaves
exactly as it did before the feature.

## Layout

```text
<roles-root>/
├── manifest.json
├── decision-policy.md          optional; overrides the loop's default policy
├── jobs/{workflow.md,ui-workflow.md,self-check.md}
├── linus/{workflow.md,architecture-workflow.md,implementation-workflow.md,self-check.md}
├── turing/{workflow.md,test-design-workflow.md,regression-workflow.md,performance-workflow.md,self-check.md}
└── reviewer/{workflow.md,reviewer-prompt.md}
```

## Card and plan lifecycle

The board has no stage model: routing is by `assignee`, and the project session owns the
card-shape decision. Before creating a downstream card it confirms the target and whether a
matching product archive exists:

| Target | Shape | Design inputs |
|---|---|---|
| A bug, or a small change with no product-visible behaviour | one `task` | none; `meta.product_change=none` |
| A feature with an archived spec/prototype/PRD | one `task` per downstream stage, or one | the card's `## Handoff`; `meta.design_stage=<design-ref>` |
| A large feature with several independently verifiable deliverables | an `epic` + one `task` per deliverable | the handoff on the epic and each child; the child's scope |

- Every card's worker writes `.meerkat/<id>/plan.md` before starting. A rework of the same
  card extends it; another card's plan is never this card's plan.
- A producer card (design or architecture) sets `meta.stage_handoff=required` and writes a
  `## Handoff` block into its delivery report `conclusion`: the archived paths, the
  acceptance source, the delivery shape and the proposed next cards.
- The project session creates the next card in `backlog` with `--meta design_stage=<ref>`,
  copies the block into the description, seeds `--acceptance` from the acceptance source,
  links `relation add <producer> --type blocks --target <next>`, then moves it to `todo`.
  When the card changes code, the acceptance seed also carries the mandatory gates (100%
  pass, >80% coverage, mock boundary, security scan), so the review card's baseline has
  them.
- An epic is `kind=epic` and is not claimable; children are `kind=task` linked with
  `relation add <epic> --type parent --target <child>`. The epic's only delivery report is
  the rollup.
- `blocks` gates on `done`; a canceled producer withholds the downstream card forever, so
  remove the edge or cancel the downstream card.
- Bug and small-change cards carry `meta.product_change=none`; they use the defect,
  acceptance and baseline, not the design artifacts.

## Test execution vs review gate

Execution belongs to the **review card**: the loop creates it when a card enters
`in_review`, and only the reviewer's verdict moves the card to `done`. A test-execution card
that depends on the development card runs only after that card is `done` — `blocks` does not
block review dispatch — so it cannot gate the verdict. It is post-delivery verification; a
finding creates a fix/rework card.

The reviewer re-runs the mandatory gates and records the commands and results in the
verdict report:

| Gate | Threshold |
|---|---|
| Test suites | unit, integration, API and browser-based (where applicable): 100% pass |
| Coverage | line, branch and function >80% (or the project's stricter floor) |
| Mocks | only at http/websocket/db/redis and comparable external boundaries; never an internal module or function |
| Security scan | the project's documented scan; no unaddressed high/critical |

A separate Turing card is for test design and authoring (unit, integration, API and
browser-based suites), performance/load testing, and a security assessment/pen test. It has
its own plan/report and is reviewed like any worker card; it does not replace the review
gate.

The reviewer audits the changed surface against **CWE Top 25**, **OWASP Top 10** and
**OWASP ASVS** (at the project's target level). A high/critical finding, or an unresolved
ASVS requirement at that level, is a REJECT unless a human accepts the risk under E4.

## Project artifacts

While a design card runs, its product artifacts are **working copies** in the card
directory:

```text
.meerkat/<id>/
├── spec.md                   # product planning: problem, direction, assumptions
├── prototype/                # prototype, screenshots, verification evidence
└── prd.md                    # the PRD, written after the prototype validates the design
```

Archiving is a mandatory workflow stage, not an afterthought. At archive time the working
copies are promoted to the **project's** `design/` tree under one **content slug** — a
kebab-case name that describes the topic and never carries the task id:

```text
design/
├── specs/<content-slug>.md        # the archived spec
├── prototype/<content-slug>/      # the archived prototype and evidence
├── prds/<content-slug>.md         # the archived PRD, when one exists
├── glossary.md                    # product language (Jobs)
└── adr/NNNN-<slug>.md             # product decisions (Jobs)
```

A same-topic artifact is updated rather than duplicated, with the revision recorded in the
decision log. The working copies stay in `.meerkat/<id>/` as the task trail.

`.meerkat/<id>/plan.md` stays the card index: it links the archived paths and carries the
acceptance mapping, risks and open questions. The `## Handoff` block is the cross-card
channel: the project session copies it into the downstream card's description, and the
reviewer reads the archived paths from it — never from the task id or another card's plan.
Linus and Turing read the archived spec and PRD for a feature or behaviour change only
through the handoff; a bug fix and its regression verification use the defect, its
reproduction and the frozen acceptance instead, and do not treat the design artifacts as
inputs. All paths are project-relative; never use an absolute path or another project's
tree.

`ui-workflow.md` also runs standalone: no card, a `<content-slug>` directly under
`design/`, the brief in `design/specs/<content-slug>.md` is the acceptance source, and
`design/prds/<content-slug>.md` is written only when the change is product-scoped.

## Engineering artifacts

Linus keeps durable architecture at `docs/architecture.md`, the codebase vocabulary at root
`GLOSSARY.md`, and engineering decisions at `docs/adr/NNNN-<slug>.md`; a card-local
architecture change may live in `.meerkat/<id>/architecture.md`. The architecture document
carries the canonical `## Tech stack` table (frontend, backend, persistence and
container/build), and an implementation card inherits that table rather than re-choosing.
It also carries the design-stance evidence (simple, reliable, efficient, elegant, not
over-engineered, high cohesion and low coupling), the architecture-style decision (DDD or a
named simpler style), the external contract, the configuration surface, the logging
contract and the planned directory tree. The contract artifact is canonical, `CLAUDE.md`/`AGENTS.md` carry a top-level
tree map and a pointer, and the `/init` product is the baseline every role reads, carrying
the six design principles as binding requirements for every agent. A feature or module change
applies the same six in `implementation-workflow.md` Step 2.
The root glossary carries a
`## Product language` section that links `design/glossary.md`; product terms are not copied
there. Turing keeps each card's `test-plan.md`, `regression.md` and `performance.md`, with
their evidence, in `.meerkat/<id>/`.

Linus scaffolds the agent instructions with the host's `/init` (writing `CLAUDE.md` or
`AGENTS.md`) and writes the workspace rule into them. The rule is **global**: every role —
Jobs, Linus and Turing — works a card in one linked worktree off the integration branch
(`dev` by default): `git worktree add .worktrees/<card-slug> -b <branch> dev`. The primary
checkout stays on `dev`, and the card's roles share the worktree. Merge and cleanup run only
after reviewer approval or operator confirmation: `git merge --no-ff` into `dev`, then
`git worktree remove`, then `git branch -d` — never `-D`.

## Review ownership

Review is layered. An E5 architecture direction or an E3 design direction is decided by the
project session and the human. The role self-checks its execution. The independent reviewer
audits the delivered artifacts at `in_review` and never re-decides the direction. The
reviewer also checks that acceptance items and test names use the canonical terms.

The **self-check** is the role's own pre-delivery audit: the card's requirements and
acceptance mapped to evidence, with the gates re-run. It is **not** the `## Handoff` block;
that block is a producer card's cross-card transfer (Jobs design, Linus architecture only).
The last stage of every workflow is **Deliver** — run the self-check, add the handoff block
on a producer card, then `issue deliver` at `in_review`.

## Manifest

```json
{
  "version": 1,
  "team": "standard",
  "default_reviewer": "reviewer",
  "roles": [
    {
      "id": "jobs",
      "agent": "Jobs",
      "native_agent": "jobs",
      "lanes": ["worker"],
      "title": "Product design",
      "summary": "…",
      "responsibilities": ["…"],
      "boundaries": ["…"],
      "workflow": "jobs/workflow.md",
      "self_check": "jobs/self-check.md"
    }
  ]
}
```

- `agent` is the **board identity** used by `--agent`, the assignee and the report
  author (`Jobs`, `Linus`, `Turing`, `Reviewer`); matching is case-insensitive.
- `native_agent` is the host-native agent definition name (lowercase; Claude/Codex).
- `lanes` is `worker` and/or `reviewer`; `default_reviewer` names a reviewer-lane role.
- `workflow` is one relative `.md` path or `{ "worker": "...", "reviewer": "..." }`.
- `self_check` and `reviewer_prompt` are optional relative `.md` paths.
- Paths must stay inside the roles root, including through symlinks. A bad path warns and
  leaves that role's path `null`; a malformed manifest warns and degrades to no roles.

## Precedence and the two layers

Whole-manifest precedence: `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`, then
`<project>/.meerkat/roles/`, then `<agent-dir>/skills/meerkat-loop/roles/`, then
`<agent-dir>/meerkat-taskpanel/roles/`. The project set replaces the global set; it is
not merged role-by-role.

1. **Routing** — the loop reads the responsibilities and selects the role named by the
   card's assignee.
2. **Workflow** — the handoff carries the role workflow (and self-check) path; the spawned
   subagent reads them before acting.

The reviewer's prompt is inlined at the start of the reviewer handoff, bounded at 2,400
characters; the worker workflow stays a path.

## Board names and the scan set

`install-roles.mjs` writes the team's board names to the loop config:

```text
MEERKAT_TASKPANEL_AGENTS=Jobs,Linus,Turing
MEERKAT_TASKPANEL_REVIEWER=Reviewer
```

Without `MEERKAT_TASKPANEL_AGENTS` the loop scans only its default agent; a role card is
never claimed. The reviewer is added by the existing reviewer scan. A role may also be
listed with repeated `--agent` flags.

## Native agent definitions

Claude (`~/.claude/agents/<name>.md` or `<project>/.claude/agents/`) and Codex
(`~/.codex/agents/<name>.toml` or `<project>/.codex/agents/`) are generated from
`assets/team/standard/agents/<kind>/role.*.tmpl`. The definition points at the installed
workflow and self-check. `--native-agent-defs none` suppresses all of them; `auto` and
`all` write every kind that has a native format.

Pi gets subagents from the `pi-subagents` extension (`pi install npm:pi-subagents`). Its
definitions are generated to `~/.pi/agent/agents/<name>.md` (global) or
`<project>/.pi/agents/<name>.md`, with a `tools` allowlist (`read, grep, find, ls, bash,
edit, write` for a worker; the read-only set for a reviewer). The definition is inert until
the extension is installed.

## Custom teams

Co-design the team as a decision round in adversarial mode (the protocol and the ownership
test are in `SKILL.md` §The setup interview). Stage a copy of the standard template, then
run the frontier:

1. **Inventory the card shapes.** Ask for the real work the project produces — bug, feature,
   refactor, test-only, docs and release notes, mobile, ops, design, migration — and a
   concrete example of each.
2. **Build an ownership matrix.** Every card shape gets exactly one accountable role. Name
   the card that would fall between two roles if the split is unclear; a shape with no owner
   or two owners is a finding, not a detail for later.
3. **Challenge each role.** Ask what would have to be true for this role not to exist, and
   for a counterexample card the role would handle badly.
4. **Keep an independent reviewer.** The reviewer audits, moves nothing and never enters
   awaiting; a producer never reviews its own card.
5. **Confirm the frontier is empty**, then show the manifest and each role's summary.

Only then edit the manifest and workflows in the staging directory and install with
`--source <staging>`. `--role <id>` selects a subset; `--agent <id>=<name>` renames a board
identity; `--reviewer <name>` renames the reviewer. The manifest is written last; existing
different files are conflicts unless `--force`.

The ladder **subagent → main session → human** is unchanged: only a human comment resumes an
`awaiting` card.

## Decisions

The team's `decision-policy.md` (or the loop default) defines the ladder
**subagent → main session → human**. A subagent never decides an unauthorized question;
it writes an agent `question` comment and stops. The project session answers with a
`note` and reattaches/requeues, or escalates E1-E5 to the human. Any human comment resumes
an awaiting card, whatever its kind (the resumed worker judges its content); the loop never
writes a decision kind and never uses `--as-human` for its own answer.
