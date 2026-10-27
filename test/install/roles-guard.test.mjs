/**
 * The team's roles root belongs to the setup skill, never to the installer.
 *
 * `install.sh` ships no roles template and must never create, write, move or
 * delete a roles root. The one writer is
 * `skills/setup-meerkat/scripts/install-roles.mjs`, run by `/setup-meerkat`
 * after the operator confirms; re-running that skill is the only upgrade path.
 * A forced skill reinstall carries an existing `roles/` across untouched — that
 * move is preservation, not an install, and it is the only place the installer
 * may name the directory at all.
 *
 * This file pins the rule two ways: a source scan over the installer's
 * executable code, and a behavioural check that a fresh install leaves no roles
 * root behind. The `--force` preservation itself is covered by
 * `kind-bundle.test.mjs` §agent bundle: --force preserves operator data.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { createInstallHarness } from "./helpers/install-harness.mjs";
import { stripComments } from "../helpers/source-scan.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({
  prefix: "meerkat-taskpanel-roles-guard-",
});

after(cleanup);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL = join(ROOT, "install.sh");
const INSTALL_DIR = join(ROOT, "scripts", "install");
const TEMPLATES = join(INSTALL_DIR, "templates");
const SETUP_SCRIPTS = join(ROOT, "skills", "setup-meerkat", "scripts");
const INSTALL_ROLES = join(SETUP_SCRIPTS, "install-roles.mjs");

/** Installer files that *run*; `templates/` is data and is checked separately. */
function executableSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (abs !== TEMPLATES) walk(abs);
      } else if (entry.endsWith(".sh") || entry.endsWith(".mjs")) {
        out.push(abs);
      }
    }
  };
  walk(INSTALL_DIR);
  return [INSTALL, ...out];
}

/** A shell comment line carries no behaviour. */
function stripShellComments(text) {
  return text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");
}

function codeOf(file) {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".sh") ? stripShellComments(text) : stripComments(text);
}

/** File-system writes. `for entry in roles projects.json; do` has none of these. */
const WRITE_VERB =
  /\b(mkdir|mkdirSync|mkdirp|cp|cpSync|copyFileSync|mv|renameSync|rm|rmSync|rsync|touch|emit_file|emit_from|writeFileSync|appendFileSync|writeAtomic|createWriteStream)\b/;

describe("roles root guard: install.sh never owns a team", () => {
  it("scans a non-trivial set of installer sources", () => {
    const files = executableSources().map((file) => relative(ROOT, file));
    assert.ok(files.length >= 12, `expected at least 12 installer sources, got ${files.length}`);
    for (const required of [
      "install.sh",
      "scripts/install/_common.sh",
      "scripts/install/claude.sh",
      "scripts/install/lib/apply.mjs",
      "scripts/install/cli.mjs",
    ]) {
      assert.ok(files.includes(required), `${required} must be scanned`);
    }
  });

  it("has no write operation against a roles path", () => {
    const offenders = [];
    for (const file of executableSources()) {
      codeOf(file).split("\n").forEach((line, index) => {
        if (WRITE_VERB.test(line) && /\broles\b/.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, [], "the installer must not write a roles root");
  });

  it("never names the roles manifest", () => {
    const offenders = [];
    for (const file of executableSources()) {
      codeOf(file).split("\n").forEach((line, index) => {
        if (line.includes("manifest.json")) {
          offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      "a roles root is defined by manifest.json; the installer must not create one",
    );
  });

  it("keeps a roles template out of the installer's data", () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else files.push(relative(TEMPLATES, abs));
      }
    };
    walk(TEMPLATES);
    assert.ok(files.length >= 20, `expected the installer's templates, got ${files.length}`);
    const rolesPaths = files.filter((rel) => rel.split(sep).includes("roles"));
    assert.deepEqual(rolesPaths, [], "no template may carry a roles root");
  });

  it("keeps a roles directory out of the setup skill's shipped tree", () => {
    const dirs = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) {
          dirs.push(relative(ROOT, abs));
          walk(abs);
        }
      }
    };
    walk(join(ROOT, "skills", "setup-meerkat"));
    assert.deepEqual(
      dirs.filter((rel) => rel.split(sep).at(-1) === "roles"),
      [],
      "roles live at the install root, never inside the skill",
    );
  });

  it("is the setup skill's installer that writes the roles manifest", () => {
    assert.ok(existsSync(INSTALL_ROLES), "install-roles.mjs must exist");
    assert.match(
      readFileSync(INSTALL_ROLES, "utf8"),
      /manifest\.json/,
      "the role installer writes the manifest as its commit point",
    );
  });

  it("documents the rule where an operator reads it", () => {
    const usage = readFileSync(INSTALL, "utf8");
    assert.match(usage, /installed and upgraded only by `\/setup-meerkat`/);
    assert.match(usage, /never\s+creates, writes or deletes a roles root/);
  });

  it("leaves no roles root behind after a fresh install", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "claude"], { MEERKAT_TASKPANEL_TARGET_HOME: home });
    assert.equal(run.status, 0, run.stderr);

    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) {
          if (entry === "roles") found.push(relative(home, abs));
          walk(abs);
        }
      }
    };
    walk(home);
    assert.deepEqual(found, [], "a fresh install creates no roles root");
    assert.equal(existsSync(join(home, ".meerkat", "roles")), false);
  });
});
