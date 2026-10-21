/**
 * Step 11: `project` (A1, V8).
 *
 * Real CLI process, real board. A project is created, listed, updated and its
 * readme round-tripped. Since O3 the board holds **no directory** for a project:
 * `--workspace-path` is gone, and there is no `context current` to resolve a
 * working directory. Which local directory maps to which project is decided on
 * the agent side (the skill's local `projects.json`).
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { cleanupTempDirs, dataOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

describe("cli/project", () => {
  it("creates a project with metadata and labels, and lists it", async () => {
    await withCli(async ({ run }) => {
      const created = dataOf(
        run([
          "project", "create",
          "--id", "demo",
          "--name", "Demo",
          "--meta", "team=panel",
          "--meta", "tier=1",
          "--label", "m2",
          "--json",
        ]),
      );
      assert.equal(created.project.id, "demo");
      assert.deepEqual(created.project.meta, { team: "panel", tier: "1" });
      assert.deepEqual(created.project.labels, ["m2"]);
      assert.equal(
        Object.hasOwn(created.project, "workspace_path"),
        false,
        "a project carries no directory",
      );

      const listed = dataOf(run(["project", "list", "--json"]));
      assert.deepEqual(listed.projects.map((p) => p.id), ["demo"]);
      assert.equal(Object.hasOwn(listed.projects[0], "workspace_path"), false);
    });
  });

  it("no longer accepts --workspace-path (O3: the board holds no directory)", async () => {
    await withCli(async ({ run }) => {
      const result = run([
        "project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", "/tmp/demo", "--json",
      ]);
      assert.equal(result.status, 2, "an unknown option is a usage error");
      assert.equal(result.stderr, "");
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.error.code, "CLI_USAGE");
      assert.match(envelope.error.message, /unknown option --workspace-path/);
    });
  });

  it("updates a project, and refuses an update that changes nothing", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
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
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);

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

describe("cli/project — the remaining flags", () => {
  it("create carries labels and a readme; update carries labels and readme", async () => {
    await withCli(async ({ run }) => {
      const created = dataOf(
        run([
          "project", "create", "--id", "demo", "--name", "Demo",
          "--label", "one", "--label", "two", "--readme", "# hi", "--json",
        ]),
      );
      assert.deepEqual(created.project.labels, ["one", "two"]);
      assert.equal(created.project.readme, "# hi");

      const updated = dataOf(
        run([
          "project", "update", "demo",
          "--label", "three",
          "--readme", "# bye",
          "--json",
        ]),
      );
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

  it("has no `context` group to resolve a working directory", async () => {
    await withCli(async ({ run }) => {
      const result = run(["context", "current", "--json"]);
      assert.equal(result.status, 2, "the group is gone, so this is a usage error");
      assert.equal(JSON.parse(result.stdout).error.code, "CLI_USAGE");
    });
  });
});

describe("cli/project — the identifier prefix (C-PREFIX-1)", () => {
  it("numbers off --id, and off --meta prefix=… when one is declared", async () => {
    await withCli(async ({ run }) => {
      // No prefix declared: the id is the prefix source, exactly as it was
      // before the slot existed (the contract's C3/C8 legs).
      run(["project", "create", "--id", "demo_x", "--name", "Demo X", "--json"]);
      const fallback = dataOf(run(["issue", "create", "--project", "demo_x", "--title", "one", "--json"]));
      assert.equal(fallback.task.identifier, "DEMO-X-0001");

      // A declared prefix wins over the id, and the server normalizes it. The
      // CLI says nothing about prefixes; `--meta prefix=…` is the same field the
      // UI posts, through the same `identifierPrefix`, so there is no second
      // rule to keep in step — the §8 E7 asymmetry stays one-sided in the docs
      // only.
      run(["project", "create", "--id", "other", "--name", "Other", "--meta", "prefix=Orch Team", "--json"]);
      const declared = dataOf(run(["issue", "create", "--project", "other", "--title", "one", "--json"]));
      assert.equal(declared.task.identifier, "ORCH-TEAM-0001");
    });
  });

  it("refuses a declared prefix another project already owns", async () => {
    await withCli(async ({ run }) => {
      run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const clash = run(["project", "create", "--id", "other", "--name", "Other", "--meta", "prefix=demo", "--json"]);
      assert.equal(clash.status, 1);
      const error = JSON.parse(clash.stdout).error;
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.equal(error.details.prefix, "DEMO");
      assert.equal(error.details.conflictProjectId, "demo");
    });
  });

  it("refuses a declared prefix that normalizes to nothing, and creates nothing", async () => {
    await withCli(async ({ run }) => {
      const refused = run(["project", "create", "--id", "zombie", "--name", "Zombie", "--meta", "prefix=####", "--json"]);
      assert.equal(refused.status, 1);
      assert.equal(JSON.parse(refused.stdout).error.code, "VALIDATION_FAILED");
      assert.equal(dataOf(run(["project", "list", "--json"])).projects.length, 0);
    });
  });
});

describe("cli/project — review policy and reviewer (0031)", () => {
  it("creates and updates the review policy and reviewer", async () => {
    await withCli(async ({ run }) => {
      const created = dataOf(
        run([
          "project", "create", "--id", "flow", "--name", "Flow",
          "--review-policy", "required", "--reviewer", "jobs", "--json",
        ]),
      );
      assert.equal(created.project.review_policy, "required");
      assert.equal(created.project.reviewer, "jobs");

      const updated = dataOf(
        run(["project", "update", "flow", "--review-policy", "off", "--reviewer", "", "--json"]),
      );
      assert.equal(updated.project.review_policy, "off");
      assert.equal(updated.project.reviewer, null);

      const invalid = run([
        "project", "create", "--id", "bad", "--name", "Bad",
        "--review-policy", "sometimes", "--json",
      ]);
      assert.equal(invalid.status, 1);
      assert.equal(JSON.parse(invalid.stdout).error.code, "VALIDATION_FAILED");
    });
  });
});
