/**
 * The per-kind config's layout and one-time migration.
 *
 * One file per actor kind at the program root (`<program root>/.env.<kind>`):
 * combined installs use `<prefix>/.meerkat-taskpanel`, agent-only installs the
 * checkout/package root. An install that predates the location is copied from
 * `<agent-dir>/meerkat-taskpanel.env` once; the legacy file is kept and ignored.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({
  prefix: "meerkat-taskpanel-kind-migration-",
});

after(cleanup);

/** An executable fake agent CLI that does nothing and exits 0. */
function makeFakeCli(binDir, name) {
  const dest = join(binDir, name);
  writeFileSync(dest, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(dest, 0o755);
}

/**
 * The installer env. `MEERKAT_TASKPANEL_CONFIG_DIR: ""` suppresses the harness's
 * per-home override so a case can exercise the real program-root default.
 */
function envFor(bin, extra = {}) {
  return {
    PATH: `${bin}:${process.env.PATH}`,
    MEERKAT_TASKPANEL_CONFIG_DIR: "",
    ...extra,
  };
}

describe("per-kind config — placement", () => {
  it("writes <program root>/.env.<kind> for an agent-only install", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    makeFakeCli(bin, "claude");

    const run = runInstall(
      ["--target", "claude", "--prefix", home],
      envFor(bin, { MEERKAT_TASKPANEL_REPO: programRoot }),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(programRoot, ".env.claude")), "the program-root file must exist");
    assert.equal(existsSync(join(home, ".claude", "meerkat-taskpanel.env")), false);
  });

  it("writes <tree>/.env.<kind> for a combined install", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");

    const run = runInstall(
      ["--target", "server,claude", "--prefix", home, "--skip-web-build"],
      envFor(bin),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(home, ".meerkat-taskpanel", ".env.claude")));
    assert.equal(existsSync(join(home, ".claude", "meerkat-taskpanel.env")), false);
  });

  it("--target all writes one file per loop kind and none for openclaw", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    for (const name of ["claude", "codex", "pi", "openclaw"]) makeFakeCli(bin, name);

    const run = runInstall(["--target", "all", "--prefix", home, "--skip-web-build"], envFor(bin));
    assert.equal(run.status, 0, run.stderr);
    const tree = join(home, ".meerkat-taskpanel");
    for (const kind of ["claude", "codex", "pi"]) {
      assert.ok(existsSync(join(tree, `.env.${kind}`)), `${kind} config missing`);
    }
    assert.equal(existsSync(join(tree, ".env.openclaw")), false);
  });

  it("--target codex writes only .env.codex", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    makeFakeCli(bin, "codex");

    const run = runInstall(
      ["--target", "codex", "--prefix", home],
      envFor(bin, { MEERKAT_TASKPANEL_REPO: programRoot }),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(programRoot, ".env.codex")));
    assert.equal(existsSync(join(programRoot, ".env.claude")), false);
  });
});

describe("per-kind config — migration", () => {
  function legacyFile(home, text) {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "meerkat-taskpanel.env");
    writeFileSync(file, text, "utf8");
    return file;
  }

  it("copies a legacy file once, keeps its values, and leaves it untouched", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    makeFakeCli(bin, "claude");
    const legacy = legacyFile(
      home,
      "MEERKAT_TASKPANEL_REVIEWER=old-reviewer\nMEERKAT_TASKPANEL_CUSTOM=kept\n",
    );
    const legacyBytes = readFileSync(legacy, "utf8");

    const run = runInstall(
      ["--target", "claude", "--prefix", home],
      envFor(bin, { MEERKAT_TASKPANEL_REPO: programRoot }),
    );
    assert.equal(run.status, 0, run.stderr);
    const text = readFileSync(join(programRoot, ".env.claude"), "utf8");
    assert.match(text, /^MEERKAT_TASKPANEL_REVIEWER=old-reviewer$/m, "the old choice survives");
    assert.match(text, /^MEERKAT_TASKPANEL_CUSTOM=kept$/m, "unknown keys survive the copy");
    assert.match(text, /^MEERKAT_TASKPANEL_RECOVER_STALE=yes$/m, "the install adds what it owns");
    assert.equal(readFileSync(legacy, "utf8"), legacyBytes, "the legacy file is not edited");
    assert.match(run.stdout, /migrated the per-kind config/);
  });

  it("a new file always wins; the legacy file is never merged or removed", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    makeFakeCli(bin, "claude");
    const legacy = legacyFile(home, "MEERKAT_TASKPANEL_REVIEWER=old\n");
    const legacyBytes = readFileSync(legacy, "utf8");
    mkdirSync(programRoot, { recursive: true });
    writeFileSync(join(programRoot, ".env.claude"), "MEERKAT_TASKPANEL_REVIEWER=new\n", "utf8");

    const run = runInstall(
      ["--target", "claude", "--prefix", home],
      envFor(bin, { MEERKAT_TASKPANEL_REPO: programRoot }),
    );
    assert.equal(run.status, 0, run.stderr);
    const text = readFileSync(join(programRoot, ".env.claude"), "utf8");
    assert.match(text, /^MEERKAT_TASKPANEL_REVIEWER=new$/m, "the new file is authoritative");
    assert.doesNotMatch(text, /old$/m);
    assert.equal(readFileSync(legacy, "utf8"), legacyBytes);
  });

  it("is idempotent: a second install leaves the file byte-identical", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = envFor(bin, { MEERKAT_TASKPANEL_REPO: programRoot });

    assert.equal(runInstall(["--target", "claude", "--prefix", home], env).status, 0);
    const file = join(programRoot, ".env.claude");
    const first = readFileSync(file, "utf8");
    assert.equal(runInstall(["--target", "claude", "--prefix", home], env).status, 0);
    assert.equal(readFileSync(file, "utf8"), first);
    assert.equal(first.match(/^MEERKAT_TASKPANEL_REPO=/gm).length, 1);
  });

  it("--dry-run announces the migration and writes nothing", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    makeFakeCli(bin, "claude");
    legacyFile(home, "MEERKAT_TASKPANEL_REVIEWER=old\n");

    const run = runInstall(
      ["--target", "claude", "--prefix", home, "--dry-run"],
      envFor(bin, { MEERKAT_TASKPANEL_REPO: programRoot }),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /would migrate the per-kind config/);
    assert.equal(existsSync(join(programRoot, ".env.claude")), false);
  });

  it("--force re-renders the template and keeps the keys it does not carry", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    makeFakeCli(bin, "claude");
    const legacy = legacyFile(home, "MEERKAT_TASKPANEL_CUSTOM=kept\n");

    const run = runInstall(
      ["--target", "claude", "--prefix", home, "--force"],
      envFor(bin, { MEERKAT_TASKPANEL_REPO: programRoot }),
    );
    assert.equal(run.status, 0, run.stderr);
    const text = readFileSync(join(programRoot, ".env.claude"), "utf8");
    // The template is re-rendered, but a key it does not carry belongs to the operator
    // (or to `setup-meerkat`), so --force re-appends it rather than dropping it.
    assert.match(text, /^MEERKAT_TASKPANEL_CUSTOM=kept$/m, "force keeps keys the template does not carry");
    assert.match(text, /^MEERKAT_TASKPANEL_REVIEWER=Reviewer$/m);
    assert.ok(existsSync(legacy), "the legacy file is still untouched");
  });

  it("honours MEERKAT_TASKPANEL_CONFIG_DIR and leaves the program root alone", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    const programRoot = makeTempDir();
    const override = makeTempDir();
    makeFakeCli(bin, "claude");

    const run = runInstall(
      ["--target", "claude", "--prefix", home],
      envFor(bin, {
        MEERKAT_TASKPANEL_REPO: programRoot,
        MEERKAT_TASKPANEL_CONFIG_DIR: override,
      }),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(override, ".env.claude")));
    assert.equal(existsSync(join(programRoot, ".env.claude")), false);
  });
});
