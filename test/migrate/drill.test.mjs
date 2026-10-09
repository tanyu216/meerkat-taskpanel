/**
 * M5: the in-container drill wrapper.
 *
 * Two layers, mirroring `test/docker.test.mjs`:
 *   1. the pure argument builders in `scripts/migrate/drill.mjs` (no Docker);
 *   2. static assertions on the in-container script and its npm alias.
 *
 * It never spawns Docker — the drill itself is exercised by the container run,
 * not by the unit suite.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { dockerRunArgs, parseArgs, shellLine } from "../../scripts/migrate/drill.mjs";
import { imageTag } from "../../scripts/verify/lib/docker-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("drill: parseArgs", () => {
  it("defaults to building the image only when it is missing", () => {
    assert.deepEqual(parseArgs([]), { build: true, rebuild: false, printOnly: false });
  });

  it("reads the path and flag options", () => {
    const options = parseArgs([
      "--cards",
      "/cards",
      "--projects",
      "/projects.json",
      "--out",
      "/out",
      "--image",
      "example:tag",
      "--rebuild",
      "--print-only",
    ]);
    assert.equal(options.cards, "/cards");
    assert.equal(options.projects, "/projects.json");
    assert.equal(options.out, "/out");
    assert.equal(options.image, "example:tag");
    assert.equal(options.rebuild, true);
    assert.equal(options.printOnly, true);
  });

  it("lets --no-build turn building off", () => {
    assert.equal(parseArgs(["--no-build"]).build, false);
  });

  it("rejects an unknown option and a value-less flag", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown option/);
    assert.throws(() => parseArgs(["--cards", "--out"]), /needs a value/);
  });

  it("treats -h/--help as a help request", () => {
    assert.equal(parseArgs(["-h"]).help, true);
    assert.equal(parseArgs(["--help"]).help, true);
  });
});

describe("drill: dockerRunArgs", () => {
  const plan = {
    cards: "/home/team/tasks",
    projects: "/home/team/projects.json",
    out: "/repo/.data/migrate-out",
    image: imageTag(),
  };

  it("mounts cards and registry read-only and the report dir writable", () => {
    const args = dockerRunArgs(plan);
    assert.equal(args[0], "run");
    assert.ok(args.includes("--rm"));
    assert.ok(args.includes("/home/team/tasks:/cards:ro"), "cards must be read-only");
    assert.ok(args.includes("/home/team/projects.json:/projects.json:ro"), "registry must be read-only");
    assert.ok(args.includes("/repo/.data/migrate-out:/out"), "out dir must be writable");
    assert.equal(args.includes("/repo/.data/migrate-out:/out:ro"), false, "out dir must NOT be read-only");
  });

  it("passes the mount points through the environment and runs the in-container script", () => {
    const args = dockerRunArgs(plan);
    for (const env of ["CARDS_DIR=/cards", "PROJECTS_FILE=/projects.json", "OUT_DIR=/out"]) {
      assert.ok(args.includes(env), `expected ${env}`);
    }
    assert.equal(args.at(-3), imageTag(), "the image must precede the command");
    assert.deepEqual(args.slice(-2), ["bash", "docker/migrate-in-container.sh"]);
  });

  it("returns a fresh array each call", () => {
    assert.notEqual(dockerRunArgs(plan), dockerRunArgs(plan));
  });
});

describe("drill: shellLine", () => {
  it("quotes only the arguments that need it", () => {
    const line = shellLine(["run", "--rm", "-v", "/a b:/cards:ro", "meerkat-taskpanel:verify"]);
    assert.equal(line, `docker run --rm -v "/a b:/cards:ro" meerkat-taskpanel:verify`);
  });

  it("escapes a double quote inside an argument", () => {
    assert.equal(shellLine(["echo", 'a"b']), `docker echo "a\\"b"`);
  });
});

describe("static: docker/migrate-in-container.sh", () => {
  it("exists, is valid bash, and reads its mount points from the environment", () => {
    const path = join(ROOT, "docker", "migrate-in-container.sh");
    assert.ok(existsSync(path), "docker/migrate-in-container.sh must exist");

    const syntax = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`);

    const text = read("docker/migrate-in-container.sh");
    assert.match(text, /CARDS_DIR=/);
    assert.match(text, /PROJECTS_FILE=/);
    assert.match(text, /OUT_DIR=/);
    assert.match(text, /scripts\/migrate\/reconcile\.mjs/);
    // It must not abort on reconcile's "differences" exit code (3).
    assert.doesNotMatch(text, /set -euo? pipefail/);
    assert.match(text, /exit "\$code"/);
  });
});

describe("static: the drill is declared in package.json", () => {
  it("exposes verify:migrate:container", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.scripts["verify:migrate:container"], "node scripts/migrate/drill.mjs");
  });
});
