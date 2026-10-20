#!/usr/bin/env node
/**
 * The installer's acceptance-policy step.
 *
 * The board's **acceptance policy** (`human-only` | `both` | `agent-only`) is
 * server configuration, so it lives in the install-root `.env` — the same file
 * the Access panel writes and `taskd` reads. This helper is the one write path
 * `install.sh` uses, and it goes straight to `src/core/acceptance-policy.mjs`
 * (not through `src/server`) so the installer pulls in no database module.
 *
 *     node scripts/install/lib/acceptance.mjs write --policy both
 *     node scripts/install/lib/acceptance.mjs write --policy human-only --env-file /path/.env
 *     node scripts/install/lib/acceptance.mjs resolve
 *
 * `resolve` prints the config file the board would use (explicit `--env-file`,
 * else `MEERKAT_TASKPANEL_ENV_FILE`, else `<repo>/.env`) and the policy in force;
 * it writes nothing. It is what a `--dry-run` prints.
 *
 * Exit codes: 0 success, 2 usage error, 1 the board refused the write.
 */

import { loadEnvFile } from "../../../src/foundation/env-config.mjs";
import { repoRoot } from "../../../src/foundation/runtime-locator.mjs";
import { readAcceptancePolicy, writeAcceptancePolicy } from "../../../src/core/acceptance-policy.mjs";
import { ACCEPTANCE_POLICIES } from "../../../src/foundation/constants.mjs";

const USAGE = `Usage: node scripts/install/lib/acceptance.mjs <write|resolve> [options]

  write    --policy <${ACCEPTANCE_POLICIES.join("|")}> [--env-file <path>]
           Merge TASKD_ACCEPTANCE_POLICY into the install-root .env.
  resolve  [--env-file <path>]
           Print the config file and the policy currently in force.
`;

/** @param {string[]} argv */
function parse(argv) {
  const out = { command: null, policy: null, envFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--policy") out.policy = argv[++i] ?? null;
    else if (arg.startsWith("--policy=")) out.policy = arg.slice(9);
    else if (arg === "--env-file") out.envFile = argv[++i] ?? null;
    else if (arg.startsWith("--env-file=")) out.envFile = arg.slice(11);
    else if (out.command === null) out.command = arg;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

try {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const config = loadEnvFile({
    root: repoRoot(),
    ...(args.envFile === null ? {} : { flag: args.envFile }),
  });

  if (args.command === "resolve") {
    const { policy, source } = readAcceptancePolicy({
      env: {},
      envFile: config.present ? config.file : null,
      envVars: config.vars,
    });
    process.stdout.write(`${config.present ? config.file : "(no config file yet)"}\n${policy} (${source})\n`);
    process.exit(0);
  }
  if (args.command !== "write") throw new Error(`expected 'write' or 'resolve' (got ${JSON.stringify(args.command)})`);
  if (args.policy === null) throw new Error("--policy is required");

  const result = writeAcceptancePolicy({ envFile: config.file, policy: args.policy });
  process.stdout.write(`acceptance policy: ${result.policy} -> ${result.file}\n`);
} catch (err) {
  process.stderr.write(`acceptance: ${err?.message ?? String(err)}\n`);
  process.exit(err?.code === "VALIDATION_FAILED" ? 2 : 1);
}
