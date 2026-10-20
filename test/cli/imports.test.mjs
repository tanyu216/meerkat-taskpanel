/**
 * The layering rules, machine-enforced (V12).
 *
 * Two structural promises are only worth anything if they are checked rather
 * than documented:
 *
 *   1. `src/cli/**` is an **HTTP client** — it must not reach into
 *      `src/core/storage/**` and it must never open SQLite itself. Anything it
 *      needs from the board it asks for over HTTP. (This is what makes the
 *      service the single writer, F-A1.)
 *   2. `src/server/**` must not import `src/cli/**` — the dependency direction
 *      is `cli|server -> core -> shared`, never sideways.
 *   3. the one `src/core` module `src/cli` *does* read — the command-input
 *      declaration, whose two projections the CLI builds its flags and body
 *      from — is a storage-free leaf, checked transitively rather than by
 *      specifier (the barrel would satisfy a specifier check and still drag
 *      `node:sqlite` in).
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
  "output/index.mjs",
  "output/json.mjs",
  "output/human.mjs",
  "commands/index.mjs",
  "commands/project.mjs",
  "commands/issue.mjs",
  "commands/task-input.mjs",
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

/**
 * Walk every module reachable from `entry` by static import, recording anything
 * `src/cli` must never reach. Relative specifiers are followed; a bare one is a
 * builtin or a package, and the builtin allow-list is the other test's business.
 */
function walkInto(entry, violations, seen = new Set()) {
  const file = existsSync(entry) ? entry : `${entry}.mjs`;
  if (seen.has(file) || !existsSync(file)) return;
  seen.add(file);
  for (const specifier of importedSpecifiers(readSource(file))) {
    if (/^node:sqlite$/.test(specifier) || /core\/storage/.test(specifier)) {
      violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
    }
    if (specifier.startsWith(".")) walkInto(resolve(dirname(file), specifier), violations, seen);
  }
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

  it("any src/core module src/cli reads is a storage-free leaf, transitively", () => {
    // `src/cli` reads exactly one `src/core` module — the command-input
    // declaration — and only because that module imports nothing beyond
    // `shared/` and `domain/`. The specifier rule above cannot see the danger it
    // guards against: importing the core *barrel* would pass it while dragging
    // `node:sqlite` into a process whose whole point is that it talks to the
    // board over HTTP. So the property is asserted over the whole reach, not the
    // one specifier.
    const violations = [];
    for (const file of filesUnder("src/cli")) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        if (!/core\//.test(specifier)) continue;
        walkInto(resolve(dirname(file), specifier), violations);
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

/**
 * The orchestrator boundary: the loop is a *consumer* of the board's public
 * surface (`taskctl` / HTTP / the shared SDK), never a co-owner of its
 * implementation. `src/shared/` is the SDK both sides may import; the board's
 * core, CLI and server are not.
 */
describe("cli/imports — the loop consumes the toolkit, it does not implement it", () => {
  /** A relative specifier resolved against the importing file, as a repo-relative path. */
  function specifierTarget(file, specifier) {
    if (!specifier.startsWith(".")) return null;
    const resolved = resolve(dirname(file), specifier);
    return resolved.startsWith(`${ROOT}/`) ? resolved.slice(ROOT.length + 1) : resolved;
  }

  it("scripts/loop and the supervisor never import src/core, src/cli or src/server", () => {
    const files = [
      ...listModuleFiles(join(ROOT, "scripts/loop")),
      join(ROOT, "scripts/supervisor.mjs"),
      join(ROOT, "scripts/wake-cwd.mjs"),
    ].filter((file) => existsSync(file));
    assert.ok(files.length >= 5, `expected the loop module set, found ${files.length}`);

    const violations = [];
    for (const file of files) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        const target = specifierTarget(file, specifier);
        if (target === null) continue;
        if (/^src\/(core|cli|server)\//.test(target)) {
          violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("src/core, src/cli and src/server never import the loop's policy modules", () => {
    // `scheduling.mjs` (the loop's clocks/wake) and `sla-patrol.mjs` (the SLA
    // rules) are loop policy. They may live under `shared/` so the loop payload
    // can vendor them, but the board must not depend on them: that would make
    // the toolkit import its own orchestrator.
    const files = [
      ...filesUnder("src/core"),
      ...filesUnder("src/cli"),
      ...filesUnder("src/server"),
    ];
    const loopPolicy = new Set(["src/shared/scheduling.mjs", "src/shared/sla-patrol.mjs"]);

    const violations = [];
    for (const file of files) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        const target = specifierTarget(file, specifier);
        if (target !== null && loopPolicy.has(target)) {
          violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("src/shared imports nothing from src/core, src/cli or src/server", () => {
    // The SDK is the bottom of the tree. A shared module reaching upward would
    // make the loop (which vendors shared) carry a board dependency.
    const violations = [];
    for (const file of filesUnder("src/shared")) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        const target = specifierTarget(file, specifier);
        if (target !== null && /^src\/(core|cli|server)\//.test(target)) {
          violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("no shipped skill imports the board's implementation", () => {
    // An installed skill and the board's source tree are not co-located.
    // `skills/**` may only use Node builtins and relative links inside its own
    // tree — the loop body's vendored `src/shared/**` included. Reaching
    // `src/core|cli|server` would resolve in a checkout and fail on a host.
    const files = listModuleFiles(join(ROOT, "skills"));
    assert.ok(files.length >= 3, `expected the shipped skill modules, found ${files.length}`);

    const violations = [];
    for (const file of files) {
      for (const specifier of importedSpecifiers(readSource(file))) {
        const target = specifierTarget(file, specifier);
        if (target !== null && /^src\/(core|cli|server)\//.test(target)) {
          violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, []);

    for (const dir of ["core", "cli", "server"]) {
      assert.equal(
        existsSync(join(ROOT, "skills/meerkat-loop/body/src", dir)),
        false,
        `the loop payload must not vendor src/${dir}`,
      );
    }
  });
});
