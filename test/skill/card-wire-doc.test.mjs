/**
 * The card's two shapes, as the installed skill states them.
 *
 * `references/schema/wire.md` and `schema/records.md` are the pages an agent kind
 * receives; together they document both the wire object and the markdown export.
 * This test pins the missing half:
 *
 *   1. the **wire object** — every key `taskToWire` puts on `data.task`, and the
 *      payload around it, including the sections `--include` adds;
 *   2. the **prose facts** that were wrong before: the comment-kind set, the
 *      blocked-reason literals (and their refusal), `assignee_kind`'s export
 *      rule, and the frozen acceptance baseline.
 *
 * The marked blocks in the page are the fixture; the code is the authority. A new
 * wire field appears in this test automatically — and fails until the page names
 * it.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { GET_INCLUDE_SECTIONS } from "../../src/cli/commands/issue.mjs";
import { BLOCKED_REASONS, COMMENT_KINDS } from "../../src/core/domain/enums.mjs";
import { normalizeBlockedReason } from "../../src/core/domain/blocked-reason.mjs";
import { renderCard } from "../../src/core/storage/md/export.mjs";
import { taskToWire } from "../../src/foundation/wire.mjs";
import { taskPayload } from "../../src/server/task-view.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WIRE = readFileSync(join(ROOT, "skills/meerkat/references/schema/wire.md"), "utf8");
const RECORDS = readFileSync(join(ROOT, "skills/meerkat/references/schema/records.md"), "utf8");
const BLOCKED = readFileSync(
  join(ROOT, "skills/meerkat/references/schema/blocked-reason.md"),
  "utf8",
);

/** The text between `<!-- name:begin -->` and `<!-- name:end -->` in one page. */
function marked(name, doc) {
  const begin = `<!-- ${name}:begin -->`;
  const end = `<!-- ${name}:end -->`;
  const start = doc.indexOf(begin);
  assert.notEqual(start, -1, `the page is missing ${begin}`);
  const stop = doc.indexOf(end, start + begin.length);
  assert.notEqual(stop, -1, `the page is missing ${end}`);
  return doc.slice(start + begin.length, stop);
}

/**
 * The first-column names of a marked table.
 *
 * A cell may spell a payload member (`report_waivers[]`) or a section
 * (`comments`); the suffix is trimmed, so the fixture and the code compare as
 * plain names.
 */
function tableKeys(name, doc) {
  return [...marked(name, doc).matchAll(/^\|\s*`([^`]+)`/gm)]
    .map((match) => match[1].replace(/[\[{].*$/, ""))
    .filter((key) => /^[a-z][a-z0-9_]*$/.test(key));
}

/** A repository stub that answers every read `renderCard` performs. */
const STUB_REPOS = {
  dictionary: { getById: () => null },
  relations: { getParent: () => null, listBlockerOf: () => [] },
  tasks: { get: () => null, list: () => [] },
  comments: { list: () => [] },
  reports: { listByTask: () => [] },
  sessions: { listByTask: () => [] },
  attachments: { listByTask: () => [] },
};

/** The fields `renderCard` needs to render any frontmatter key at all. */
const EXPORT_STUB = {
  identifier: "P-1", title: "T", status: "todo", priority: "medium", kind: "task",
  projectId: "p", description: "", labels: [], meta: {}, version: 1,
  deliveryRound: 1, acceptance: [], acceptanceRevision: 0, acceptanceMode: "off",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  statusChangedAt: "2026-01-01T00:00:00.000Z",
};

describe("wire.md — the wire object", () => {
  it("documents every field taskToWire produces, and nothing else", () => {
    // An empty stub still yields every copied field (the projection writes
    // `null` for an absent source), so the list is the projection, not the stub.
    const wireFields = Object.keys(taskToWire({})).sort();
    assert.equal(wireFields.length, 45, "the projection changed — update the page and this count");

    const documented = tableKeys("wire-card-fields", WIRE).sort();
    assert.deepEqual(documented, wireFields);
    assert.equal(
      new Set(documented).size,
      documented.length,
      "the wire table must not repeat a field",
    );
    assert.ok(documented.length > 30, "a table this short would satisfy nothing");
  });

  it("documents the payload around the task, plus what --include adds", () => {
    const payload = Object.keys(
      taskPayload(
        {
          tasks: { get: () => null },
          relations: { getParent: () => null },
          dictionary: { getById: () => null },
          activities: { list: () => [] },
        },
        { id: "t1" },
      ),
    );
    // `attachments` is composed by the route, not by `taskPayload` — one
    // constant, with the route named here so a future move is noticed.
    assert.deepEqual([...payload, "attachments"].sort(), tableKeys("wire-payload-fields", WIRE).sort());

    assert.deepEqual(
      [...GET_INCLUDE_SECTIONS].sort(),
      tableKeys("wire-include-fields", WIRE).sort(),
      "the --include sections and the page must be one list",
    );
  });
});

describe("records.md — facts that used to be wrong", () => {
  it("lists exactly the comment kinds the board accepts, including question", () => {
    const kinds = [...marked("comment-kinds", RECORDS).matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    assert.deepEqual([...kinds].sort(), [...COMMENT_KINDS].sort());
    assert.ok(kinds.includes("question"), "a worker's question is a comment kind");
  });

  it("lists the eight blocked reasons, and a write of any other value is refused", () => {
    const start = BLOCKED.indexOf("## blocked_reason");
    const end = BLOCKED.indexOf("\n## ", start);
    assert.notEqual(start, -1);
    const section = BLOCKED.slice(start, end === -1 ? BLOCKED.length : end);
    const literals = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((match) => match[1]);
    assert.deepEqual(literals, [...BLOCKED_REASONS]);

    assert.throws(
      () => normalizeBlockedReason("bogus"),
      (err) => err.code === "VALIDATION_FAILED",
      "the page must not claim an unrecognised value is preserved",
    );
  });

  it("says assignee_kind is written only when it differs from the default", () => {
    const human = renderCard({ ...EXPORT_STUB, assigneeKind: "human" }, { repos: STUB_REPOS });
    const agent = renderCard({ ...EXPORT_STUB, assigneeKind: "agent" }, { repos: STUB_REPOS });
    const absent = renderCard({ ...EXPORT_STUB }, { repos: STUB_REPOS });

    assert.match(human, /^assignee_kind: human$/m);
    assert.doesNotMatch(agent, /^assignee_kind:/m, "the default is not re-emitted");
    assert.doesNotMatch(absent, /^assignee_kind:/m);

    const row = RECORDS.split("\n").find((line) => line.startsWith("| `assignee_kind`"));
    assert.ok(row !== undefined, "assignee_kind must stay in the field table");
    assert.doesNotMatch(row, /not re-exported|not re-emitted/);
  });

  it("names the frozen acceptance baseline as the authority", () => {
    const start = RECORDS.indexOf("## Acceptance");
    const end = RECORDS.indexOf("\n## Comments", start);
    assert.notEqual(start, -1);
    const section = RECORDS.slice(start, end === -1 ? RECORDS.length : end);

    assert.match(section, /acceptance_json/, "the column is the authority");
    assert.match(section, /frozen/i);

    // Every mention of the seed must say what it is: a seed/fallback, never the
    // authority. `meta.acceptance_legacy` is a different key and is exempt.
    const mentions = section
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /meta\.acceptance(?!_)/.test(sentence));
    assert.ok(mentions.length > 0, "the page still has to explain the seed");
    for (const sentence of mentions) {
      assert.match(sentence, /seed|fallback|grandfathered/i, sentence);
    }
  });

  it("states the epic rollup requirement in the report section", () => {
    const start = RECORDS.indexOf("## Report");
    const end = RECORDS.indexOf("\n## The process directory", start);
    const section = RECORDS.slice(start, end === -1 ? RECORDS.length : end);
    assert.match(section, /rollup/i);
    assert.match(section, /ROLLUP_REQUIRED/);
  });
});
