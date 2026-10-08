/**
 * Step 11: `project` and `context` (A1/A6, V8).
 *
 * Real CLI process, real board. The interesting half is `context current`, whose
 * miss must be a *read*: it returns a synthetic `local` project and creates
 * nothing.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

describe("cli/project", () => {
  it("creates a project with metadata and labels, and lists it", async () => {
    await withCli(async ({ run, dataDir }) => {
      const created = dataOf(
        run([
          "project", "create",
          "--id", "demo",
          "--name", "Demo",
          "--workspace-path", dataDir,
          "--meta", "team=panel",
          "--meta", "tier=1",
          "--label", "m2",
          "--json",
        ]),
      );
      assert.equal(created.project.id, "demo");
      assert.deepEqual(created.project.meta, { team: "panel", tier: "1" });
      assert.deepEqual(created.project.labels, ["m2"]);
      assert.equal(created.project.workspace_path, dataDir);

      const listed = dataOf(run(["project", "list", "--json"]));
      assert.deepEqual(listed.projects.map((p) => p.id), ["demo"]);
    });
  });

  it("refuses a relative workspace path (core validates, the CLI reports)", async () => {
    await withCli(async ({ run }) => {
      const result = run([
        "project", "create", "--id", "bad", "--name", "Bad", "--workspace-path", "relative/path", "--json",
      ]);
      assert.equal(result.status, 1);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.error.code, "VALIDATION_FAILED");
      assert.match(envelope.error.message, /absolute path/);
    });
  });

  it("updates a project, and refuses an update that changes nothing", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", dataDir, "--json"]);
      const updated = dataOf(run(["project", "update", "demo", "--name", "Renamed", "--meta", "k=v", "--json"]));
      assert.equal(updated.project.name, "Renamed");
      assert.deepEqual(updated.project.meta, { k: "v" });

      const nothing = run(["project", "update", "demo", "--json"]);
      assert.equal(nothing.status, 1);
      assert.equal(JSON.parse(nothing.stdout).error.code, "VALIDATION_FAILED");
    });
  });

  it("round-trips the readme through --set, --file and stdin", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", dataDir, "--json"]);

      const empty = dataOf(run(["project", "readme", "demo", "--json"]));
      assert.equal(empty.readme, null);

      assert.equal(dataOf(run(["project", "readme", "demo", "--set", "# Hello", "--json"])).readme, "# Hello");
      assert.equal(dataOf(run(["project", "readme", "demo", "--json"])).readme, "# Hello");

      const stdin = dataOf(run(["project", "readme", "demo", "--file", "-", "--json"], { input: "# From stdin\n" }));
      assert.equal(stdin.readme, "# From stdin\n");

      const file = `${dataDir}/readme.md`;
      const fs = await import("node:fs");
      fs.writeFileSync(file, "# From a file\n");
      assert.equal(dataOf(run(["project", "readme", "demo", "--file", file, "--json"])).readme, "# From a file\n");

      // Human output prints the readme itself, with no decoration.
      const human = run(["project", "readme", "demo"]);
      assert.equal(human.status, 0);
      assert.equal(human.stdout, "# From a file\n");
    });
  });
});

describe("cli/context", () => {
  it("matches the current directory, an ancestor, and falls back to `local` without creating", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", `${dataDir}/ws`, "--json"]);

      const exact = dataOf(run(["context", "current", "--path", `${dataDir}/ws`, "--json"]));
      assert.equal(exact.matched, true);
      assert.equal(exact.project.id, "demo");

      const ancestor = run(["context", "current", "--path", `${dataDir}/ws/deep/sub`, "--json"]);
      assert.equal(dataOf(ancestor).matched, true);

      const miss = run(["context", "current", "--path", "/somewhere/else", "--json"]);
      assert.equal(miss.status, 0, "a miss is not an error");
      const data = dataOf(miss);
      assert.equal(data.matched, false);
      assert.equal(data.project.id, "local");
      assert.equal(data.project.workspace_path, "/somewhere/else");
      assert.match(data.hint.create, /project create --id local/);

      // The miss must not have created anything.
      const listed = dataOf(run(["project", "list", "--json"]));
      assert.deepEqual(listed.projects.map((p) => p.id), ["demo"]);
    });
  });

  it("defaults to the working directory, and prints something readable", async () => {
    await withCli(async ({ run, dataDir }) => {
      const fs = await import("node:fs");
      fs.mkdirSync(`${dataDir}/ws`, { recursive: true });
      run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", `${dataDir}/ws`, "--json"]);
      const human = run(["context", "current"], { cwd: `${dataDir}/ws` });
      assert.match(human.stdout, /project\s+demo/);
      assert.match(human.stdout, /matched\s+true/);
    });
  });
});

describe("cli/project — the remaining flags", () => {
  it("create carries labels and a readme; update carries path, labels and readme", async () => {
    await withCli(async ({ run, dataDir }) => {
      const created = dataOf(
        run([
          "project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", dataDir,
          "--label", "one", "--label", "two", "--readme", "# hi", "--json",
        ]),
      );
      assert.deepEqual(created.project.labels, ["one", "two"]);
      assert.equal(created.project.readme, "# hi");

      const updated = dataOf(
        run([
          "project", "update", "demo",
          "--workspace-path", `${dataDir}/moved`,
          "--label", "three",
          "--readme", "# bye",
          "--json",
        ]),
      );
      assert.equal(updated.project.workspace_path, `${dataDir}/moved`);
      assert.deepEqual(updated.project.labels, ["three"]);
      assert.equal(updated.project.readme, "# bye");

      assert.equal(dataOf(run(["project", "update", "demo", "--meta", "k=v", "--json"])).project.meta.k, "v");
    });
  });

  it("prints 'no projects' rather than an empty table, and can include archived rows", async () => {
    await withCli(async ({ run }) => {
      assert.equal(run(["project", "list"]).stdout.trim(), "no projects");
      assert.equal(dataOf(run(["project", "list", "--include-archived", "--json"])).projects.length, 0);
      assert.match(run(["project", "list"]).stdout, /no projects/);
    });
  });
});
