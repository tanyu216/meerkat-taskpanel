#!/usr/bin/env node
/**
 * Verify that the skill installs and runs on every supported agent host.
 *
 * Installs into a throwaway home (never $HOME), one host at a time, and asserts the
 * skill landed where the host expects it, that its frontmatter still names the skill,
 * and that the wrapper resolves back to this checkout and prints the right version.
 *
 *   node scripts/verify/profiles.mjs [--home <dir>] [--profiles <dir>]
 *
 * Exits 0 only when every host passes.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT, defaultHome, runProfiles } from "./lib/profiles.mjs";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    profiles: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(
    "Usage: node scripts/verify/profiles.mjs [--home <dir>] [--profiles <dir>]\n\n" +
      `  --home <dir>      throwaway home to install into (default: ${defaultHome()})\n` +
      `  --profiles <dir>  profile directory (default: ${join(REPO_ROOT, "docker", "profiles")})\n`,
  );
  process.exit(0);
}

const result = await runProfiles({
  home: values.home,
  profilesDir: values.profiles,
  quiet: values.quiet,
});

process.stdout.write(`\nprofiles: ${result.results.filter((r) => r.ok).length}/${result.results.length} hosts passed\n`);
process.stdout.write(`profiles: home = ${result.home}\n`);

process.exit(result.ok ? 0 : 1);
