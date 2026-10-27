/**
 * Tests for `test/helpers/base-env.mjs` and `scripts/verify/lib/scrub-env.mjs`.
 *
 * The property is negative and easy to lose: a variable exported in the shell must
 * not reach a child process. Each case plants a variable in `process.env` (the
 * way a developer's shell would), calls the helper, and asserts it is gone —
 * restoring the environment afterwards so the rest of the suite is unaffected.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SCRUB_PREFIXES, scrubEnv } from "../../scripts/verify/lib/scrub-env.mjs";
import { EMPTY_ENV_FILE, baseEnv } from "../helpers/base-env.mjs";

/** Run `body` with `key=value` planted in `process.env`, then restore it. */
function withEnv(key, value, body) {
  const had = Object.hasOwn(process.env, key);
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return body();
  } finally {
    if (had) process.env[key] = previous;
    else delete process.env[key];
  }
}

describe("scrub-env — a shell's board configuration does not leak", () => {
  it("drops a planted TASKCTL_/TASKD_/MEERKAT_ variable from both helpers", () => {
    for (const key of ["TASKCTL_HUMAN", "TASKD_URL", "MEERKAT_TASKPANEL_REPO"]) {
      withEnv(key, "leaked", () => {
        assert.equal(Object.hasOwn(scrubEnv(), key), false, `scrubEnv kept ${key}`);
        assert.equal(Object.hasOwn(baseEnv(), key), false, `baseEnv kept ${key}`);
      });
    }
  });

  it("keeps PATH and HOME, which every child needs", () => {
    const env = baseEnv({ EXTRA: "kept" });
    assert.ok(Object.hasOwn(env, "PATH"));
    assert.ok(Object.hasOwn(env, "HOME"));
    assert.equal(env.EXTRA, "kept", "explicit overrides win");
  });

  it("points MEERKAT_TASKPANEL_ENV_FILE at an existing empty file", () => {
    const env = baseEnv();
    assert.equal(env.MEERKAT_TASKPANEL_ENV_FILE, EMPTY_ENV_FILE);
    assert.equal(readFileSync(EMPTY_ENV_FILE, "utf8"), "", "the shared file must stay empty");
  });

  it("covers every prefix the scrubber declares", () => {
    // A new prefix with no entry here would be silently untested.
    for (const prefix of SCRUB_PREFIXES) {
      withEnv(`${prefix}PROBE`, "leaked", () => {
        assert.equal(Object.hasOwn(scrubEnv(), `${prefix}PROBE`), false);
      });
    }
  });
});
