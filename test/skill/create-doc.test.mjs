/**
 * Creating a card, as the installed skill states it.
 *
 * A create is the moment two things are decided and neither used to be written down:
 *
 *   1. the card is **queued by the create itself** — `issue create` defaults to
 *      `todo`, the only claimable status, so there is no release step and nothing
 *      to poll. Without this the skill leaves a model asking whether to start.
 *   2. a plan that already exists is an **attachment**, not description prose —
 *      `issue create` carries no `--file`, so `attachment add` is the second call.
 *      The brief lists attachments; a pasted plan reaches the worker as neither.
 *
 * The page is the decision manual, so the test pins decisions rather than
 * sentences: the section exists before the claim workflow, it names the queue and
 * the second call, and it sends the human one line back. Command facts stay in
 * `references/cli.md`, which has to say the same second-call thing.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { readFrontmatterField } from "../../scripts/verify/lib/frontmatter.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = readFileSync(join(ROOT, "skills/meerkat/SKILL.md"), "utf8");
const CLI = readFileSync(join(ROOT, "skills/meerkat/references/cli.md"), "utf8");

/** The text of one `##` section, up to the next `##` heading. */
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `the skill has no "## ${heading}" section`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

describe("board skill: creating a card", () => {
  const create = section(SKILL, "Creating a card");

  it("keeps the section ahead of the claim workflow", () => {
    assert.ok(
      SKILL.indexOf("## Creating a card") < SKILL.indexOf("## Claim one card"),
      "creation is read before claiming — the order a reader works in",
    );
  });

  it("says the create itself queues the card in todo", () => {
    assert.match(create, /issue create/);
    assert.match(create, /`todo`/, "the default status is named");
    assert.match(create, /queue/i, "the queue is what the card lands in");
    assert.match(create, /backlog/, "the one deliberate exception is named");
  });

  it("attaches an existing document right after the create", () => {
    assert.match(create, /attachment add <ref> --file/, "the second call is spelled out");
    assert.match(create, /--name plan\.md/, "the plan is stored under its one fixed name");
    assert.match(create, /create has no .{0,3}--file/, "why it is a second call");
    assert.match(create, /not retyped|rather than (?:a )?retype/i, "a plan is not re-typed");
    assert.match(create, /--description/, "the wrong channel is named so it can be refused");
  });

  it("treats pointing at a file as the instruction, not a request to upload", () => {
    // A human says "the doc is at … , read it closely", not "attach it". The trigger is
    // the pointer, because a path named only in the conversation reaches no worker.
    assert.match(create, /points at a file/i);
    assert.match(create, /nobody says .{0,3}upload it/i);
    assert.match(create, /never this conversation|reads the card/i);
  });

  it("keeps the offer inside the conversation instead of scanning the tree", () => {
    assert.match(create, /named without a path/i);
    assert.match(create, /never go hunting|nobody named/i, "no scan for an unnamed document");
  });

  it("reports the outcome in one line and does not ask whether to start", () => {
    assert.match(create, /one line/i);
    assert.match(create, /identifier/);
    assert.match(create, /queued|已排队/);
    assert.match(create, /do not ask whether to start/i);
  });

  it("reaches the trigger surface: the description names the attachment", () => {
    const description = readFrontmatterField(SKILL, "description");
    assert.match(description, /attachment/i, "a plan-bearing create is a trigger, not a side note");
  });

  it("gates --as-human on a human conversation or an explicit human instruction", () => {
    // The two triggers are alternatives, not a conjunction: either talking to
    // the human, or a create that explicitly carries their instruction (even
    // from a handoff). The anti-triggers keep the loop's and the agent's own
    // cards out of the human's name.
    assert.match(create, /interactive session with the human/i, "the conversational trigger is named");
    assert.match(
      create,
      /,\s*or\s+when the instruction to create this card comes explicitly from them/i,
      "the explicit-instruction trigger is joined with `or`, not `and`",
    );
    assert.match(create, /either one is enough/i, "one trigger suffices");
    assert.match(create, /loop handoff/i, "the loop's own execution is an anti-trigger");
    assert.match(create, /card brief/i);
    assert.match(create, /file a card yourself|decide to file/i, "a self-initiated card outside a conversation");
    assert.match(create, /claim, heartbeat, delivery or review/i, "the agent's own writes are excluded");
    assert.match(create, /--reporter <name>/, "the fallback is named");
  });
});

describe("board skill: cli.md states the second call", () => {
  it("uploads a pre-existing file immediately after the create", () => {
    assert.match(CLI, /after `issue create`/);
    assert.match(CLI, /has no `--file`/);
  });
});
