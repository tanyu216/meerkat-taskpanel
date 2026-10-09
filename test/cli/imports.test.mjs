/**
 * The layering rules, machine-enforced (V12).
 *
 * Three structural promises are only worth anything if they are checked rather
 * than documented:
 *
 *   1. `src/cli/**` is an **HTTP client** — it must not reach into
 *      `src/core/storage/**` and it must never open SQLite itself. Anything it
 *      needs from the board it asks for over HTTP. (This is what makes the
 *      service the single writer, F-A1.)
 *   2. `src/server/**` must not import `src/cli/**` — the dependency direction
 *      is `cli|server -> core -> shared`, never sideways.
 *   3. `src/cli/**` and `src/mcp/**` must not import **each other**. The taskd
 *      transport seam they share (`client/http.mjs`, `runtime.mjs`, `token.mjs`,
 *      `actor.mjs`, `errors.mjs` and `client/autostart.mjs`) lives in
 *      `src/shared/transport/**`, so both reach it without a sideways edge.
 *
 * Every direction is asserted against the *source text*, so a violation is
 * caught even in a file nothing imports yet.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { importedSpecifiers, listModuleFiles, readSource } from "../helpers/source-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every module `src/cli` promises to ship. The transport seam
 * (`client/index|http|autostart`, `runtime`, `token`, `actor`, `errors`) is no
 * longer listed: it moved to `src/shared/transport/**` (see
 * `test/shared/transport-imports.test.mjs`). A missing module must fail, not
 * scan empty.
 */
const PLANNED_CLI = [
  "index.mjs",
  "usage.mjs",
  "argv.mjs",
  "wire.mjs",
  "output/index.mjs",
  "output/json.mjs",
  "output/human.mjs",
  "commands/index.mjs",
  "commands/project.mjs",
  "commands/context.mjs",
  "commands/issue.mjs",
  "commands/report.mjs",
  "commands/comment.mjs",
  "commands/relation.mjs",
  "commands/session.mjs",
  "commands/dict.mjs",
  "commands/labels.mjs",
  "commands/export.mjs",
  "commands/token.mjs",
];

const PLANNED_SERVER = [
  "index.mjs",
  "main.mjs",
  "router.mjs",
  "auth.mjs",
  "cidr.mjs",
  "sse.mjs",
  "static.mjs",
  "routes/projects.mjs",
  "routes/tasks.mjs",
  "routes/activities.mjs",
  "routes/attachments.mjs",
  "routes/comments.mjs",
  "routes/relations.mjs",
  "routes/sessions.mjs",
  "routes/dictionary.mjs",
  "routes/labels.mjs",
  "routes/export.mjs",
  "routes/token.mjs",
];

function filesUnder(rel) {
  return listModuleFiles(join(ROOT, rel));
}

describe("cli/imports — the layering rules", () => {
  it("ships every planned CLI module (an empty scan must not pass)", () => {
    const missing = PLANNED_CLI.filter((rel) => !existsSync(join(ROOT, "src/cli", rel)));
    assert.deepEqual(missing, [], `missing CLI modules: ${missing.join(", ")}`);
  });

  it("ships every planned server module", () => {
    const missing = PLANNED_SERVER.filter((rel) => !existsSync(join(ROOT, "src/server", rel)));
    assert.deepEqual(missing, [], `missing server modules: ${missing.join(", ")}`);
  });

  it("src/cli never touches core/storage or node:sqlite", () => {
    const files = filesUnder("src/cli");
    assert.ok(files.length >= PLANNED_CLI.length, `expected ≥ ${PLANNED_CLI.length} CLI modules, found ${files.length}`);

    const violations = [];
    for (const file of files) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        const rel = file.slice(ROOT.length + 1);
        if (/^node:sqlite$/.test(specifier) || /core\/storage/.test(specifier)) {
          violations.push(`${rel} imports ${specifier}`);
        }
        if (/^node:/.test(specifier) && !/^node:(util|path|url|os|fs|child_process|process|crypto|stream|net|http|https|timers)$/.test(specifier)) {
          violations.push(`${rel} imports the unexpected builtin ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("src/server never imports src/cli", () => {
    const violations = [];
    for (const file of filesUnder("src/server")) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (/(^|\/)cli\//.test(specifier)) violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it("src/cli does not import src/server statically — the server is spawned", () => {
    const violations = [];
    for (const file of filesUnder("src/cli")) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (/(^|\/)server\//.test(specifier)) violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it("src/cli does not import src/mcp — the two surfaces share only src/shared", () => {
    const violations = [];
    for (const file of filesUnder("src/cli")) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (/(^|\/)mcp\//.test(specifier)) violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  it("the autostart module spawns the daemon entry, and only that", () => {
    const source = readSource(join(ROOT, "src/shared/transport/autostart.mjs"));
    // `src/server/index.mjs` is the *library* (`createTaskd`); the program is
    // `main.mjs`. The CLI must spawn the program — spawning the library would
    // import and exit.
    assert.match(source, /"src",\s*"server",\s*"main\.mjs"/);
    assert.match(source, /detached:\s*true/);
    assert.equal(/(^|\/)server\/index\.mjs/.test(source), false, "the CLI must not spawn the library entry");
  });
});
