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
├── linus/{workflow.md,self-check.md}
├── turing/{workflow.md,self-check.md}
└── reviewer/{workflow.md,reviewer-prompt.md}
```

## Project artifacts

A design card keeps its product artifacts in the **project's** `design/` tree, not in the
card directory:

```text
design/
├── specs/<task-id>.md        # product planning: problem, direction, assumptions
├── prototype/<task-id>/      # prototype, screenshots, verification evidence
└── prds/<task-id>.md         # the PRD, written after the prototype validates the design
```

`.meerkat/<id>/plan.md` stays the card index: it links to those artifacts and carries the
acceptance mapping, risks and open questions. All paths are project-relative; never use an
absolute path or another project's tree.

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

The reviewer's prompt is inlined at the start of the reviewer handoff (bounded); the
worker workflow stays a path.

## Board names and the scan set

`install-roles.mjs` writes the team's board names to the agent config:

```text
MEERKAT_TASKPANEL_AGENTS=Jobs,Linus,Turing
MEERKAT_TASKPANEL_REVIEWER=Reviewer
```

Without `MEERKAT_TASKPANEL_AGENTS` the loop scans only its default agent; a role card is
never claimed. The reviewer is added by the existing reviewer scan. A role may also be
listed with repeated `--agent` flags.

## Native agent definitions

Claude (`~/.claude/agents/<name>.md` or `<project>/.claude/agents/`) and Codex
(`~/.codex/agents/<name>.toml` or the project's `.codex/agents/`) are generated from
`assets/team/standard/agents/<kind>/role.*.tmpl`. The definition points at the installed
workflow and self-check. Other actor kinds are skipped with a warning; their subagent
still receives the workflow path in the handoff.

## Custom teams

Stage a copy of the standard template, edit the manifest and workflows with the user,
show the preview, then install with `--source <staging>`. `--role <id>` selects a subset;
`--agent <id>=<name>` renames a board identity; `--reviewer <name>` renames the reviewer.
The manifest is written last; existing different files are conflicts unless `--force`.

## Decisions

The team's `decision-policy.md` (or the loop default) defines the ladder
**subagent → main session → human**. A subagent never decides an unauthorized question;
it writes an agent `question` comment and stops. The project session answers with a
`note` and reattaches/requeues, or escalates E1-E5 to the human. Any human comment resumes
an awaiting card, whatever its kind (the resumed worker judges its content); the loop never
writes a decision kind and never uses `--as-human` for its own answer.
