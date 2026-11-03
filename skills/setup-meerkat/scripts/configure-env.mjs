#!/usr/bin/env node
/**
 * Merge one key into a `KEY=VALUE` file without rewriting the operator's file.
 *
 * `--file` is the target (the install-root `.env` or a per-kind config). A different
 * existing value is a conflict unless `--force`; the value is never echoed. Use
 * `--value-file` for a token so it does not appear in the process list. `--remove`
 * deletes every line for the key — the repair for a mislaid or duplicated key.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isEntryPoint } from "./lib/entry-guard.mjs";
import { writeAtomic } from "./lib/atomic.mjs";
import { mergeEnvKey, removeEnvKey } from "./lib/env-merge.mjs";

const USAGE = `configure-env — merge or remove one key in a KEY=VALUE file

  node configure-env.mjs --file <path> --key <KEY> (--value <V> | --value-file <path>)
                         [--dry-run] [--force] [--mode 0600] [--json]
  node configure-env.mjs --file <path> --key <KEY> --remove [--dry-run] [--json]

Exit: 0 wrote/unchanged/removed, 3 conflict (a different value without --force), 2 usage.`;

function parse(argv) {
  const opts = {
    file: null,
    key: null,
    value: null,
    valueFile: null,
    dryRun: false,
    force: false,
    remove: false,
    mode: 0o600,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--file": opts.file = take(); break;
      case "--key": opts.key = take(); break;
      case "--value": opts.value = take(); break;
      case "--value-file": opts.valueFile = take(); break;
      case "--mode": opts.mode = Number.parseInt(take(), 8); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      case "--remove": opts.remove = true; break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`configure-env: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!opts.file || !opts.key) {
    console.error(USAGE);
    return 2;
  }
  if (opts.remove && (opts.value !== null || opts.valueFile)) {
    console.error("configure-env: --remove does not take a value");
    return 2;
  }
  if (!opts.remove && opts.value === null && !opts.valueFile) {
    console.error(USAGE);
    return 2;
  }
  if (!Number.isInteger(opts.mode) || opts.mode < 0 || opts.mode > 0o777) {
    console.error("configure-env: --mode must be an octal file mode");
    return 2;
  }

  let value = opts.value;
  if (opts.valueFile) {
    try {
      value = readFileSync(opts.valueFile, "utf8").replace(/\r?\n$/, "");
    } catch (err) {
      console.error(`configure-env: cannot read --value-file: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  let current = "";
  if (existsSync(opts.file)) {
    try {
      current = readFileSync(opts.file, "utf8");
    } catch (err) {
      console.error(`configure-env: cannot read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  let merged;
  try {
    merged = opts.remove
      ? removeEnvKey(current, opts.key)
      : mergeEnvKey(current, opts.key, value, { force: opts.force });
  } catch (err) {
    console.error(`configure-env: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (merged.action === "conflict") {
    const report = {
      ok: false,
      file: opts.file,
      key: opts.key,
      action: "conflict",
      existing_set: true,
      changed: false,
      dry_run: opts.dryRun,
    };
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.error(`configure-env: ${opts.key} already has a different value in ${opts.file} (use --force to replace it)`);
    return 3;
  }

  const changed = merged.action === "written" || merged.action === "removed";
  if (changed && !opts.dryRun) {
    try {
      const mode = existsSync(opts.file) ? statSync(opts.file).mode & 0o777 : opts.mode;
      writeAtomic(opts.file, merged.text, { mode });
    } catch (err) {
      console.error(`configure-env: cannot write ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const report = {
    ok: true,
    file: opts.file,
    key: opts.key,
    action: merged.action,
    ...(opts.remove ? { removed: merged.removed } : {}),
    changed,
    dry_run: opts.dryRun,
  };
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    const verb = opts.remove ? (merged.action === "removed" ? "removed" : "unchanged") : merged.action;
    console.log(`configure-env: ${opts.key} ${opts.dryRun ? "would be " : ""}${verb} in ${opts.file}`);
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
