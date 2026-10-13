---
name: meerkat-taskpanel
description: Coordinate work across an AI Agent team using a shared local task board. Use when an agent or a human needs to create and track tasks, move them through a status workflow, assign owners, comment on a decision, link parent/child and blocking relations, record which agent session is working on what, deliver a task with a report, write a periodic (daily / weekly / monthly) report with statistics over completed work, or export the board as markdown. Runs the local `taskctl` CLI; no network required.
---

# Meerkat TaskPanel

Meerkat TaskPanel is a local-first task board for AI Agent teams. Agents coordinate through a
single shared state store instead of ad-hoc chat messages: each agent claims a task, sends
periodic heartbeats so the board can tell liveness from abandonment, reports progress and
status transitions, and rolls child results up its dependency tree.

This skill is the agent-facing entry point. It is a thin wrapper over the `taskctl` CLI.

> **Status: M2.** The command surface is implemented and aligned with `task-interface v1`.
> `taskctl` is an HTTP client for `taskd`, the local board service, and starts one
> when there is none (set `TASKD_NO_AUTOSTART=1` to forbid that). See
> `references/cli.md` for the full surface, the delivery gate and the `--json` contract.

## Running the CLI

From this skill's directory:

```bash
node scripts/run.mjs --help
node scripts/run.mjs --version
```

`scripts/run.mjs` resolves the repository root relative to itself and spawns
`src/cli/index.mjs`, piping stdin/stdout/stderr and propagating the exit code — so it works
regardless of the current working directory.

If `taskctl` is on your `PATH` (installed via `install.sh` or `npm link`), call it directly:

```bash
taskctl --help
```

## Claiming work (claim-first)

**Claim first, and only claim what is yours to claim.** Before touching a card,
read the claimable set for *you* and take exactly one:

```bash
taskctl issue candidates --assignee <me>   # read-only: what may I claim?
taskctl issue move <ref> in_progress       # take exactly one
```

Do **not** claim a card that any of these is true of — it is not yours:

- it is **assigned to someone else** (the board refuses a claim by a different
  actor; it is never silently reassigned);
- it sits in **`backlog`** and has not been released for work (only the
  dispatcher or a human moves it to `todo`);
- it is an **`epic`** — a container, not a unit of work; claim its leaf children;
- it is a **deployment card** (`kind: deploy`) — deployment work runs against a
  live instance and is dispatched explicitly, so it is never auto-claimed;
- a **`depends_on` blocker is not `done`**.

`issue candidates --assignee <me>` already withholds the last three; use
`taskctl relation list <ref>` when a card you expected is missing. Hold **one
card at a time**, keep its claim fresh, deliver with a report, and stop at
`in_review` — a human accepts to `done`.

These are the eight shared rules: claim-first, claim only what you should, one
card at a time, a fresh heartbeat, deliver with a report, self-review ≠
acceptance, never preempt a conflict, and stay traceable. The full statement, the
per-host differences (Claude Code / Codex) and a worked example are in
[`references/practice-guides.md`](references/practice-guides.md).

## When to use it

- **Finding the board** — the board holds no directories; look the directory up in the
  `projects.json` kept beside this skill (see
  [Configuring project directories](#configuring-project-directories)).
- **Starting work** — `taskctl issue candidates --assignee <me>` to find your
  claimable cards, then `taskctl issue move <id> in_progress` (see
  [Claiming work](#claiming-work-claim-first)).
- **Asking for something** — `taskctl issue create --project <id> --title "…" --acceptance "…"`.
- **While working** — `taskctl comment add <id> --body "…"`; a `decision`/`change`
  comment is what a reviewer reads later.
- **Delegating** — `taskctl issue create --kind epic …` plus
  `taskctl relation add <parent> --type parent --target <child>`.
- **Finishing** — `taskctl report template <id>` to get a report, fill in the TODO
  lines, then `taskctl issue deliver <id> --report-file -`. **The board will not let a
  task into `in_review` without a report** for the current round: the refusal prints the
  exact command that fixes it.
- **Reporting on a period** — `node scripts/report.mjs --period daily|weekly|monthly`
  builds a daily/weekly/monthly report plus its statistics from the cards completed in
  the window. `--group-by` picks the dimension (`kind` by default, or `project` /
  `assignee` / `status` / `label:<namespace>`); `--preset <name>` adds named metrics —
  the shipped `software` preset is one example, and the statistics are domain-agnostic.
  The templates, the counting rules and how to define your own metrics live in
  [`references/reports.md`](references/reports.md).

## Configuring project directories

**The board holds no directories.** A board project carries no `workspace_path`, there is
no `context` command, and the file importer names no directory anchor — by design:
taskpanel does not manage project directories. The **local** map is a
`projects.json` kept **beside this skill** (next to `SKILL.md`), and it is the only
place that answers "which directory is this project working in".

Add one entry per project — the **absolute** target directory and the **board project
identity**:

```json
{
  "projects": [
    { "local_path": "/Users/you/code/meerkat-taskpanel", "project": "TaskPanel" }
  ]
}
```

`local_path` is the local checkout (an absolute path); `project` is the board project —
its **id** (preferred) or name. A directory resolves to the entry whose `local_path` is
that directory or an ancestor of it; when several match, the **longest** path wins.

`local_path` is **required, and it is checked**: it must be an absolute path that
exists and *is* a directory. An entry that fails any of the three is as unusable as no
entry at all — a stale path is a moved checkout, and a worker started there would be
working the wrong repository.

**Ask when there is no answer — never continue without one.** A project absent from
`projects.json` has **no target directory**, and the board cannot supply one. Do not
guess, and do not derive one. When a step needs the directory — a wake, or any command
that must run *in* the project — stop and **ask the user which directory it is**:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will add it to projects.json beside this skill
(references/projects-json.md) — the board cannot supply one.
```

The same prompt applies to a registered-but-unusable path, naming what is wrong
(missing, relative, or not a directory). `taskctl project dir <project>` is the
command form of this rule: it prints the resolved directory, or exits non-zero with
that question instead of continuing. The **wake glue** uses the same map and the same
rule, so a woken worker runs in the project's directory — or the wake is refused.

Work that needs no directory (claiming, moving, commenting, delivering) is unaffected.
The full schema, the resolution rule and the re-install behaviour are in
[`references/projects-json.md`](references/projects-json.md).

Two boundaries this respects, on purpose: **taskpanel does no project-directory
management**, and **whether you manage a project's source data with `meta` is your own
call** — taskpanel neither prescribes it nor advises it, and neither does this skill.

## Reference

See [`references/card-schema.md`](references/card-schema.md) for the **card format** — every
frontmatter key and every body section, i.e. what `taskctl export` writes and the md migrator
reads back (the known keys, what an empty value means, and how a card round-trips),
[`references/cli.md`](references/cli.md) for the command surface, the delivery gate,
the report template and the `--json` contract,
[`references/reports.md`](references/reports.md) for periodic reports and statistics,
[`references/projects-json.md`](references/projects-json.md) for the local
project ↔ board project map, and
[`references/practice-guides.md`](references/practice-guides.md) for the claim-first
practice guide (Claude Code / Codex best practices).
