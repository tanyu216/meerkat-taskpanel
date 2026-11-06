/**
 * The supervisor's local role-catalog sync.
 *
 * Two properties are the whole point: the supervisor publishes **the set it
 * discovered** (never a re-scan by `taskctl`), and the sync is a fail-soft local
 * write that runs on every poll — including one with no resident pool — so a
 * deleted or hand-broken catalog heals on the next tick.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { ROLE_CATALOG_SCHEMA } from "../../src/foundation/role-catalog.mjs";
import { roleCatalogPayload, syncRoleCatalog } from "../../src/orchestrator/role-sync.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const realCli = join(ROOT, "src", "cli", "index.mjs");
const dirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const roleSet = {
  source: "skills",
  primaryKind: "claude",
  roles: [
    {
      id: "jobs",
      agent: "Jobs",
      nativeAgent: "jobs",
      title: "Product design",
      summary: "Owns the brief",
      lanes: ["worker"],
      shapes: ["product brief"],
      // `loadRoles` still reads the contract prose from role.json; the payload drops it.
      responsibilities: ["Write the product brief first"],
      boundaries: ["Do not write production backend code"],
      installedOn: ["claude"],
      defaultReviewer: false,
      skillDir: "/home/tester/.claude/skills/jobs",
      workflow: "/home/tester/.claude/skills/jobs/SKILL.md",
      variants: { claude: { skillDir: "/home/tester/.claude/skills/jobs" } },
    },
  ],
};

describe("role-sync — the published payload", () => {
  it("carries the discovered roles and no host path", () => {
    const payload = roleCatalogPayload(roleSet, new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(payload.schema, ROLE_CATALOG_SCHEMA);
    assert.equal(payload.source, "skills");
    assert.equal(payload.primary_kind, "claude");
    assert.equal(payload.updated_at, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(payload.roles.map((role) => role.id), ["jobs"]);
    assert.equal(JSON.stringify(payload).includes("/home/tester"), false);
  });

  it("does not carry the role contract's prose, so every tick publishes less", () => {
    const payload = roleCatalogPayload(roleSet, new Date("2026-01-01T00:00:00.000Z"));
    const projected = payload.roles[0];
    assert.equal(Object.hasOwn(projected, "responsibilities"), false);
    assert.equal(Object.hasOwn(projected, "boundaries"), false);
    assert.equal(JSON.stringify(payload).includes("Write the product brief first"), false);
    assert.equal(projected.title, "Product design", "the routing fields stay");
  });
});

describe("role-sync — the call", () => {
  it("writes through taskctl role sync over stdin, as the orchestrator", () => {
    const calls = [];
    const run = (opts, agent, args, options) => {
      calls.push({ agent, args, options });
      return { ok: true, data: { changed: true, roles: 1 } };
    };
    const result = syncRoleCatalog({
      opts: { dryRun: false },
      roleSet,
      run,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["role", "sync", "--file", "-"]);
    assert.equal(calls[0].agent, "Board");
    assert.equal(calls[0].options.actorKind, "system");
    const payload = JSON.parse(calls[0].options.input);
    assert.equal(payload.schema, ROLE_CATALOG_SCHEMA);
    assert.deepEqual(payload.roles.map((role) => role.id), ["jobs"]);
  });

  it("writes an empty catalog when discovery found nothing (full replacement)", () => {
    const calls = [];
    syncRoleCatalog({
      opts: {},
      roleSet: { source: null, primaryKind: "claude", roles: [] },
      run: (opts, agent, args, options) => {
        calls.push(options);
        return { ok: true, data: { changed: true, roles: 0 } };
      },
    });
    assert.deepEqual(JSON.parse(calls[0].input).roles, []);
  });

  it("skips a dry run", () => {
    let called = false;
    const result = syncRoleCatalog({
      opts: { dryRun: true },
      roleSet,
      run: () => {
        called = true;
        return { ok: true, data: {} };
      },
    });
    assert.deepEqual(result, { ok: true, skipped: "dry-run" });
    assert.equal(called, false);
  });

  it("fails soft and logs when the CLI refuses", () => {
    const lines = [];
    const result = syncRoleCatalog({
      opts: {},
      roleSet,
      log: (line) => lines.push(line),
      run: () => ({ ok: false, error: "CLI_IO: not writable" }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /not writable/);
    assert.match(lines.join("\n"), /role catalog: sync failed/);
  });
});

describe("role-sync — through poll", () => {
  /** A CLI that answers board reads and delegates `role …` to the real CLI. */
  function wrapperCli(dir) {
    const script = join(dir, "wrapper-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync, readFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "if (argv.includes('role')) {",
        "  const child = spawnSync(process.execPath, [process.env.TP_REAL_CLI, ...argv], {",
        "    input: readFileSync(0, 'utf8'), encoding: 'utf8', env: process.env,",
        "  });",
        "  process.stdout.write(child.stdout ?? '');",
        "  process.stderr.write(child.stderr ?? '');",
        "  process.exit(child.status ?? 1);",
        "}",
        "process.stdout.write(`${JSON.stringify({ ok: true, data: { candidates: [], tasks: [], actions: [], comments: [], reports: [], projects: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } } })}\\n`);",
      ].join("\n"),
      "utf8",
    );
    return script;
  }

  function runPoll(dir, { livePool }) {
    const home = join(dir, "home");
    const roleDir = join(home, ".claude", "skills", "jobs");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "SKILL.md"), "---\nname: jobs\n---\n", "utf8");
    writeFileSync(
      join(roleDir, "role.json"),
      JSON.stringify({ schema: "meerkat-role", id: "jobs", agent: "Jobs", lanes: ["worker"] }),
      "utf8",
    );
    if (livePool) {
      writeFileSync(
        join(dir, "sessions.state.json"),
        JSON.stringify({
          version: 1,
          poolPid: process.pid,
          heartbeatAt: new Date().toISOString(),
          control: { pid: process.pid, sessionId: "sid-control" },
          projects: {},
        }),
        "utf8",
      );
    }
    const record = join(dir, "calls.jsonl");
    const script = wrapperCli(dir);
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, "src", "orchestrator", "passes.mjs"),
        "poll",
        "--actor-kind", "claude", "--agent", "alice",
        "--home", home,
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
        "--config", join(dir, ".env.claude"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TP_SENTINEL: record,
          TP_REAL_CLI: realCli,
          MEERKAT_TASKPANEL_CONFIG_DIR: dir,
        },
      },
    );
    return { run, record, catalog: join(dir, "roles.json") };
  }

  it("syncs the discovered set on a bare poll with no resident pool", () => {
    const dir = tempDir("tp-role-sync-bare-");
    const { run, catalog } = runPoll(dir, { livePool: false });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr + run.stdout, /no resident session pool/);
    assert.equal(existsSync(catalog), true, "the sync runs before the no-pool return");
    const data = JSON.parse(readFileSync(catalog, "utf8"));
    assert.deepEqual(data.roles.map((role) => role.id), ["jobs"]);
    assert.equal(data.primary_kind, "claude");
  });

  it("is idempotent: a second poll rewrites the same content and keeps updated_at", () => {
    const dir = tempDir("tp-role-sync-idem-");
    assert.equal(runPoll(dir, { livePool: false }).run.status, 0);
    const first = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
    const second = runPoll(dir, { livePool: false });
    assert.equal(second.run.status, 0, second.run.stderr);
    const again = JSON.parse(readFileSync(join(dir, "roles.json"), "utf8"));
    assert.equal(again.updated_at, first.updated_at);
    assert.deepEqual(again.roles, first.roles);
  });
});
