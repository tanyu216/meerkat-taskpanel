/**
 * Step 11: the dictionary resolver (card A9, V8).
 *
 * The rules are the whole point: reuse on an exact hit, reuse on a *unique*
 * fuzzy hit, refuse on ambiguity (never guess), and let `--force-create` bypass
 * only the fuzzy step.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  dictionaryEntryFromRow,
  dictionaryEntryToRow,
  isDictionaryKind,
  normalizeName,
  resolveDictionaryEntry,
} from "../../../src/core/domain/dictionary.mjs";
import { DICTIONARY_KINDS } from "../../../src/core/domain/enums.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

const entry = (id, displayName, kind = "agent") => ({
  id,
  kind,
  displayName,
  normalizedName: normalizeName(displayName),
});

const EXISTING = [entry("as1", "Linus"), entry("as2", "Linus Torvalds"), entry("as3", "Ada"), entry("rp1", "Terry", "human")];

describe("domain/dictionary — name normalisation", () => {
  it("folds NFKC, case and whitespace", () => {
    assert.equal(normalizeName("  Linus   Torvalds "), "linus torvalds");
    assert.equal(normalizeName("ＴＥＲＲＹ"), "terry", "full-width folds to ASCII");
    assert.equal(normalizeName("LiNuS"), "linus");
    assert.equal(normalizeName("a\t\nb"), "a b");
  });

  it("refuses a name that cannot identify anybody", () => {
    for (const bad of ["", "   ", "\t\n"]) {
      assert.throws(() => normalizeName(bad), (err) => {
        assert.equal(err.code, "DICTIONARY_INVALID");
        assert.equal(err.http, 422);
        return true;
      });
    }
    assert.throws(() => normalizeName(null), (err) => err.code === "DICTIONARY_INVALID");
    assert.throws(() => normalizeName(42), DomainError);
  });

  it("knows the two kinds it can hold", () => {
    assert.deepEqual([...DICTIONARY_KINDS], ["assignee", "reporter"]);
    assert.equal(isDictionaryKind("assignee"), true);
    assert.equal(isDictionaryKind("reviewer"), false);
  });
});

describe("domain/dictionary — resolution", () => {
  it("reuses on an exact hit, ignoring case and spacing", () => {
    for (const raw of ["Linus", "linus", "  LINUS  "]) {
      const verdict = resolveDictionaryEntry(EXISTING, raw, { kind: "agent" });
      assert.equal(verdict.action, "reuse", raw);
      assert.equal(verdict.entry.id, "as1");
      assert.equal(verdict.displayName, "Linus");
      assert.equal(verdict.normalizedName, "linus");
    }
  });

  it("reuses on a unique prefix or substring", () => {
    assert.equal(resolveDictionaryEntry(EXISTING, "Ada", { kind: "agent" }).entry.id, "as3");
    assert.equal(resolveDictionaryEntry(EXISTING, "Ada Lovelace", { kind: "agent" }).action, "create");
    assert.equal(resolveDictionaryEntry(EXISTING, "orvald", { kind: "agent" }).entry.id, "as2", "substring");
    assert.equal(resolveDictionaryEntry(EXISTING, "Torv", { kind: "agent" }).entry.id, "as2");
  });

  it("refuses to guess when several entries match", () => {
    const three = [entry("a", "Linus"), entry("b", "Linus Torvalds"), entry("c", "Linus Pauling")];
    assert.throws(() => resolveDictionaryEntry(three, "lin", { kind: "agent" }), (err) => {
      assert.equal(err.code, "DICTIONARY_AMBIGUOUS");
      assert.equal(err.http, 409);
      assert.deepEqual(
        err.details.candidates.map((c) => c.id),
        ["a", "b", "c"],
      );
      assert.match(err.hint.fix, /force-create/);
      return true;
    });
  });

  it("creates a new entry when nothing matches", () => {
    const verdict = resolveDictionaryEntry(EXISTING, "Grace Hopper", { kind: "agent" });
    assert.equal(verdict.action, "create");
    assert.equal(verdict.entry, undefined);
    assert.equal(verdict.displayName, "Grace Hopper");
    assert.equal(verdict.normalizedName, "grace hopper");
    assert.equal(resolveDictionaryEntry([], "Anyone", { kind: "human" }).action, "create");
  });

  it("forceCreate bypasses the fuzzy step but never the exact one", () => {
    const three = [entry("a", "Linus"), entry("b", "Linus Torvalds"), entry("c", "Linus Pauling")];
    assert.equal(resolveDictionaryEntry(three, "lin", { kind: "agent", forceCreate: true }).action, "create");
    assert.equal(
      resolveDictionaryEntry(three, "Linus", { kind: "agent", forceCreate: true }).action,
      "reuse",
      "an exact hit is still reused",
    );
    assert.equal(
      resolveDictionaryEntry(three, "linus torvalds", { kind: "agent", forceCreate: true }).entry.id,
      "b",
      "an exact hit among fuzzy siblings still wins",
    );
  });

  it("isolates the kinds: an agent and a human may share a name", () => {
    assert.equal(resolveDictionaryEntry(EXISTING, "Terry", { kind: "human" }).entry.id, "rp1");
    assert.equal(resolveDictionaryEntry(EXISTING, "Terry", { kind: "agent" }).action, "create");
    assert.equal(resolveDictionaryEntry(EXISTING, "Linus", { kind: "human" }).action, "create");
  });

  it("refuses an unknown kind and tolerates a missing list", () => {
    assert.throws(() => resolveDictionaryEntry([], "x", { kind: "reviewer" }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.deepEqual(err.details.allowed, ["agent", "human"]);
      return true;
    });
    assert.equal(resolveDictionaryEntry(undefined, "New", { kind: "agent" }).action, "create");
  });

  it("refuses duplicate rows in the input rather than picking one", () => {
    const duplicated = [entry("a", "Linus"), entry("b", "Linus")];
    assert.throws(() => resolveDictionaryEntry(duplicated, "Linus", { kind: "agent" }), (err) => {
      assert.equal(err.code, "DICTIONARY_AMBIGUOUS");
      return true;
    });
  });
});

describe("domain/dictionary — row mapping", () => {
  it("round-trips an entry through a row", () => {
    const row = {
      id: "as1",
      kind: "agent",
      display_name: "Linus",
      normalized_name: "linus",
      platform: "claude",
      first_seen_at: "2026-10-01T00:00:00.000Z",
      last_seen_at: "2026-10-08T00:00:00.000Z",
      use_count: 3,
    };
    const mapped = dictionaryEntryFromRow(row);
    assert.equal(mapped.displayName, "Linus");
    assert.equal(mapped.useCount, 3);
    assert.deepEqual(dictionaryEntryToRow(mapped), row);
    assert.equal(dictionaryEntryFromRow(null), null);
  });
});
