#!/usr/bin/env node
/**
 * The installer's acceptance-policy step.
 *
 * The board's **acceptance policy** (`human-only` | `both` | `agent-only`) is
 * server configuration, so it lives beside the token in `<dataDir>/taskd.env` —
 * the same file the Access panel writes. This helper is the one write path
 * `install.sh` uses, and it goes straight to `src/core/acceptance-policy.mjs`
 * (not through `src/server`) so the installer pulls in no database module.
 *
 *     node scripts/install/lib/acceptance.mjs write --policy both
 *     node scripts/install/lib/acceptance.mjs write --policy human-only --data-dir /path/.data
 *     node scripts/install/lib/acceptance.mjs resolve
 *
 * `resolve` prints the data directory the board would use (explicit
 * `--data-dir`, else `TASKD_DATA_DIR`, else `<repo>/.data`) and writes nothing;
 * it is what a `--dry-run` prints.
 *
 * Exit codes: 0 success, 2 usage error, 1 the board refused the write.
 */

import { resolveDataDir } from "../../../src/shared/runtime-locator.mjs";
import { readAcceptancePolicy, writeAcceptancePolicy } from "../../../src/core/acceptance-policy.mjs";
import { ACCEPTANCE_POLICIES } from "../../../src/shared/constants.mjs";

const USAGE = `Usage: node scripts/install/lib/acceptance.mjs <write|resolve> [options]

  write    --policy <${ACCEPTANCE_POLICIES.join("|")}> [--data-dir <path>]
           Merge TASKD_ACCEPTANCE_POLICY into <dataDir>/taskd.env.
  resolve  [--data-dir <path>]
           Print the data directory and the policy currently in force.
`;

/** @param {string[]} argv */
function parse(argv) {
  const out = { command: null, policy: null, dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "--policy") out.policy = argv[++i] ?? null;
    else if (arg.startsWith("--policy=")) out.policy = arg.slice(9);
    else if (arg === "--data-dir") out.dataDir = argv[++i] ?? null;
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice(11);
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
  const dataDir = args.dataDir === null ? resolveDataDir() : resolveDataDir({ dataDir: args.dataDir });

  if (args.command === "resolve") {
    const { policy, source } = readAcceptancePolicy({ dataDir, env: {} });
    process.stdout.write(`${dataDir}\n${policy} (${source})\n`);
    process.exit(0);
  }
  if (args.command !== "write") throw new Error(`expected 'write' or 'resolve' (got ${JSON.stringify(args.command)})`);
  if (args.policy === null) throw new Error("--policy is required");

  const result = writeAcceptancePolicy({ dataDir, policy: args.policy });
  process.stdout.write(`acceptance policy: ${result.policy} -> ${result.file}\n`);
} catch (err) {
  process.stderr.write(`acceptance: ${err?.message ?? String(err)}\n`);
  process.exit(err?.code === "VALIDATION_FAILED" ? 2 : 1);
}
