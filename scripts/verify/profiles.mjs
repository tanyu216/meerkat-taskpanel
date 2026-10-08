#!/usr/bin/env node
/**
 * Verify that the skill installs and runs on every supported agent host.
 *
 * Installs into a throwaway home (never $HOME), one host at a time, and asserts the
 * skill landed where the host expects it, that its frontmatter still names the skill,
 * that the wrapper resolves back to this checkout and prints the right version, and —
 * per host — that the distribution bundle is recognized with a loadable skill.
 *
 *   node scripts/verify/profiles.mjs [--home <dir>] [--profiles <dir>] [--host <host>]
 *
 * `--host` (repeatable, or a comma-separated list) narrows the *run* to one or more
 * hosts; every profile is still loaded and validated. This is the per-host entry point
 * the container profiles (`docker/profiles/<host>.yml`) are exercised through.
 *
 * Exits 0 only when every selected host passes.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT, PROFILE_HOSTS, defaultHome, runProfiles } from "./lib/profiles.mjs";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    profiles: { type: "string" },
    host: { type: "string", multiple: true, short: "H" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(
    "Usage: node scripts/verify/profiles.mjs [--home <dir>] [--profiles <dir>] [--host <host>]\n\n" +
      `  --home <dir>      throwaway home to install into (default: ${defaultHome()})\n` +
      `  --profiles <dir>  profile directory (default: ${join(REPO_ROOT, "docker", "profiles")})\n` +
      `  --host <host>     only run these hosts (${PROFILE_HOSTS.join(", ")}); repeatable or comma-separated\n`,
  );
  process.exit(0);
}

// `--host claude --host codex` and `--host claude,codex` are both accepted.
const hosts = (values.host ?? [])
  .flatMap((value) => String(value).split(","))
  .map((value) => value.trim())
  .filter(Boolean);

const unknown = hosts.filter((host) => !PROFILE_HOSTS.includes(host));
if (unknown.length > 0) {
  process.stderr.write(
    `profiles: unknown host(s): ${unknown.join(", ")} (expected ${PROFILE_HOSTS.join(", ")})\n`,
  );
  process.exit(2);
}

const result = await runProfiles({
  home: values.home,
  profilesDir: values.profiles,
  hosts,
  quiet: values.quiet,
});

process.stdout.write(
  `\nprofiles: ${result.results.filter((r) => r.ok).length}/${result.results.length} hosts passed\n`,
);
process.stdout.write(`profiles: home = ${result.home}\n`);

process.exit(result.ok ? 0 : 1);
