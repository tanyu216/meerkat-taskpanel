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
const CLI = readFileSync(join(ROOT, "skills/meerkat/references/cli/files.md"), "utf8");

/** The text of one `##` section, up to the next `##` heading. */
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `the skill has no "## ${heading}" section`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

describe("board skill: creating a card", () => {
  const create = readFileSync(
    join(ROOT, "skills/meerkat/references/scenarios/create.md"),
    "utf8",
  );
  const epic = readFileSync(
    join(ROOT, "skills/meerkat/references/scenarios/epic.md"),
    "utf8",
  );

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

  it("routes a team card at creation instead of leaving it unowned", () => {
    // The root of the loop defect: `issue create` is the handoff, but the canonical
    // examples left the assignee off, so every card landed in the public pool and no
    // role workflow could ever load. The create must read the role skill whose shapes
    // fit the work and name the one accountable role in the same call.
    assert.match(create, /role skill/i, "the role skill is the routing source at the create");
    assert.match(create, /SKILL\.md/, "the role workflow it is read from is named");
    assert.match(create, /--assignee <role>/, "the create carries the accountable role");
    assert.match(create, /--assignee-kind agent/, "…and its kind, so the dictionary records a role");
    assert.match(create, /unowned|not a handoff/i, "an unassigned team card is named as unowned");
    assert.match(create, /no role installed/i, "the no-team case is stated");
    assert.match(create, /invent|do not guess|private role name/i, "no role is invented without a guide");
  });

  it("discovers the project's card-creation guidance before choosing the word", () => {
    assert.match(create, /docs\/agents\/create-card\.md/, "the project document is named");
    assert.match(create, /taskctl project dir <id> --json/, "the working directory is resolved first");
    assert.match(create, /explicit instruction from the human\s+wins/i, "the human's word outranks the document");
    assert.match(create, /fallback when the mode is omitted/, "the unresolved card falls back to auto");
    assert.match(create, /never invent a project default/i, "the document is not a board default");
  });

  it("sets the stage marker at creation, because the reviewer rejects an unclassified card", () => {
    // The gap that cost TP-0033 a round: the marker is written by the creator or
    // the director's triage, but nothing at the create asked for it, so the card
    // reached a worker unclassified and the review rejected a green delivery.
    assert.match(create, /stage marker/i, "the marker is a create-time decision");
    assert.match(create, /product_change=none/, "no design input has its own value");
    assert.match(create, /design_stage/, "a design-consuming card carries the other");
    assert.match(create, /unclassified/i, "the missing case is named as a defect");
    assert.match(create, /epic or a review card|epic and a review card/i, "the exempt shapes are stated");
    assert.match(create, /--meta/, "the create call carries it");
  });

  it("ships this project's card-creation guidance", () => {
    const doc = readFileSync(join(ROOT, "docs/agents/create-card.md"), "utf8");
    for (const word of ["off", "auto", "human"]) {
      assert.match(doc, new RegExp("`" + word + "`"), `the document names ${word}`);
    }
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

  it("states the parallel build-and-test pattern with its landing precondition", () => {
    assert.match(epic, /## Epic patterns/, "the pattern section is present");
    assert.match(epic, /test-design/, "the test-design child is named");
    assert.match(epic, /test-execution/, "the execution child is named");
    assert.match(epic, /--type blocks/, "the dependency direction is spelled out");
    assert.match(epic, /land green with `dev` absent/i, "the split is only legal while test-design can land without the feature");
    assert.match(epic, /fold that work into `dev`|author and run the tests after `dev`/i, "the honest alternative is stated");
  });
});

describe("board skill: cli.md states the second call", () => {
  it("uploads a pre-existing file immediately after the create", () => {
    assert.match(CLI, /after `issue create`/);
    assert.match(CLI, /has no `--file`/);
  });
});
