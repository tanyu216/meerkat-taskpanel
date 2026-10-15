/**
 * md import — a self dependency is a skipped link, and a skipped link warns
 * (T-20261015-183125 R-c).
 *
 * **This file pins a fix; it does not introduce a new contract.** The residual
 * asked whether a card whose `depends_on` names *itself* being silent in the
 * import's `warnings[]` is a defect. The verdict is **yes, a defect**, because
 * the repo already publishes the opposite for every skipped link:
 *
 *   * `skills/meerkat-taskpanel/references/card-schema.md` — `depends_on`:
 *     "An unresolvable id is a warning + skip (the card still imports)";
 *   * `docs/migration.md` §Risks & checklist — a skipped parent link is
 *     "skipped with a warning … never silently dropped";
 *   * `src/core/storage/md/import.mjs` — every other skipped link in the
 *     relation pass warns: a `depends_on` that is not in the import, a `parent`
 *     that is not in the import, a non-epic `parent`, an invariant refusal.
 *
 * A self reference is the one skipped link that did **not** warn. It reached the
 * `dependsUnresolved` bucket (because the lookup *found* a card — this one), so
 * it took the "unresolved" data path without the "unresolved" prose, and the
 * drill then repeated the same wrong reason in its `note` ("the referenced card
 * is not in this import" — it is: it is the card itself).
 *
 * What the fix does *not* change: the exit code (0 — warnings alone do not fail
 * a run, `migrate-cli.mjs` header; pinned by `import-exit-codes.test.mjs`), the
 * `dependsUnresolved` array, the `unmappable` kind, or any HTTP route. It adds
 * the missing warning and corrects the drill's `note`. The two shapes are told
 * apart by identifier equality, which is exact: the self path is reached only
 * when the id resolves to this very task, and the lookup is case-sensitive, so a
 * differently-spelled self reference is a plain unresolved id (last case below).
 *
 * Fixtures are synthetic hand-written cards (F9), built in a temp dir; the
 * registry is the shared `test/migrate/fixtures/registry/projects.json`.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { main as cliMain } from "../../src/core/storage/md/migrate-cli.mjs";
import { main as reconcileMain } from "../../scripts/migrate/reconcile.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const REGISTRY_PATH = join(import.meta.dirname, "fixtures/registry/projects.json");
const TS = "2026-01-01T00:00:00.000Z";

/** A minimal card; `overrides` are merged into the frontmatter. */
function cardText(overrides = {}) {
  const front = {
    id: "DEMO-0001",
    title: "A card",
    status: "todo",
    priority: "medium",
    kind: "task",
    project: "demo",
    created_by: "elon",
    created_at: TS,
    ...overrides,
  };
  return `---\n${Object.entries(front)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n## Background\n\ntext\n\n## Acceptance\n\n- [ ] one\n`;
}

const EPIC = cardText({ id: "DEMO-0001", title: "The epic", kind: "epic" });
/** `depends_on` naming its own id. */
const SELF = cardText({ id: "DEMO-0002", title: "Depends on itself", depends_on: "[DEMO-0002]" });
/** `depends_on` naming a card no file provides — the *other* shape of the bucket. */
const GHOST = cardText({ id: "DEMO-0002", title: "Depends on a ghost", depends_on: "[DEMO-9999]" });

/** Write `cards` into a fresh dir under a fresh temp root, and return both. */
function writeCards(cards) {
  const dir = join(makeTempDir("md-self-dep-"), "cards");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(cards)) writeFileSync(join(dir, name), text, "utf8");
  return { dir, dbPath: join(makeTempDir("md-self-dep-db-"), "board.sqlite") };
}

/** Run the md CLI, capturing both streams. */
async function runCli(argv) {
  let out = "";
  let err = "";
  const code = await cliMain(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

/** Run the drill and return its exit code plus the parsed report. */
async function runDrill(dir) {
  const outPath = join(makeTempDir("md-self-dep-report-"), "report.json");
  let out = "";
  const code = await reconcileMain(
    ["--dir", dir, "--projects", REGISTRY_PATH, "--out", outPath, "--json"],
    { stdout: (t) => (out += t), stderr: () => {} },
  );
  return { code, report: JSON.parse(readFileSync(outPath, "utf8")) };
}

describe("md import — a self dependency warns instead of vanishing (T-20261015-183125 R-c)", () => {
  it("the self reference is warned, is carried structurally, and lands no edge", async () => {
    const { dir, dbPath } = writeCards({ "DEMO-0001.md": EPIC, "DEMO-0002.md": SELF });

    const { code, out } = await runCli([
      "import",
      "--dir",
      dir,
      "--db",
      dbPath,
      "--projects",
      REGISTRY_PATH,
      "--json",
    ]);
    const payload = JSON.parse(out);

    assert.equal(code, 0, "a skipped link is a warning, not a failed run");
    assert.equal(payload.warnings.length, 1, "the skipped self link is reported exactly once");
    assert.match(payload.warnings[0], /is the card itself/);
    assert.doesNotMatch(
      payload.warnings[0],
      /is not in this import/,
      "the card *is* in the import — the warning must not say otherwise",
    );
    assert.deepEqual(payload.dependsUnresolved, [
      { file: "DEMO-0002.md", identifier: "DEMO-0002", dependsOn: "DEMO-0002" },
    ]);
    assert.equal(payload.relations, 0, "no `blocks` edge can join a card to itself");
  });

  it("the drill names the self reference instead of claiming the card is missing", async () => {
    const { dir } = writeCards({ "DEMO-0001.md": EPIC, "DEMO-0002.md": SELF });

    const { code, report } = await runDrill(dir);

    assert.equal(code, 3, "the unlanded edge is a difference, not a silently accepted skip");
    assert.ok(report.differences.some((line) => /relations:depends_on mismatch/.test(line)));
    const entry = report.unmappable.find((item) => item.kind === "unresolved-depends-on");
    assert.equal(entry.card, "DEMO-0002");
    assert.equal(entry.value, "DEMO-0002");
    assert.match(entry.note, /names itself/);
    assert.doesNotMatch(entry.note, /not in this import/);
    assert.equal(
      report.warnings.some((warning) => /is the card itself/.test(warning)),
      true,
      "the drill's warnings are the importer's — the new warning reaches the reviewer",
    );
  });

  it("a genuinely unresolved id keeps the original wording (the two shapes stay apart)", async () => {
    const { dir, dbPath } = writeCards({ "DEMO-0001.md": EPIC, "DEMO-0002.md": GHOST });

    const { out } = await runCli(["import", "--dir", dir, "--db", dbPath, "--projects", REGISTRY_PATH, "--json"]);
    assert.match(JSON.parse(out).warnings[0], /depends_on DEMO-9999 is not in this import/);

    const { report } = await runDrill(dir);
    const entry = report.unmappable.find((item) => item.kind === "unresolved-depends-on");
    assert.match(entry.note, /not in this import/);
    assert.doesNotMatch(entry.note, /names itself/);
  });

  it("a differently-spelled self reference is a plain unresolved id, not the self shape", async () => {
    // The discriminator the note branches on is identifier equality. This case is
    // what makes it sound: the lookup is case-sensitive, so `demo-0002` does not
    // resolve to `DEMO-0002` at all and takes the unresolved path.
    const { dir, dbPath } = writeCards({
      "DEMO-0001.md": EPIC,
      "DEMO-0002.md": cardText({ id: "DEMO-0002", depends_on: "[demo-0002]" }),
    });

    const { out } = await runCli(["import", "--dir", dir, "--db", dbPath, "--projects", REGISTRY_PATH, "--json"]);
    const payload = JSON.parse(out);
    assert.match(payload.warnings[0], /depends_on demo-0002 is not in this import/);

    const { report } = await runDrill(dir);
    const entry = report.unmappable.find((item) => item.kind === "unresolved-depends-on");
    assert.match(entry.note, /not in this import/, "the lookup did not reach the card, so this is the unresolved shape");
  });
});
