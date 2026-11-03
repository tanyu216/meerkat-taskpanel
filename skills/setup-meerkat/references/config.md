# Configuration

Step 2. The board, the CLI and the loop read layered configuration; this step finds the
conflicts the layers hide and repairs only what the user approves.

## The layers and their precedence

Configuration is read in this order, highest first:

1. a CLI flag (`--url`, `--token`, `--env-file`);
2. the process environment;
3. the per-kind file `<program root>/.env.<actor-kind>`;
4. the shared `<install root>/.env` (`MEERKAT_TASKPANEL_ENV_FILE` can relocate it);
5. the built-in default.

`MEERKAT_TASKPANEL_CONFIG_DIR` relocates the config root, and with it every `.env.<kind>`,
`projects.json` and `roles.json`. It is a locator: it cannot live inside the file it names.

The two files are **not** interchangeable:

- the shared `.env` carries the board/CLI keys (`TASKD_*`, `TASKCTL_AGENT`,
  `TASKCTL_HUMAN`, the SLA table);
- the per-kind `.env.<actor-kind>` carries the loop policy (`MEERKAT_TASKPANEL_*`) and the
  board path's three per-kind keys (`TASKCTL_AGENT`, `TASKCTL_HUMAN`,
  `MEERKAT_TASKPANEL_REPO`).

`TASKD_URL`, the token and the board keys do **not** come from `.env.<kind>`; only the loop
policy does.

## The audit

```bash
node <skill-dir>/scripts/audit-config.mjs --home <home> --actor-kind <kind> --json
```

The script is read-only. It prints `{layers, conflicts, recommendations}`; every conflict
carries `key`, `file`, `layer`, `line`, `severity` (`error`/`warn`) and `why`. Secret values
are shown as `<set>`. `--fail-on-conflict` exits 1 when anything is found; otherwise it exits
0 (exit 2 is usage). **No conflicts is a fact**: report `unchanged` and ask nothing. Only a
non-empty `conflicts` list opens a question.

What it reports:

- **Shared `.env` hard errors**: a repeated key, a `MEERKAT_TASKPANEL_*` loop key, or an
  unknown key in the `TASKD_`/`TASKCTL_`/`MEERKAT_TASKPANEL_` namespace. The board loader
  refuses the file with `CONFIG_FILE_INVALID`; this is not a "last one wins" case.
- **Per-kind silent duplicates**: a repeated key in `.env.<kind>` is last-wins. The loader
  accepts it, so only the audit can surface it.
- **Mislaid keys**: `TASKD_*` in `.env.<kind>` is ignored by both the board and the loop;
  `TASKCTL_*` there is used only for `TASKCTL_AGENT` and `TASKCTL_HUMAN`.
- **The token pair**: `TASKD_TOKEN` and `TASKD_TOKEN_FILE` together is an error; keep
  exactly one. A token file whose mode is not `0600` is a warning.
- **The address**: `TASKD_URL` differing between the explicitly configured sources (process
  env, shared `.env`, the runtime pointer). Report the winner; the built-in
  `http://localhost:9527` is the fallback, not a configured source, and there is no per-kind
  `TASKD_URL`.
- **Identity**: `TASKCTL_HUMAN` differing between `.env.<kind>` and the host's own settings
  (Claude's settings file is the only one this step reads). A missing or unreadable
  settings file is `unavailable`, not a conflict.
- **Kind order**: `MEERKAT_TASKPANEL_AGENT_KIND_ORDER` naming a kind that is not installed or
  has no CLI.
- **The unassigned-card policy**: `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes` (the installer's
  default) makes an unassigned card claimed as `Worker`, never as whichever role scans first.
  Keep it `yes` unless the user explicitly wants unassigned cards left in the public pool;
  turning it off is a claim-policy decision, not a tuning tweak.
- **Deprecated keys**: `MEERKAT_TASKPANEL_REVIEWER` is ignored by the code — report it as
  deprecated, do not delete it. `MEERKAT_TASKPANEL_ROLES_DIR` pointing at directories that
  contain `role.json` is a **valid discovery override**, not a retired key; only a tree
  without those markers is retired.
- **Exposure** (report only): a non-loopback `TASKD_HOST` with the allow-list off suggests
  `TASKD_ALLOW_CIDRS`.

## Repairing

Show each conflict with its file, line, severity and what the loader does with it, then ask
which to repair. Offer: **Repair all recommended (recommended)** — the listed fixes are
applied through the writer, one key at a time, and the audit is re-run; **Repair selected** —
only the keys the user names; **Leave as is** — nothing changes, and name the consequence (a
hard error makes the board loader refuse the file). Repair one key at a time through the
writer:

```bash
# set one value
node <skill-dir>/scripts/configure-env.mjs --file <the file that owns the key> \
  --key <KEY> --value <value> --json
# remove a mislaid key, or every copy of a duplicated key
node <skill-dir>/scripts/configure-env.mjs --file <the file that owns the key> \
  --key <KEY> --remove --json
```

Exit 3 means the file already holds a different value. Show the existing value (never a
secret) and ask before `--force`; replacing different content is a separate safety
confirmation. Comments, blank lines and unrelated keys survive both
operations; the writer is idempotent and reports `written` / `removed` / `unchanged` /
`conflict`.

A mislaid key or a duplicated key is repaired by **removal**, not `--force`: replacing every
matching line with the same value would leave the duplicate in place. Remove the lines, then
set the single value that belongs there. `--force` is only for a single existing line whose
value differs.

Never move a key across layers to "fix" a conflict: a loop key in the shared file is a hard
error, and a board key in the per-kind file is ignored. Fix the layer, then re-run the audit.

When the board is remote, skip the taskd-side parameters (`TASKD_HOST`, `TASKD_PORT`,
`TASKD_DATA_DIR`, `TASKD_ALLOW_*`); only the address, token and loop policy are in scope.
