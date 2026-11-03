/**
 * `skills/setup-meerkat/scripts/worktree-init.mjs` — the Step 4 initializer.
 *
 * The merge contract is the point: unrelated hooks survive, a second run is a
 * no-op, a dry run writes nothing, and a generated file is never clobbered
 * without `--force`. The script writes adapters only; the project's rules live
 * in `docs/agents/worktrees.md`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  hasLegacyGuard,
  main,
  mergeHooksData,
  mergeHooksFile,
  renderPiExtension,
  writeGenerated,
} from "../../skills/setup-meerkat/scripts/worktree-init.mjs";

const tempDirs = [];
function tempDir(prefix = "worktree-init-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const OPTIONS = {
  guardCommand: "'/bin/taskctl' worktree guard --runtime claude",
  statusCommand: "'/bin/taskctl' worktree status",
  matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
};

describe("hasLegacyGuard", () => {
  it("detects the hand-installed guard and ignores an absent file", () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    assert.equal(hasLegacyGuard(file), false);
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [{ type: "command", command: "~/.claude/hooks/meerkat-taskpanel-worktree-guard.sh" }],
            },
          ],
        },
      }),
    );
    assert.equal(hasLegacyGuard(file), true);
  });
});

describe("mergeHooksData", () => {
  it("adds both entries and preserves every unrelated key", () => {
    const before = {
      env: { KEEP: "1" },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    const merged = mergeHooksData(before, OPTIONS);
    assert.equal(merged.ok, true);
    assert.equal(merged.changed, true);
    assert.deepEqual(merged.data.env, { KEEP: "1" });
    assert.equal(merged.data.hooks.PreToolUse.length, 2);
    assert.equal(merged.data.hooks.SessionStart.length, 1);
  });

  it("is idempotent", () => {
    const first = mergeHooksData({}, OPTIONS);
    const second = mergeHooksData(first.data, OPTIONS);
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
  });

  it("reports a hooks value that is not an object", () => {
    const result = mergeHooksData({ hooks: "nope" }, OPTIONS);
    assert.equal(result.ok, false);
    assert.match(result.message, /hooks/);
  });
});

describe("mergeHooksFile", () => {
  it("writes once, then reports unchanged; --dry-run writes nothing", () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    const dry = mergeHooksFile(file, OPTIONS, { dryRun: true });
    assert.equal(dry.status, "would-write");
    assert.equal(existsSync(file), false);

    const first = mergeHooksFile(file, OPTIONS);
    assert.equal(first.status, "written");
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.hooks.PreToolUse.length, 1);

    const second = mergeHooksFile(file, OPTIONS);
    assert.equal(second.status, "unchanged");
  });

  it("leaves an unreadable file alone as a conflict", () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    writeFileSync(file, "{ not json");
    const result = mergeHooksFile(file, OPTIONS);
    assert.equal(result.status, "conflict");
    assert.equal(readFileSync(file, "utf8"), "{ not json");
  });
});

describe("writeGenerated", () => {
  it("writes, then reports unchanged", () => {
    const dir = tempDir();
    const file = join(dir, "extension.ts");
    assert.equal(writeGenerated(file, "one\n").status, "written");
    assert.equal(writeGenerated(file, "one\n").status, "unchanged");
  });

  it("refuses different content without --force, and dry-run writes nothing", () => {
    const dir = tempDir();
    const file = join(dir, "extension.ts");
    writeFileSync(file, "old\n");
    assert.equal(writeGenerated(file, "new\n").status, "conflict");
    assert.equal(writeGenerated(file, "new\n", { force: true }).status, "written");
    assert.equal(readFileSync(file, "utf8"), "new\n");

    const dry = writeGenerated(join(dir, "other.ts"), "x\n", { dryRun: true });
    assert.equal(dry.status, "would-write");
    assert.equal(existsSync(join(dir, "other.ts")), false);
  });
});

describe("renderPiExtension", () => {
  it("embeds the CLI and the pi guard invocation", () => {
    const source = renderPiExtension("/home/alice/.agents/bin/taskctl");
    assert.match(source, /\/home\/alice\/\.agents\/bin\/taskctl/);
    assert.match(source, /"worktree", "guard", "--runtime", "pi"/);
    assert.match(source, /block: true/);
  });
});

describe("main", () => {
  it("initializes the detected kinds, then is a no-op", () => {
    const home = tempDir("worktree-home-");
    const project = tempDir("worktree-project-");
    for (const dir of [".claude", ".codex", join(".pi", "agent")]) {
      mkdirSync(join(home, dir), { recursive: true });
    }
    const cli = join(home, "taskctl");
    writeFileSync(cli, "#!/bin/sh\n");

    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const first = main([
        "--home", home, "--project", project, "--cli", cli,
        "--runtime", "claude,codex,pi", "--json",
      ]);
      assert.equal(first, 0);
      assert.ok(existsSync(join(home, ".claude", "settings.json")));
      assert.ok(existsSync(join(home, ".codex", "hooks.json")));
      assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "meerkat-worktree-guard.ts")));

      const second = main([
        "--home", home, "--project", project, "--cli", cli,
        "--runtime", "claude,codex,pi", "--json",
      ]);
      assert.equal(second, 0);
      const report = JSON.parse(logs.at(-1));
      assert.equal(report.results.claude.status, "unchanged");
      assert.equal(report.results.codex.status, "unchanged");
      assert.equal(report.results.pi.status, "unchanged");
    } finally {
      console.log = original;
    }
  });

  it("reports an older ad-hoc guard and leaves it in place", () => {
    const home = tempDir("worktree-home-");
    const project = tempDir("worktree-project-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const cli = join(home, "taskctl");
    writeFileSync(cli, "#!/bin/sh\n");
    const settings = join(home, ".claude", "settings.json");
    const legacy = {
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "/h/meerkat-taskpanel-worktree-guard.sh" }] },
        ],
      },
    };
    writeFileSync(settings, JSON.stringify(legacy));

    const logs = [];
    const original = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      assert.equal(
        main(["--home", home, "--project", project, "--cli", cli, "--runtime", "claude", "--json"]),
        0,
      );
      const report = JSON.parse(logs.at(-1));
      assert.ok(report.warnings.some((warning) => /older ad-hoc guard/.test(warning)));
      const saved = JSON.parse(readFileSync(settings, "utf8"));
      assert.ok(
        saved.hooks.PreToolUse.some((entry) =>
          entry.hooks.some((hook) => hook.command.endsWith("meerkat-taskpanel-worktree-guard.sh")),
        ),
        "the legacy entry survives",
      );
    } finally {
      console.log = original;
    }
  });

  it("requires a CLI shim", () => {
    assert.equal(main(["--runtime", "claude"]), 2);
  });
});
