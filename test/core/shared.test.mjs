/**
 * Step 1 contract tests: the shared error vocabulary, redaction, and constants.
 *
 * These are the seams every other core module depends on: if a code is missing
 * from the buckets, or a token is not redacted on the way out, no amount of
 * downstream testing helps. Pure — no database, no temp files.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  ARCHIVE_AFTER_DAYS,
  DB_FILENAME,
  DB_PATH_ENV,
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  HEARTBEAT_FRESH_MS,
  MD_GROWTH_FACTOR,
  REPORT_MAX_BYTES,
  REPORT_MAX_ITEMS,
  SESSION_ID_NAMESPACE,
  TOKEN_FILENAME,
  TOKEN_PREFIX,
} from "../../src/shared/constants.mjs";
import {
  DB_RAISE_CODES,
  DomainError,
  ERROR_CODES,
  JS_ONLY_CODES,
  SQL_CONSTRAINT_CODES,
  isDomainError,
  toErrorPayload,
} from "../../src/shared/errors.mjs";
import {
  REDACTED_TOKEN,
  redactDeep,
  redactText,
  redactToken,
} from "../../src/shared/redact.mjs";

const TOKEN = `td_${"a1b2c3d4".repeat(8)}`;

describe("shared/errors", () => {
  it("every code carries an http status and a message", () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      assert.equal(typeof entry.http, "number", `${code}.http`);
      assert.ok(entry.http >= 200 && entry.http < 600, `${code}.http in range`);
      assert.equal(typeof entry.message, "string", `${code}.message`);
      assert.ok(entry.message.length > 0, `${code}.message non-empty`);
    }
  });

  it("the three buckets partition ERROR_CODES exactly", () => {
    const buckets = [...DB_RAISE_CODES, ...SQL_CONSTRAINT_CODES, ...JS_ONLY_CODES];
    const declared = Object.keys(ERROR_CODES).sort();
    assert.deepEqual([...buckets].sort(), declared, "buckets must cover exactly the code set");
    assert.equal(new Set(buckets).size, buckets.length, "no code may live in two buckets");
  });

  it("the delivery gate code carries a repair hint naming the deliver command", () => {
    const err = new DomainError("REPORT_REQUIRED", { details: { round: 2 } });
    assert.equal(err.http, 422);
    assert.deepEqual(err.details, { round: 2 });
    assert.match(err.hint.command, /issue deliver/);
  });

  it("unknown codes are a programming error, not a runtime error", () => {
    assert.throws(() => new DomainError("NOPE_NOT_A_CODE"), TypeError);
  });

  it("DomainError redacts tokens in messages, details and hints", () => {
    const err = new DomainError("VALIDATION_FAILED", {
      message: `failed with ${TOKEN}`,
      details: { token: TOKEN, nested: { header: `Bearer ${TOKEN}` }, round: 1 },
      hint: { command: `taskctl x --token ${TOKEN}` },
    });
    assert.ok(!err.message.includes(TOKEN), "message leaks");
    assert.equal(err.details.token, REDACTED_TOKEN, "secret-named key is blanked");
    assert.ok(!JSON.stringify(err.details).includes(TOKEN), "details leak");
    assert.ok(!JSON.stringify(err.hint).includes(TOKEN), "hint leaks");
    assert.equal(JSON.parse(JSON.stringify(err)).code, "VALIDATION_FAILED");
  });

  it("isDomainError / toErrorPayload handle foreign errors", () => {
    const foreign = new TypeError("boom");
    assert.equal(isDomainError(foreign), false);
    assert.equal(isDomainError(new DomainError("NOT_FOUND")), true);
    const payload = toErrorPayload(foreign);
    assert.equal(payload.code, "VALIDATION_FAILED");
    assert.equal(payload.http, 500);
    assert.equal(toErrorPayload(new DomainError("NOT_FOUND")).http, 404);
  });
});

describe("shared/redact", () => {
  it("redacts a canonical token wherever it appears", () => {
    assert.equal(redactToken(TOKEN), REDACTED_TOKEN);
    assert.equal(redactText(`Authorization: Bearer ${TOKEN}`), `Authorization: Bearer ${REDACTED_TOKEN}`);
    assert.equal(redactText(`url?token=${TOKEN}&x=1`), `url?token=${REDACTED_TOKEN}&x=1`);
    assert.equal(redactText(`at Error\n  at f (${TOKEN})`), "at Error\n  at f (td_****)");
  });

  it("redacts token-shaped near-misses too, and leaves ordinary text alone", () => {
    assert.equal(redactText("td_0123456789abcdef0123"), REDACTED_TOKEN);
    assert.equal(redactText("td_short"), "td_short", "too short to be a token");
    assert.equal(redactText("nothing secret here"), "nothing secret here");
    assert.equal(redactText(null), null);
    assert.equal(redactToken(42), 42);
  });

  it("redactDeep walks objects, arrays and cycles", () => {
    const cyclic = { token: TOKEN, list: [TOKEN, { note: `x ${TOKEN} y` }] };
    cyclic.self = cyclic;
    const out = redactDeep(cyclic);
    assert.equal(out.token, REDACTED_TOKEN);
    assert.equal(out.list[0], REDACTED_TOKEN);
    assert.equal(out.list[1].note, `x ${REDACTED_TOKEN} y`);
    assert.equal(JSON.stringify(out.self).includes(TOKEN), false, "cycle leaks");
  });
});

describe("shared/constants", () => {
  it("pins the values the plan fixed (F8 / D10 / §3.9)", () => {
    assert.equal(DEFAULT_DATA_DIR, ".data");
    assert.equal(DB_FILENAME, "board.sqlite");
    assert.equal(DB_PATH_ENV, "TASKD_DB");
    assert.equal(TOKEN_FILENAME, "token");
    assert.equal(TOKEN_PREFIX, "td_");
    assert.equal(DEFAULT_PORT, 9527);
    assert.equal(HEARTBEAT_FRESH_MS, 600_000);
    assert.equal(ARCHIVE_AFTER_DAYS, 7);
    assert.equal(MD_GROWTH_FACTOR, 4);
    assert.equal(REPORT_MAX_BYTES, 65_536);
    assert.equal(REPORT_MAX_ITEMS, 64);
    assert.match(SESSION_ID_NAMESPACE, /^[0-9a-f-]{36}$/);
  });
});
