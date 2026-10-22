#!/usr/bin/env node
/**
 * Verify that the skill installs and runs on every supported agent kind.
 *
 * Installs into a throwaway home (never $HOME), one agent kind at a time, and asserts the
 * skill landed where the agent kind expects it, that its frontmatter still names the skill,
 * that the wrapper resolves back to this checkout and prints the right version, and —
 * per agent kind — that the distribution bundle is recognized with a loadable skill.
 *
 *   node scripts/verify/profiles.mjs [--home <dir>] [--profiles <dir>] [--actor-kind <kind>]
 *
 * `--actor-kind` (repeatable, or a comma-separated list) narrows the *run* to one or more
 * kinds; every profile is still loaded and validated. This is the per-agent-kind entry point
 * the container profiles (`docker/profiles/<actor-kind>.yml`) are exercised through.
 *
 * Exits 0 only when every selected agent kind passes.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT, PROFILE_KINDS, defaultHome, runProfiles } from "./lib/profiles.mjs";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    profiles: { type: "string" },
    "actor-kind": { type: "string", multiple: true, short: "H" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(
    "Usage: node scripts/verify/profiles.mjs [--home <dir>] [--profiles <dir>] [--actor-kind <kind>]\n\n" +
      `  --home <dir>      throwaway home to install into (default: ${defaultHome()})\n` +
      `  --profiles <dir>  profile directory (default: ${join(REPO_ROOT, "docker", "profiles")})\n` +
      `  --actor-kind <kind>  only run these agent kinds (${PROFILE_KINDS.join(", ")}); repeatable or comma-separated\n`,
  );
  process.exit(0);
}

// `--actor-kind claude --actor-kind codex` and `--actor-kind claude,codex` are both accepted.
const kinds = (values["actor-kind"] ?? [])
  .flatMap((value) => String(value).split(","))
  .map((value) => value.trim())
  .filter(Boolean);

const unknown = kinds.filter((kind) => !PROFILE_KINDS.includes(kind));
if (unknown.length > 0) {
  process.stderr.write(
    `profiles: unknown actor kind(s): ${unknown.join(", ")} (expected ${PROFILE_KINDS.join(", ")})\n`,
  );
  process.exit(2);
}

const result = await runProfiles({
  home: values.home,
  profilesDir: values.profiles,
  kinds,
  quiet: values.quiet,
});

process.stdout.write(
  `\nprofiles: ${result.results.filter((r) => r.ok).length}/${result.results.length} agent kinds passed\n`,
);
process.stdout.write(`profiles: home = ${result.home}\n`);

process.exit(result.ok ? 0 : 1);
