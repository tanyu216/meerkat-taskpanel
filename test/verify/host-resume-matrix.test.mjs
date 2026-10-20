/**
 * The Cursor row of the host-resume matrix.
 *
 * `cursor-agent` is handled the same way as claude / codex / pi / opencode: a
 * supplementary, host-side probe that SKIPs when the CLI is absent. The flag
 * table is the evidence for the argv shape the wake glue builds; `--e2e` adds
 * one real `-p` call when `CURSOR_API_KEY` is present.
 *
 * Run with: `node --test`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HOSTS, e2eHost } from "../../scripts/verify/host-resume-matrix.mjs";

describe("host-resume-matrix — the cursor row", () => {
  const cursor = HOSTS.find((h) => h.host === "cursor");

  it("is part of the same host table as the other CLIs", () => {
    assert.ok(cursor, "cursor must be probed by the same matrix");
    assert.equal(cursor.bin, "cursor-agent");
    assert.equal(cursor.headless, "cursor-agent -p <prompt>");
  });

  it("declares the documented flags, and marks fork unsupported", () => {
    assert.match("--continue", cursor.dims.continueLast);
    assert.match("--resume <chatId>", cursor.dims.resumeById);
    assert.match("-p, --print", cursor.dims.nonInteractive);
    assert.equal(cursor.dims.fork, null, "Cursor documents no fork flag; do not invent one");
  });

  it("blocks the e2e round trip when CURSOR_API_KEY is absent", () => {
    const saved = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      const result = e2eHost("cursor", 1_000);
      assert.equal(result.status, "blocked");
      assert.match(result.reason, /CURSOR_API_KEY/);
      assert.deepEqual(result.steps, []);
    } finally {
      if (saved !== undefined) process.env.CURSOR_API_KEY = saved;
    }
  });
});
