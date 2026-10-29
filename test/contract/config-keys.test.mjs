/**
 * The configuration inventory is `.env.example` at the repository root
 * (`docs/tech-spec.md`, configuration rules).
 *
 * A key the application reads but the inventory omits is a defect, and a key the
 * inventory lists that nothing reads is dead configuration. Read from the files —
 * never from the loader — so this is a genuine second opinion. The declared key
 * groups live in `src/foundation/constants.mjs`; the two installer templates ship
 * a *subset* of them and must not drift past the inventory either way.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { ALL_CONFIG_KEYS, CONFIG_KEY_GROUPS } from "../../src/foundation/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INVENTORY = resolve(ROOT, ".env.example");
const TEMPLATES = [
  resolve(ROOT, "scripts/install/templates/env.example"),
  resolve(ROOT, "scripts/install/templates/agent/meerkat-taskpanel.env"),
];

/** A key line: `KEY=` or `# KEY=`, inside this project's namespaces only. */
const KEY_LINE = /^(#\s*)?((?:TASKD|TASKCTL|MEERKAT_TASKPANEL)_[A-Z0-9_]+)\s*=/;
/** A bare key name, as the constants declare it. */
const KEY_NAME = /^(?:TASKD|TASKCTL|MEERKAT_TASKPANEL)_[A-Z0-9_]+$/;

/**
 * Keys named by a config file, in document order.
 *
 * `active` is false for a commented key (the inventory's documentation form);
 * `documented` is true when the nearest non-blank line above the key is a
 * description comment rather than another key.
 */
function readKeys(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = KEY_LINE.exec(lines[index].trim());
    if (!match) continue;
    let above = index - 1;
    while (above >= 0 && lines[above].trim() === "") above -= 1;
    const documented =
      above >= 0 &&
      lines[above].trim().startsWith("#") &&
      !KEY_LINE.test(lines[above].trim());
    entries.push({
      key: match[2],
      active: match[1] === undefined,
      documented,
      line: index + 1,
    });
  }
  return entries;
}

const inventoryText = await readFile(INVENTORY, "utf8").catch(() => null);

describe("contract/config-keys — the declared key groups", () => {
  it("declares every group as a non-empty frozen list with no duplicates across groups", () => {
    const names = Object.keys(CONFIG_KEY_GROUPS);
    assert.ok(names.length >= 4, `expected the shared, loop, locator and shim groups, got ${names}`);
    const seen = new Map();
    for (const [group, keys] of Object.entries(CONFIG_KEY_GROUPS)) {
      assert.ok(keys.length > 0, `group ${group} is empty`);
      for (const key of keys) {
        assert.match(key, KEY_NAME, `${group} carries a non-key literal: ${key}`);
        if (seen.has(key)) {
          assert.ok(
            ["TASKCTL_AGENT", "TASKCTL_HUMAN", "MEERKAT_TASKPANEL_REPO"].includes(key),
            `${key} is declared in both ${seen.get(key)} and ${group}`,
          );
        }
        seen.set(key, group);
      }
    }
    assert.deepEqual(
      [...new Set(ALL_CONFIG_KEYS)].sort(),
      [...ALL_CONFIG_KEYS].sort(),
      "ALL_CONFIG_KEYS carries a duplicate",
    );
  });
});

describe("contract/config-keys — .env.example", () => {
  it("exists at the repository root", () => {
    assert.ok(inventoryText !== null, `${INVENTORY} is missing`);
  });

  it("names every key the application reads", () => {
    const named = new Set(readKeys(inventoryText ?? "").map((entry) => entry.key));
    const missing = ALL_CONFIG_KEYS.filter((key) => !named.has(key));
    assert.deepEqual(missing, [], `not named in .env.example: ${missing.join(", ")}`);
  });

  it("lists no key the application does not read", () => {
    const declared = new Set(ALL_CONFIG_KEYS);
    const extra = readKeys(inventoryText ?? "")
      .map((entry) => entry.key)
      .filter((key) => !declared.has(key));
    assert.deepEqual(extra, [], `listed but never read: ${extra.join(", ")}`);
  });

  it("documents every key with a comment line and never repeats one", () => {
    const entries = readKeys(inventoryText ?? "");
    const undocumented = entries.filter((entry) => !entry.documented);
    assert.deepEqual(
      undocumented.map((entry) => `${entry.key} (line ${entry.line})`),
      [],
      "each key needs a purpose comment above it",
    );
    const counts = new Map();
    for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
    const repeated = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
    assert.deepEqual(repeated, [], "a key is listed twice");
  });
});

describe("contract/config-keys — the installer templates", () => {
  it("ship only keys the inventory names", async () => {
    const declared = new Set(ALL_CONFIG_KEYS);
    for (const path of TEMPLATES) {
      const text = await readFile(path, "utf8");
      const stray = readKeys(text)
        .filter((entry) => entry.active)
        .map((entry) => entry.key)
        .filter((key) => !declared.has(key));
      assert.deepEqual(stray, [], `${path} ships an uninventoried key: ${stray.join(", ")}`);
    }
  });
});
