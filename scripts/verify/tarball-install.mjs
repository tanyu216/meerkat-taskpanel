#!/usr/bin/env node
/**
 * Install the packed tarball into a throwaway prefix and run it.
 *
 * `npm pack` proves what a tarball *contains*; this proves it *installs and boots*
 * — the layer npm users actually meet. The install is offline by construction: a
 * dead registry is pinned in the environment, so anything the tarball forgot to
 * carry fails here instead of being quietly fetched from the network.
 *
 *   node scripts/verify/tarball-install.mjs                       # pack, install, boot
 *   node scripts/verify/tarball-install.mjs --tarball dist/x.tgz  # reuse another build's tarball
 *   node scripts/verify/tarball-install.mjs --expected-version 0.1.2
 *
 * Interactive on the host is fine only if `npm pack` and `npm install` can run
 * (they use the host's npm); the authoritative run is the container suite.
 *
 * Exit: 0 ok · 1 a check failed · 2 usage or an unreadable input.
 *
 * Node builtins only; no dependencies, no network.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";
import { scrubEnv } from "./lib/scrub-env.mjs";
import { smokeInstalledBoard } from "./lib/installed-board.mjs";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PACK_MANIFEST = join(ROOT, "scripts", "release", "pack-manifest.mjs");

/**
 * Run the whole check.
 *
 * @param {{tarball?: string, expectedVersion?: string, keep?: boolean, log?: (line: string) => void}} options
 * @returns {Promise<{version: string, tarball: string, prefix: string}>}
 */
export async function verifyTarballInstall({ tarball, expectedVersion, keep = false, log = () => {} }) {
  const check = (condition, label) => {
    if (!condition) throw new Error(label);
    log(`OK ${label}`);
  };

  let file = tarball === undefined ? null : resolve(tarball);
  if (file === null) {
    const packed = spawnSync("npm", ["pack", "--silent", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: scrubEnv(),
    });
    check(packed.status === 0, `npm pack exits 0 (${(packed.stderr ?? "").trim()})`);
    const name = (packed.stdout ?? "").trim().split("\n").pop();
    check(typeof name === "string" && name.endsWith(".tgz"), `npm pack names a tarball (got '${name}')`);
    file = join(ROOT, name);
  }

  const manifestArgs = [PACK_MANIFEST, file];
  if (expectedVersion !== undefined) manifestArgs.push("--expected-version", expectedVersion);
  const manifest = spawnSync(process.execPath, manifestArgs, { cwd: ROOT, encoding: "utf8", env: scrubEnv() });
  check(manifest.status === 0, `the tarball's manifest check passes (${(manifest.stderr ?? "").trim()})`);

  const prefix = mkdtempSync(join(tmpdir(), "meerkat-tarball-install-"));
  writeFileSync(
    join(prefix, "package.json"),
    `${JSON.stringify({ name: "meerkat-tarball-smoke", private: true, version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );

  // Offline twice over: `--offline` forbids the cache-fetch path, and the registry
  // points at a closed port, so a tarball that depends on anything remote fails
  // here rather than succeeding on the runner's network.
  const installEnv = {
    ...scrubEnv(),
    npm_config_registry: "http://127.0.0.1:9",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const installArgs = ["install", "--prefix", prefix, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", file];
  let install = spawnSync("npm", [...installArgs, "--offline"], { cwd: prefix, encoding: "utf8", env: installEnv });
  if (install.status !== 0) {
    log(`the offline install failed; retrying without --offline against a dead registry`);
    install = spawnSync("npm", installArgs, { cwd: prefix, encoding: "utf8", env: installEnv });
  }
  check(install.status === 0, `npm install from the tarball exits 0 (${(install.stderr ?? "").trim().slice(0, 800)})`);

  const packageRoot = join(prefix, "node_modules", "meerkat-taskpanel");
  const installed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (expectedVersion !== undefined) {
    check(installed.version === expectedVersion, `the installed package is ${expectedVersion} (got '${installed.version}')`);
  }

  const smoke = await smokeInstalledBoard({ packageRoot, expectedVersion, log });
  check(smoke.version === installed.version, "the installed CLI and the installed manifest agree");

  if (!keep) rmSync(prefix, { recursive: true, force: true });
  return { version: installed.version, tarball: file, prefix };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tarball: { type: "string" },
      "expected-version": { type: "string" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/tarball-install.mjs [--tarball <file.tgz>] [--expected-version <x.y.z>] [--keep]\n\n" +
        "Packs (or reuses) the release tarball, installs it into a throwaway prefix with no\n" +
        "network, then boots the installed board and checks /health and the static shell.\n",
    );
    return 0;
  }

  try {
    const result = await verifyTarballInstall({
      tarball: values.tarball,
      expectedVersion: values["expected-version"],
      keep: values.keep,
      log: (line) => process.stdout.write(`  ${line}\n`),
    });
    process.stdout.write(`tarball-install: OK — ${result.version} from ${result.tarball}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`tarball-install: FAIL — ${error.message}\n`);
    return 1;
  }
}

// Guarded so the module can be imported by the test suite without installing anything.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
