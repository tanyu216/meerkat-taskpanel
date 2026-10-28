/**
 * `report template <id>` (A4, §F-D).
 *
 * The point of this command is friction: writing a report should be *filling
 * one in*, not remembering a schema. It produces a document that `deliver`
 * accepts immediately.
 *
 * Three decisions, all of them deliberate:
 *
 *   * **`status: "not_met"` by default.** A template must never assert that work
 *     passed — the whole reason the gate exists is that "no empty reports" is
 *     the rule, and a template that said `met` would be an empty report wearing
 *     a costume. `leftovers` gets a TODO placeholder so the shape is still valid.
 *   * **acceptance comes from the card**: `meta.acceptance` first (written by
 *     `issue create --acceptance`), then `meta.acceptance_legacy` (the checkbox
 *     list carried by an imported card), then nothing plus a warning. `checked` is
 *     *not* consulted: a ticked box on an imported card is not evidence.
 *   * **evidence anchors are explicit first, guessed second, never invented**:
 *     `--commit`/`--path`/`--command`/`--coverage` become anchors verbatim; with
 *     no flags the command asks git (read-only); if git is not there — a
 *     container has no `.git` — it degrades silently to a placeholder path
 *     rather than failing or emitting an evidence-free report.
 */

import { spawnSync } from "node:child_process";

import { DomainError } from "../../foundation/errors.mjs";
import { TODO_PLACEHOLDER } from "../../foundation/report-warning.mjs";
import { table } from "../output/human.mjs";

/** Parse the report JSON a caller handed us — the one place a bad file is named. */
export function parseReport(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DomainError("CLI_IO", {
      message: `the report is not valid JSON: ${err.message}`,
      hint: { fix: "`taskctl report template <id>` prints a report that is known to be valid" },
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("CLI_IO", { message: "the report must be a JSON object" });
  }
  return parsed;
}

/**
 * Acceptance items for a task, and where they came from.
 *
 * @param {object} task a wire task
 * @returns {{items: {text: string, status: string, note?: string}[], source: string, warning: string|null}}
 */
export function acceptanceFrom(task) {
  const meta = task.meta ?? {};
  // 0032 — the frozen snapshot is the authority. The meta list is only a seed
  // (and the fallback for a grandfathered card whose snapshot is still empty).
  const snapshot = Array.isArray(task.acceptance) ? task.acceptance : null;
  if (snapshot !== null && snapshot.length > 0) {
    return {
      items: snapshot.map((text) => ({ text: String(text), status: "not_met", note: "TODO: status + evidence[1] — what you saw" })),
      source: "acceptance_json",
      // The marker is a flag, not a verdict: it says the worker derived the list
      // at claim, so the reviewer may want to re-check its coverage.
      warning:
        meta.acceptance_derived === "yes"
          ? "these acceptance items were derived at claim (meta.acceptance_derived=yes); make sure your report answers each one"
          : null,
    };
  }

  const modern = Array.isArray(meta.acceptance) ? meta.acceptance : null;
  if (modern !== null && modern.length > 0) {
    return {
      items: modern.map((text) => ({ text: String(text), status: "not_met", note: "TODO: status + evidence[1] — what you saw" })),
      source: "meta.acceptance (no frozen baseline)",
      warning:
        "this card has no frozen acceptance baseline; meta.acceptance is a seed and the card is treated as vacuously covered until it is reworked",
    };
  }

  const legacy = Array.isArray(meta.acceptance_legacy) ? meta.acceptance_legacy : null;
  if (legacy !== null && legacy.length > 0) {
    return {
      // `checked` is dropped on purpose: a ticked box on an imported card says
      // what the author intended, not what this delivery achieved.
      items: legacy.map((entry) => ({
        text: String(entry?.text ?? entry),
        status: "not_met",
        note: "TODO: status + evidence[1] — what you saw",
      })),
      source: "meta.acceptance_legacy",
      warning: "acceptance came from the imported card's checkboxes; `checked` is not evidence, so every item starts not_met",
    };
  }

  return {
    items: [],
    source: "none",
    warning:
      "no acceptance items on this task; add them with `issue create/update --acceptance <text>`, or fill the list in by hand",
  };
}

/**
 * Evidence anchors: explicit flags first, then best-effort git, then a path
 * placeholder. Never returns an empty list — an evidence-free report would be
 * refused by `validateReport`, and "the tool produced something invalid" is a
 * worse failure than a placeholder.
 *
 * @param {{commit?: string, paths?: string[], commands?: string[], coverage?: string[], task?: object, run?: Function}} input
 */
export function evidenceFor(input) {
  const { commit, paths = [], commands = [], coverage = [], task = null, run = runSync } = input;
  const anchors = [];
  if (commit !== undefined) anchors.push({ kind: "commit", sha: commit });
  for (const path of paths) anchors.push({ kind: "path", path });
  for (const command of commands) {
    // `--command "npm test:0"` — the exit code is what makes it evidence.
    const at = command.lastIndexOf(":");
    const exitCode = at === -1 ? 0 : Number.parseInt(command.slice(at + 1), 10);
    anchors.push(
      at === -1 || !Number.isInteger(exitCode)
        ? { kind: "command", cmd: command, exit_code: 0 }
        : { kind: "command", cmd: command.slice(0, at), exit_code: exitCode },
    );
  }
  for (const entry of coverage) {
    const [lines, scope] = String(entry).split("@");
    anchors.push({ kind: "coverage", lines: Number.parseFloat(lines), ...(scope === undefined ? {} : { scope }) });
  }
  if (anchors.length > 0) return { anchors, source: "flags" };

  const sha = run("git", ["rev-parse", "HEAD"]);
  if (sha !== null && /^[0-9a-f]{7,40}$/.test(sha.trim())) {
    // `rev-parse HEAD` succeeds on a dirty tree and names the *previous*
    // commit. Stamping that as the delivery sha is exactly the trap the
    // delivery contract closes: the report would cite a commit that does not
    // contain the work. Ask `status` too; a non-empty answer means "commit
    // first", never "HEAD is close enough".
    const status = run("git", ["status", "--porcelain"]);
    if (status === null || status.trim() === "") {
      anchors.push({ kind: "commit", sha: sha.trim() });
      return { anchors, source: "git" };
    }
    if (task?.source_path !== null && task?.source_path !== undefined) {
      anchors.push({ kind: "path", path: task.source_path });
    } else {
      anchors.push({ kind: "path", path: "<the files you changed>" });
    }
    return { anchors, source: "dirty-tree" };
  }

  if (task?.source_path !== null && task?.source_path !== undefined) {
    anchors.push({ kind: "path", path: task.source_path });
    return { anchors, source: "source_path" };
  }

  return { anchors: [{ kind: "path", path: "<the files you changed>" }], source: "placeholder" };
}

/**
 * Run a command for its stdout. Read-only, best effort: a missing `git` (the
 * container has none, and no `.git`) is a `null`, not an error.
 *
 * @param {string} cmd @param {string[]} args
 */
export function runSync(cmd, args) {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 2_000 });
    // A missing binary, a signal and a non-zero exit are all "no answer" — this
    // probe exists to fill in an anchor when it can, never to fail a command.
    if (result.error !== undefined && result.error !== null) return null;
    if (result.status !== 0) return null;
    return result.stdout ?? null;
  } catch {
    return null;
  }
}

/** The report a human fills in. */
export function buildTemplate(task, options = {}, context = {}) {
  // 0033 — an epic's report *is* its rollup: one item per child, joined by
  // `ref`. The template lists the live children so the author cannot deliver a
  // rollup that never mentions one.
  const children = Array.isArray(context.children) ? context.children : null;
  const acceptance =
    task.kind === "epic" && children !== null
      ? { items: children.map(childTemplateItem), source: "children (rollup)", warning: null }
      : acceptanceFrom(task);
  const evidence = evidenceFor({ ...options, task });
  const warnings = [];
  if (acceptance.warning !== null) warnings.push(acceptance.warning);
  if (evidence.source === "placeholder") {
    warnings.push("no git and no --commit/--path: the evidence anchor is a placeholder you must replace");
  }
  if (evidence.source === "git") {
    warnings.push("evidence anchors were filled from `git rev-parse HEAD`; add --path/--command for real proof");
  }
  if (evidence.source === "dirty-tree") {
    warnings.push(
      "the working tree has uncommitted changes, so the template cannot name a commit — " +
        "commit the work, then pass --commit <sha>",
    );
  }

  const report = {
    conclusion: `TODO: one paragraph on what was done and how you know it works (${task.identifier})`,
    acceptance:
      acceptance.items.length > 0
        ? acceptance.items
        : [{ text: task.title, status: "not_met", note: "TODO: status + evidence[1] — what you saw" }],
    evidence: evidence.anchors,
    leftovers: TODO_PLACEHOLDER,
  };
  return { report, warnings, acceptanceSource: acceptance.source, evidenceSource: evidence.source };
}

/**
 * One child line in an epic rollup template. `done` → `met` **only after the
 * author confirms it** — the template writes `not_met` like every other line,
 * because an untouched template must never be a passing report. A `canceled`
 * child is `not_applicable` with a TODO note: the cancellation is a fact, the
 * reason it was acceptable is the author's to state.
 */
function childTemplateItem(child) {
  const label = `${child.ref} ${child.title ?? ""}`.trim();
  if (child.status === "canceled") {
    return {
      ref: child.ref,
      text: `${label} (canceled)`,
      status: "not_applicable",
      note: "TODO: why it was acceptable to finish without this child",
    };
  }
  return {
    ref: child.ref,
    text: `${label} (${child.status ?? "unknown"})`,
    status: "not_met",
    note: "TODO: met for a done child, or explain the state",
  };
}

/**
 * The first line of a report's conclusion, which is where a review verdict
 * lives (`VERDICT: APPROVE|REJECT`). The human listing keeps it short; the JSON
 * keeps the whole report.
 *
 * @param {string} conclusion
 * @param {number} [limit]
 */
export function conclusionHeadline(conclusion, limit = 72) {
  const first = String(conclusion ?? "").split("\n")[0].trim();
  return first.length > limit ? `${first.slice(0, limit - 3)}...` : first;
}

export const COMMANDS = [
  {
    name: "list",
    summary: "List a task's delivery reports, newest round last.",
    usage: "report list <id|identifier> [--round <n>]",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      {
        flag: "round",
        key: "round",
        as: "number",
        value: "<n>",
        summary: "Only reports for this delivery round.",
      },
    ],
    async run(ctx) {
      const { reports } = await ctx.client.get(
        `/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/reports`,
      );
      // The route serves every round; `--round` narrows locally rather than
      // growing the HTTP surface (a reviewer asks for the current round, and it
      // is one read either way).
      const filtered = ctx.flags.round === undefined
        ? reports
        : reports.filter((report) => report.round === ctx.flags.round);
      const human = filtered.length === 0
        ? "no reports"
        : table(
            ["round", "created_at", "author", "conclusion"],
            filtered.map((report) => [
              report.round,
              report.created_at,
              `${report.author?.display_name ?? report.author_id} (${report.author?.kind ?? report.author_kind})`,
              conclusionHeadline(report.conclusion),
            ]),
          );
      return { data: { ref: ctx.args.ref, reports: filtered }, human };
    },
  },

  {
    name: "template",
    summary: "Print a report template for a task, ready to fill in and deliver.",
    usage: "report template <id|identifier> [--commit <sha>] [--path <p>]…",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [
      { flag: "commit", key: "commit", as: "string", value: "<sha>", summary: "Evidence: a commit sha." },
      { flag: "path", key: "paths", as: "string", value: "<path>", repeat: true, summary: "Evidence: a changed path; repeatable." },
      { flag: "command", key: "commands", as: "string", value: "<cmd:exit>", repeat: true, summary: "Evidence: a command and its exit code." },
      { flag: "coverage", key: "coverage", as: "string", value: "<pct[@scope]>", repeat: true, summary: "Evidence: a coverage percentage." },
    ],
    async run(ctx) {
      const task = (await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}`)).task;
      // 0033 — an epic template is a rollup over its children. The relations
      // route names them by id; the parent cap is 8, so resolving each one is a
      // bounded read, and the template needs the identifier + title + state.
      let children = null;
      if (task.kind === "epic") {
        const relations = await ctx.client.get(
          `/api/v1/tasks/${encodeURIComponent(task.id)}/relations`,
        );
        children = [];
        for (const edge of relations.children) {
          const child = (await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(edge.target)}`)).task;
          children.push({ ref: child.identifier, title: child.title, status: child.status });
        }
      }
      const template = buildTemplate(
        task,
        {
          commit: ctx.flags.commit,
          paths: ctx.flags.paths,
          commands: ctx.flags.commands,
          coverage: ctx.flags.coverage,
        },
        { children },
      );
      return {
        data: { report: template.report, acceptance_source: template.acceptanceSource, evidence_source: template.evidenceSource, ref: task.identifier },
        // The human output is *exactly* the report, so the obvious thing a user
        // types — `taskctl report template X > report.json` — produces a file
        // `deliver` accepts. The guidance goes to stderr, where it cannot
        // corrupt the document.
        human: `${JSON.stringify(template.report, null, 2)}\n`,
        warnings: [
          ...template.warnings,
          `replace every TODO line before delivering (${task.identifier})`,
        ],
      };
    },
  },
];
