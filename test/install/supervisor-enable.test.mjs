/**
 * The supervisor's **opt-in enable / disable / status** surface (T-20261013-214703-3).
 *
 * A plain install writes the loop's scheduling units and *prints* the load command
 * (`test/install/scheduling-units.test.mjs`). This file is about the one deliberate
 * exception the contract fixes in `docs/scheduling.md` §"Enabling the supervisor
 * (opt-in)": `install.sh --supervisor=enable|disable|status` (+ aliases,
 * `--supervisor-hosts`, `--scheduler`, `MEERKAT_TASKPANEL_SUPERVISOR`) really does run
 * `launchctl` / `systemctl` / `crontab` — and is idempotent, per-host selectable, and
 * silent (no load at all) unless asked.
 *
 * The service manager is **faked on PATH** — `launchctl`, `systemctl`, `crontab` and
 * `loginctl` — the way `taskd-guard.test.mjs` fakes the guard's, so a test run never
 * loads a real unit and both platforms' mechanisms can be exercised on either platform
 * (`--scheduler` names the mechanism explicitly). `launchd` and `systemd` keep separate
 * state files: they never coexist on one machine, and a shared fake state would fake a
 * cross-mechanism disable that cannot happen for real.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-supervisor-", installDefaults: {} });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UID = process.getuid?.() ?? 0;
const PLATFORM_DEFAULT = process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "cron";

after(cleanup);

// ---------------------------------------------------------------------------
// The faked service manager
// ---------------------------------------------------------------------------

/**
 * A fake `launchctl` / `systemctl` / `crontab` / `loginctl` on PATH. Every call is
 * appended to `log`, so a case can assert *exactly* what was loaded — which is how
 * "enable is idempotent" and "a plain install loads nothing" are held.
 *
 * Knobs: `FAKE_ALREADY=1` (bootstrap refuses with launchd's "already bootstrapped"),
 * `FAKE_IO_ERROR=1` (launchd's "no Aqua session" 5: Input/output error),
 * `FAKE_FAIL=1` (every manager call refuses), `FAKE_LINGER=yes|no` (loginctl).
 */
function fakeManager() {
  const dir = makeTempDir("meerkat-taskpanel-fakebin-");
  const log = join(dir, "calls.log");
  const launchdState = join(dir, "launchd.state");
  const systemdState = join(dir, "systemd.state");
  // Deliberately *not* `join(dir, "crontab")`: that is where the fake script itself lives,
  // and a case that seeds a crontab would overwrite the script it is about to run.
  const crontabTable = join(dir, "crontab.table");
  writeFileSync(log, "");

  const scripts = {
    // launchd keys its state by **job id** (the Label the plist declares), the way the real
    // one does: a fake that treated "any job loaded" as "this job loaded" would hide the
    // second unit of the pair — and would make a repeat enable look idempotent for the
    // wrong reason.
    launchctl: [
      "#!/usr/bin/env bash",
      'printf "launchctl %s\\n" "$*" >> "$FAKE_LOG"',
      'if [ "${FAKE_FAIL:-}" = "1" ]; then echo "fake launchctl: refusing" >&2; exit 1; fi',
      'label_of() { sed -n "s/.*<string>\\(com\\.meerkat-taskpanel[^<]*\\)<\\/string>.*/\\1/p" "$1" | head -1; }',
      'case "$1" in',
      '  print) if [ -f "$FAKE_LAUNCHD_STATE" ] && grep -qxF "$2" "$FAKE_LAUNCHD_STATE"; then printf "\\tpid = 4242\\n"; exit 0; fi',
      '         echo "Could not find service \\"$2\\" in domain for port" >&2; exit 1 ;;',
      '  bootstrap) if [ "${FAKE_ALREADY:-}" = "1" ]; then echo "Bootstrap failed: 37: Service is already bootstrapped" >&2; exit 1; fi',
      '             if [ "${FAKE_IO_ERROR:-}" = "1" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 1; fi',
      '             echo "$2/$(label_of "$3")" >> "$FAKE_LAUNCHD_STATE"; exit 0 ;;',
      '  load) echo "gui/$(id -u)/$(label_of "$3")" >> "$FAKE_LAUNCHD_STATE"; exit 0 ;;',
      '  bootout) if [ -f "$FAKE_LAUNCHD_STATE" ] && grep -qxF "$2" "$FAKE_LAUNCHD_STATE"; then',
      '             grep -vxF "$2" "$FAKE_LAUNCHD_STATE" > "$FAKE_LAUNCHD_STATE.next"',
      '             if [ -s "$FAKE_LAUNCHD_STATE.next" ]; then mv "$FAKE_LAUNCHD_STATE.next" "$FAKE_LAUNCHD_STATE"; else rm -f "$FAKE_LAUNCHD_STATE" "$FAKE_LAUNCHD_STATE.next"; fi',
      '             exit 0; fi',
      '           echo "Could not find service" >&2; exit 1 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    systemctl: [
      "#!/usr/bin/env bash",
      'printf "systemctl %s\\n" "$*" >> "$FAKE_LOG"',
      'if [ "${FAKE_FAIL:-}" = "1" ]; then echo "fake systemctl: refusing" >&2; exit 1; fi',
      // Keyed by unit name, like the real manager: enable/disable of one timer must not
      // change another's state. The legacy migration calls disable on timers that are not
      // enabled, and a coarse one-file state would make that look like "everything off".
      'case "$1 $2" in',
      '  "--user is-enabled") if [ -f "$FAKE_SYSTEMD_STATE" ] && grep -qxF "$3" "$FAKE_SYSTEMD_STATE"; then echo enabled; exit 0; fi; echo disabled >&2; exit 1 ;;',
      '  "--user enable") shift 3',
      '    for unit in "$@"; do grep -qxF "$unit" "$FAKE_SYSTEMD_STATE" 2>/dev/null || echo "$unit" >> "$FAKE_SYSTEMD_STATE"; done',
      "    exit 0 ;;",
      '  "--user disable") shift 3',
      '    for unit in "$@"; do',
      '      [ -f "$FAKE_SYSTEMD_STATE" ] || continue',
      '      grep -vxF "$unit" "$FAKE_SYSTEMD_STATE" > "$FAKE_SYSTEMD_STATE.next" || true',
      '      if [ -s "$FAKE_SYSTEMD_STATE.next" ]; then mv "$FAKE_SYSTEMD_STATE.next" "$FAKE_SYSTEMD_STATE"; else rm -f "$FAKE_SYSTEMD_STATE" "$FAKE_SYSTEMD_STATE.next"; fi',
      "    done",
      "    exit 0 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    crontab: [
      "#!/usr/bin/env bash",
      'printf "crontab %s\\n" "$*" >> "$FAKE_LOG"',
      'case "$1" in',
      '  -l) if [ -f "$FAKE_CRON" ]; then cat "$FAKE_CRON"; exit 0; fi; echo "no crontab for fake" >&2; exit 1 ;;',
      '  -) cat > "$FAKE_CRON"; exit 0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    loginctl: [
      "#!/usr/bin/env bash",
      'printf "loginctl %s\\n" "$*" >> "$FAKE_LOG"',
      'echo "Linger=${FAKE_LINGER:-no}"',
      "exit 0",
      "",
    ].join("\n"),
  };

  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
  }

  return {
    dir,
    log,
    launchdState,
    systemdState,
    crontab: crontabTable,
    env: {
      FAKE_LOG: log,
      FAKE_LAUNCHD_STATE: launchdState,
      FAKE_SYSTEMD_STATE: systemdState,
      FAKE_CRON: crontabTable,
    },
  };
}

/** An isolated install: temp home for both `--prefix` and `$HOME`, fake manager on PATH. */
function installEnv(home, manager, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    MEERKAT_TASKPANEL_TARGET_HOME: home,
    // A real install also loads the taskd keepalive unit; its own cases live in
    // `taskd-guard.test.mjs`, and this file is about the loop's units. Contract's
    // test-only bypass.
    MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
    // `systemdUserDir` prefers an absolute `XDG_CONFIG_HOME` over `$HOME/.config` — right
    // for systemd, but it means an inherited value decides where the units land. Pin it
    // to the directory this suite asserts; a case that wants to exercise the variable
    // passes its own through `extra`.
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: `${manager.dir}:${process.env.PATH}`,
    ...manager.env,
    ...extra,
  };
}

/** Every line the fake manager was asked to run. */
function calls(manager) {
  return readFileSync(manager.log, "utf8").split("\n").filter(Boolean);
}

/** The calls that actually *change* state (as opposed to probing it). */
function loads(manager) {
  return calls(manager).filter((line) => /launchctl (bootstrap|load) |systemctl --user (enable|disable) |crontab -$/.test(line));
}

/** The enable report the docs prescribe, as a regex — quoted literally, not as a pattern. */
function enabledLine(host, scheduler, units) {
  const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^supervisor: enabled \\(host=${quote(host)}, scheduler=${quote(scheduler)}, units=${quote(units)}\\)$`,
    "m",
  );
}

/**
 * The line the enable report closes with — the docs' own "to disable:" command, plus
 * `--scheduler` when the mechanism enabled is **not** what `auto` picks on this platform.
 * The suffix is load-bearing: without it, a `--scheduler=cron` enable on macOS would be
 * undone on launchd, and the printed remedy would be wrong on half the machines.
 */
function disableHintLine(scheduler) {
  const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = scheduler === PLATFORM_DEFAULT ? "" : ` --scheduler=${scheduler}`;
  return new RegExp(
    `^to disable:  install\\.sh --supervisor=disable --supervisor-hosts claude${quote(suffix)}$`,
    "m",
  );
}

// ---------------------------------------------------------------------------
// 1 — the flag surface
// ---------------------------------------------------------------------------

describe("install.sh: the supervisor flag surface", () => {
  it("rejects an unknown --supervisor action, writing nothing", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(["--target", "claude", "--prefix", home, "--supervisor=maybe"], installEnv(home, manager));

    assert.equal(run.status, 2);
    assert.match(run.stderr, /--supervisor must be enable, disable or status/);
    assert.equal(existsSync(join(home, ".claude")), false, "a usage error must not install anything");
  });

  it("rejects --supervisor-hosts openclaw, with the reason (exit 2)", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "all", "--prefix", home, "--supervisor=enable", "--supervisor-hosts", "openclaw"],
      installEnv(home, manager),
    );

    assert.equal(run.status, 2);
    assert.match(run.stderr, /--supervisor-hosts openclaw/);
    assert.match(run.stderr, /OpenClaw has no meerkat-loop supervisor/);
    assert.equal(existsSync(join(home, ".claude")), false, "nothing is installed when the request is invalid");
    assert.deepEqual(loads(manager), [], "and nothing is loaded");
  });

  it("accepts --supervisor-hosts opencode,cursor (dry run loads nothing)", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      [
        "--target", "all", "--agent-name", "alice", "--prefix", home, "--dry-run",
        "--supervisor=enable", "--supervisor-hosts", "opencode,cursor", "--scheduler=launchd",
      ],
      installEnv(home, manager),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /supervisor: dry-run — would enable \(host=opencode,/);
    assert.match(run.stdout, /supervisor: dry-run — would enable \(host=cursor,/);
    assert.deepEqual(loads(manager), [], "a dry run asks no service manager");
  });

  it("rejects an unknown --supervisor-hosts entry and an unknown --scheduler", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const hosts = runInstall(
      ["--target", "all", "--prefix", home, "--supervisor=enable", "--supervisor-hosts", "emacs"],
      installEnv(home, manager),
    );
    assert.equal(hosts.status, 2);
    assert.match(hosts.stderr, /invalid --supervisor-hosts: emacs/);

    const scheduler = runInstall(
      ["--target", "claude", "--prefix", home, "--supervisor=enable", "--scheduler", "upstart"],
      installEnv(home, manager),
    );
    assert.equal(scheduler.status, 2);
    assert.match(scheduler.stderr, /invalid --scheduler: upstart/);
  });

  it("a plain install never asks a service manager — it only prints the load command", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(["--target", "claude", "--agent-name", "alice", "--prefix", home], installEnv(home, manager));

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /to start the supervisor, load one of these \(nothing is loaded for you\):/);
    assert.doesNotMatch(run.stdout, /supervisor: enabled/);
    assert.deepEqual(calls(manager), [], "no manager is even asked — not even for a status probe");
  });

  it("the three aliases are the three actions of the one entry point", () => {
    const cases = [
      ["--enable-supervisor", /supervisor: enabled/],
      ["--disable-supervisor", /supervisor: (already )?disabled/],
      ["--supervisor-status", /^supervisor: status \(host=claude\)$/m],
    ];
    for (const [flag, expected] of cases) {
      const home = makeTempDir();
      const manager = fakeManager();
      const run = runInstall(["--target", "claude", "--prefix", home, flag], installEnv(home, manager));
      assert.equal(run.status, 0, `${flag}: ${run.stderr}`);
      assert.match(run.stdout, expected, flag);
    }
  });

  it("honours MEERKAT_TASKPANEL_SUPERVISOR when no flag is given", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home],
      installEnv(home, manager, { MEERKAT_TASKPANEL_SUPERVISOR: "enable", MEERKAT_TASKPANEL_SCHEDULER: "launchd" }),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, enabledLine("claude", "launchd", "com.meerkat-taskpanel.alice.claude.session,.ping,.continue,.subscribe"));
  });
});

// ---------------------------------------------------------------------------
// 2 — launchd (macOS)
// ---------------------------------------------------------------------------

describe("install.sh: enable — launchd", () => {
  it("bootstraps both units and reports host / scheduler / units", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=launchd"],
      installEnv(home, manager),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, enabledLine("claude", "launchd", "com.meerkat-taskpanel.alice.claude.session,.ping,.continue,.subscribe"));
    assert.match(run.stdout, disableHintLine("launchd"));

    const scheduling = join(home, ".claude", "scheduling", "launchd");
    assert.deepEqual(
      loads(manager),
      [
        `launchctl bootstrap gui/${UID} ${join(scheduling, "com.meerkat-taskpanel.session.plist")}`,
        `launchctl bootstrap gui/${UID} ${join(scheduling, "com.meerkat-taskpanel.ping.plist")}`,
        `launchctl bootstrap gui/${UID} ${join(scheduling, "com.meerkat-taskpanel.continue.plist")}`,
        `launchctl bootstrap gui/${UID} ${join(scheduling, "com.meerkat-taskpanel.subscribe.plist")}`,
      ],
      "one bootstrap per unit, in order",
    );
    assert.equal(existsSync(manager.launchdState), true, "the job is live");
  });

  it("is idempotent: a second enable loads nothing again", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const args = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=launchd"];
    assert.equal(runInstall(args, installEnv(home, manager)).status, 0);
    const afterFirst = loads(manager);

    const again = runInstall(args, installEnv(home, manager));
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /supervisor: already enabled \(host=claude, scheduler=launchd, units=/);
    assert.deepEqual(loads(manager), afterFirst, "no second load");
  });

  it("treats launchd's `already bootstrapped` refusal as an idempotent success", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=launchd"],
      installEnv(home, manager, { FAKE_ALREADY: "1" }),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /supervisor: enabled \(host=claude, scheduler=launchd, units=/);
    assert.doesNotMatch(run.stdout, /not enabled/);
  });

  it("reports a load it cannot do instead of claiming success — and still installs the host", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=launchd"],
      installEnv(home, manager, { FAKE_IO_ERROR: "1" }),
    );

    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, /supervisor: not enabled \(host=claude, scheduler=launchd, units=[^)]*\) — no GUI login session/);
    assert.match(run.stdout, /supervisor: enable it with:/);
    assert.match(run.stdout, /supervisor:   launchctl bootstrap gui\/\d+ /);
    assert.doesNotMatch(run.stdout, /supervisor: enabled/);
    // The host's own install is unaffected — the units are written, and the summary is OK.
    assert.match(run.stdout, /OK   claude/);
    assert.ok(existsSync(join(home, ".claude", "scheduling", "launchd", "com.meerkat-taskpanel.ping.plist")));
  });

  it("disable boots both jobs out, and a second disable is a no-op", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const base = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--scheduler=launchd"];
    assert.equal(runInstall([...base, "--supervisor=enable"], installEnv(home, manager)).status, 0);

    const disabled = runInstall([...base, "--supervisor=disable"], installEnv(home, manager));
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /^supervisor: disabled \(host=claude, scheduler=launchd, units=/m);
    assert.equal(existsSync(manager.launchdState), false, "the job is gone");
    assert.equal(
      calls(manager).filter((line) => line.startsWith("launchctl bootout")).length,
      8,
      "two legacy bootouts during enable, then six during disable (legacy + new)",
    );

    const again = runInstall([...base, "--supervisor=disable"], installEnv(home, manager));
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^supervisor: already disabled \(host=claude, scheduler=launchd, units=/m);
  });

  it("status reports the per-mechanism load state and changes nothing", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const base = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--scheduler=launchd"];

    const before = runInstall([...base, "--supervisor=status"], installEnv(home, manager));
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /^supervisor: status \(host=claude\)$/m);
    assert.match(before.stdout, /^supervisor:   launchd: not loaded \(com\.meerkat-taskpanel\.alice\.claude\.session=not loaded, /m);
    assert.deepEqual(loads(manager), [], "status loads nothing");

    assert.equal(runInstall([...base, "--supervisor=enable"], installEnv(home, manager)).status, 0);
    const after = runInstall([...base, "--supervisor=status"], installEnv(home, manager));
    assert.match(after.stdout, /^supervisor:   launchd: loaded \(/m);
    assert.match(after.stdout, /^supervisor:   session: not running \(no session state\)$/m);
    assert.match(after.stdout, /^supervisor:   tools: role allowlists \(full access is off\)$/m);

    // The full-access opt-in is an authorization; status states it and who
    // recorded it, so a bypass is never invisible.
    const config = join(home, ".claude", "meerkat-taskpanel.env");
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS=yes\n` +
        "MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON=operator authorized unattended runs\n",
    );
    const authorized = runInstall([...base, "--supervisor=status"], installEnv(home, manager));
    assert.match(
      authorized.stdout,
      /^supervisor:   tools: all enabled \(authorized by: operator authorized unattended runs\)/m,
    );
  });
});

// ---------------------------------------------------------------------------
// 3 — systemd --user (Linux)
// ---------------------------------------------------------------------------

describe("install.sh: enable — systemd", () => {
  it("copies the units, reloads, then enables --now — and warns that lingering is off", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=systemd"],
      installEnv(home, manager, { FAKE_LINGER: "no", USER: "alice" }),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, enabledLine("claude", "systemd", "meerkat-taskpanel-ping.timer,meerkat-taskpanel-continue.timer,meerkat-taskpanel-session.service,meerkat-taskpanel-subscribe.service"));

    // The units must land where systemd reads them (HOME, not --prefix-in-the-abstract).
    const unitDir = join(home, ".config", "systemd", "user");
    for (const name of [
      "meerkat-taskpanel-ping.service",
      "meerkat-taskpanel-ping.timer",
      "meerkat-taskpanel-continue.service",
      "meerkat-taskpanel-continue.timer",
      "meerkat-taskpanel-session.service",
      "meerkat-taskpanel-subscribe.service",
    ]) {
      assert.ok(existsSync(join(unitDir, name)), `${name} must be copied into ${unitDir}`);
    }

    const sequence = calls(manager).filter((line) => line.startsWith("systemctl"));
    assert.deepEqual(sequence, [
      "systemctl --user disable --now meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer",
      "systemctl --user daemon-reload",
      "systemctl --user is-enabled meerkat-taskpanel-ping.timer",
      "systemctl --user is-enabled meerkat-taskpanel-continue.timer",
      "systemctl --user is-enabled meerkat-taskpanel-session.service",
      "systemctl --user is-enabled meerkat-taskpanel-subscribe.service",
      "systemctl --user enable --now meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-session.service meerkat-taskpanel-subscribe.service",
    ]);
    assert.match(run.stdout, /supervisor: warning — lingering is off.*loginctl enable-linger alice/s);
  });

  it("says nothing about lingering when it is on, and is idempotent", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const args = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=systemd"];
    const env = installEnv(home, manager, { FAKE_LINGER: "yes", USER: "alice" });

    const first = runInstall(args, env);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout, /warning/);

    const again = runInstall(args, env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /supervisor: already enabled \(host=claude, scheduler=systemd, units=/);
    assert.equal(calls(manager).filter((line) => line.includes("enable --now")).length, 1, "enabled once");
  });

  it("ignores an ambient XDG_CONFIG_HOME, so the unit directory does not depend on the machine", () => {
    // `installEnv` inherits the ambient environment through `...process.env`, and
    // `systemdUserDir` honours an absolute `XDG_CONFIG_HOME` ahead of `$HOME/.config` —
    // correct for systemd, but it made this suite pass on macOS and fail on any runner
    // that exports the variable (GitHub's ubuntu image does), with an assertion that
    // reads like a broken installer rather than an environment leak.
    const home = makeTempDir();
    const manager = fakeManager();
    const args = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=systemd"];
    const previous = process.env.XDG_CONFIG_HOME;

    let run;
    process.env.XDG_CONFIG_HOME = join(home, "ambient", ".config");
    try {
      run = runInstall(args, installEnv(home, manager, { FAKE_LINGER: "yes", USER: "alice" }));
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }

    assert.equal(run.status, 0, run.stderr);
    assert.ok(
      existsSync(join(home, ".config", "systemd", "user", "meerkat-taskpanel-ping.service")),
      "the units must land in $HOME/.config regardless of an ambient XDG_CONFIG_HOME",
    );
  });

  it("lets an explicit XDG_CONFIG_HOME decide the unit directory", () => {
    // The counterpart: the variable must still work when the install is actually given
    // one — a fix that simply deleted it would pass the case above for the wrong reason.
    const home = makeTempDir();
    const manager = fakeManager();
    const xdg = join(home, "xdg");
    const args = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=systemd"];

    const run = runInstall(args, installEnv(home, manager, { FAKE_LINGER: "yes", USER: "alice", XDG_CONFIG_HOME: xdg }));

    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(xdg, "systemd", "user", "meerkat-taskpanel-ping.service")), `the unit must follow ${xdg}`);
  });

  it("disable disables and stops the timers", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const base = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--scheduler=systemd"];
    const env = installEnv(home, manager, { FAKE_LINGER: "yes", USER: "alice" });
    assert.equal(runInstall([...base, "--supervisor=enable"], env).status, 0);

    const disabled = runInstall([...base, "--supervisor=disable"], env);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /^supervisor: disabled \(host=claude, scheduler=systemd, units=/m);
    assert.ok(
      calls(manager).includes("systemctl --user disable --now meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-session.service meerkat-taskpanel-subscribe.service meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer"),
    );

    const again = runInstall([...base, "--supervisor=disable"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^supervisor: already disabled \(host=claude, scheduler=systemd, units=/m);
  });
});

// ---------------------------------------------------------------------------
// 4 — cron (the portable fallback)
// ---------------------------------------------------------------------------

describe("install.sh: enable — cron", () => {
  it("installs a managed marker block, keeping whatever was already in the crontab", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    // A comment and a blank line: the user's own spacing must come back untouched, not
    // reflowed — the enable path only owns its marker block.
    writeFileSync(manager.crontab, "# mine\n\n0 3 * * * /usr/bin/true\n", "utf8");

    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=cron"],
      installEnv(home, manager),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, enabledLine("claude", "cron", "crontab block (~/.claude)"));

    const table = readFileSync(manager.crontab, "utf8");
    assert.match(table, /^0 3 \* \* \* \/usr\/bin\/true$/m, "the user's own line survives");
    assert.match(table, /^# mine$/m, "and their comment");
    assert.match(table, /^$/m, "and their blank line — nothing is reflowed");
    assert.equal(table.split("# >>> meerkat-taskpanel (~/.claude) >>>").length - 1, 1, "exactly one block");
    // The block is what the unit file says — the `PATH=` setting line included, and an
    // absolute interpreter: cron resolves a bare `node` against its own minimal PATH, so
    // `/usr/bin/env node` here is the 127 this card removes (T-20261014-020103-2). The
    // PATH line sits *inside* the block, so `disable` takes it away with the block.
    const blockLines = table.split("# >>> meerkat-taskpanel (~/.claude) >>>\n")[1].split("\n");
    assert.match(blockLines[0], /^PATH=\S+$/);
    assert.match(blockLines[1], /^\* \* \* \* \* \/[^ ]*node .*supervisor\.mjs --host claude --agent alice --ping-only --once --log .* >\/dev\/null 2>&1$/);
    assert.match(blockLines[2], /^\*\/10 \* \* \* \* \/[^ ]*node .*supervisor\.mjs --host claude --agent alice --continue-only --once /);
    assert.equal(blockLines[3], "# <<< meerkat-taskpanel (~/.claude) <<<");
    assert.match(table, /^# <<< meerkat-taskpanel \(~\/\.claude\) <<<$/m);

    assert.equal(calls(manager).filter((line) => line === "crontab -").length, 1, "written once");
  });

  it("treats `no crontab for <user>` as empty, not as a failure", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=cron"],
      installEnv(home, manager),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /supervisor: enabled \(host=claude, scheduler=cron, units=/);
    assert.match(readFileSync(manager.crontab, "utf8"), /# >>> meerkat-taskpanel \(~\/\.claude\) >>>/);
  });

  it("re-enabling replaces the block instead of duplicating it", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const args = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable", "--scheduler=cron"];
    assert.equal(runInstall(args, installEnv(home, manager)).status, 0);
    const writes = calls(manager).filter((line) => line === "crontab -").length;

    const again = runInstall(args, installEnv(home, manager));
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /supervisor: already enabled \(host=claude, scheduler=cron, units=/);
    assert.equal(calls(manager).filter((line) => line === "crontab -").length, writes, "no second write");

    const table = readFileSync(manager.crontab, "utf8");
    assert.equal(table.split("# >>> meerkat-taskpanel").length - 1, 1, "still exactly one block");
  });

  it("disable strips our block and nothing else", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    writeFileSync(manager.crontab, "0 3 * * * /usr/bin/true\n", "utf8");
    const base = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--scheduler=cron"];
    assert.equal(runInstall([...base, "--supervisor=enable"], installEnv(home, manager)).status, 0);

    const disabled = runInstall([...base, "--supervisor=disable"], installEnv(home, manager));
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /^supervisor: disabled \(host=claude, scheduler=cron, units=/m);
    const table = readFileSync(manager.crontab, "utf8");
    assert.doesNotMatch(table, /meerkat-taskpanel/);
    assert.match(table, /^0 3 \* \* \* \/usr\/bin\/true$/m);

    const again = runInstall([...base, "--supervisor=disable"], installEnv(home, manager));
    assert.match(again.stdout, /^supervisor: already disabled \(host=claude, scheduler=cron, units=/m);
  });

  it("enabling a second mechanism takes the first down — never two loaded for one host", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const base = ["--target", "claude", "--agent-name", "alice", "--prefix", home];
    const env = installEnv(home, manager);
    assert.equal(runInstall([...base, "--supervisor=enable", "--scheduler=cron"], env).status, 0);
    assert.match(readFileSync(manager.crontab, "utf8"), /# >>> meerkat-taskpanel \(~\/\.claude\) >>>/);

    const moved = runInstall([...base, "--supervisor=enable", "--scheduler=launchd"], env);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(
      moved.stdout,
      /supervisor: disabled \(host=claude, scheduler=cron, units=crontab block \(~\/\.claude\)\) — one mechanism per host/,
    );
    assert.doesNotMatch(readFileSync(manager.crontab, "utf8"), /meerkat-taskpanel/, "the cron block is gone");
    assert.ok(existsSync(manager.launchdState), "launchd is the one loaded now");
    assert.match(moved.stdout, /supervisor: enabled \(host=claude, scheduler=launchd, units=/);
  });

  it("status reads the crontab without changing it", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const base = ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--scheduler=cron"];
    const env = installEnv(home, manager);
    assert.equal(runInstall([...base, "--supervisor=enable"], env).status, 0);
    const before = readFileSync(manager.crontab, "utf8");

    const status = runInstall([...base, "--supervisor=status"], env);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^supervisor:   cron: loaded \(~\/\.claude=loaded\)$/m);
    assert.equal(readFileSync(manager.crontab, "utf8"), before, "read-only");
  });
});

// ---------------------------------------------------------------------------
// 5 — --dry-run, per-host selection, and the openclaw exclusion
// ---------------------------------------------------------------------------

describe("install.sh: --dry-run and per-host selection", () => {
  it("--dry-run prints the exact commands it would run, for every mechanism, and changes nothing", () => {
    const cases = [
      ["launchd", new RegExp(`^supervisor: would run: launchctl bootstrap gui/${UID} .*com\\.meerkat-taskpanel\\.ping\\.plist$`, "m")],
      ["systemd", /^supervisor: would run: systemctl --user enable --now meerkat-taskpanel-ping\.timer meerkat-taskpanel-continue\.timer meerkat-taskpanel-session\.service meerkat-taskpanel-subscribe\.service$/m],
      ["cron", /^supervisor: would run:   # >>> meerkat-taskpanel \(~\/\.claude\) >>>$/m],
    ];
    for (const [scheduler, expected] of cases) {
      const home = makeTempDir();
      const manager = fakeManager();
      const run = runInstall(
        ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--dry-run", "--supervisor=enable", `--scheduler=${scheduler}`],
        installEnv(home, manager),
      );

      assert.equal(run.status, 0, `${scheduler}: ${run.stderr}`);
      assert.match(run.stdout, new RegExp(`supervisor: dry-run — would enable \\(host=claude, scheduler=${scheduler}, units=`));
      assert.match(run.stdout, expected, scheduler);
      assert.deepEqual(calls(manager), [], `${scheduler}: a dry run asks no service manager`);
      assert.equal(existsSync(join(home, ".claude")), false, `${scheduler}: and writes nothing`);
    }
  });

  it("--supervisor-hosts acts on the named host only", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      [
        "--target", "all",
        "--agent-name", "alice",
        "--prefix", home,
        "--supervisor=enable",
        "--supervisor-hosts", "claude",
        "--scheduler=launchd",
      ],
      installEnv(home, manager),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, enabledLine("claude", "launchd", "com.meerkat-taskpanel.alice.claude.session,.ping,.continue,.subscribe"));
    assert.doesNotMatch(run.stdout, /supervisor: enabled \(host=codex/);
    assert.doesNotMatch(run.stdout, /supervisor: enabled \(host=pi/);

    const bootstraps = calls(manager).filter((line) => line.startsWith("launchctl bootstrap"));
    assert.equal(bootstraps.length, 4, "only claude's units are loaded");
    for (const line of bootstraps) assert.ok(line.includes(join(".claude", "scheduling")), line);

    // Every loop host is still installed — the selection is about the *action*, not the files.
    for (const hostDir of [".claude", ".codex", ".agents", ".config/opencode", ".cursor"]) {
      assert.ok(existsSync(join(home, hostDir, "skills", "meerkat-loop", "SKILL.md")), `${hostDir} loop skill`);
    }
  });

  it("--target openclaw with --supervisor=enable enables nothing, and says so", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "openclaw", "--prefix", home, "--supervisor=enable", "--scheduler=launchd"],
      installEnv(home, manager),
    );

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /no loop host to act on \(OpenClaw runs openclaw-team's own poll\/patrol\)/);
    assert.doesNotMatch(run.stdout, /supervisor: enabled/);
    assert.equal(existsSync(join(home, ".openclaw", "scheduling")), false, "OpenClaw still gets no units");
    assert.equal(existsSync(join(home, ".openclaw", "skills", "meerkat-loop")), false, "and no loop skill");
    assert.deepEqual(calls(manager), [], "nothing is loaded for it");
  });

  it("auto picks this platform's native mechanism", () => {
    const home = makeTempDir();
    const manager = fakeManager();
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--supervisor=enable"],
      installEnv(home, manager, { FAKE_LINGER: "yes" }),
    );

    assert.equal(run.status, 0, run.stderr);
    const units =
      PLATFORM_DEFAULT === "launchd"
        ? "com.meerkat-taskpanel.alice.claude.session,.ping,.continue,.subscribe"
        : PLATFORM_DEFAULT === "systemd"
          ? "meerkat-taskpanel-ping.timer,meerkat-taskpanel-continue.timer,meerkat-taskpanel-session.service,meerkat-taskpanel-subscribe.service"
          : "crontab block (~/.claude)";
    assert.match(run.stdout, enabledLine("claude", PLATFORM_DEFAULT, units));
    // With `auto`, the printed remedy is the doc's own line — no `--scheduler` suffix, on
    // either platform, because the hint only carries one when auto would pick differently.
    assert.match(run.stdout, /^to disable:  install\.sh --supervisor=disable --supervisor-hosts claude$/m);
  });
});
