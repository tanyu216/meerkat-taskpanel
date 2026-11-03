/**
 * Creating a card, as the installed skill states it.
 *
 * A create is the moment three things are decided and none of them used to be written in one
 * place:
 *
 *   1. the card is **queued by the create itself** — `issue create` defaults to `todo`, the only
 *      claimable status, so there is no release step and nothing to poll.
 *   2. a plan that already exists is an **attachment**, not description prose —
 *      `issue create` carries no `--file`, so `attachment add` is the second call.
 *   3. the card's shape and closer are decisions, not defaults: an `epic` is a container, and
 *      the acceptance mode names who may close it.
 *
 * The decisions live in `references/create-card.md`; `SKILL.md` keeps the compact entry a reader
 * meets first. The project's own answers are a thin override in `docs/agents/create-card.md` —
 * never a second copy of the manual.
 *
 * Command facts stay in `references/cli.md`, which has to say the same second-call thing.
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
const CREATE = readFileSync(join(ROOT, "skills/meerkat/references/create-card.md"), "utf8");
const PROJECT = readFileSync(join(ROOT, "docs/agents/create-card.md"), "utf8");

/** The text of one `##` section, up to the next `##` heading. */
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `the manual has no "## ${heading}" section`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

describe("board skill: creating a card", () => {
  const entry = section(SKILL, "Creating a card");

  it("keeps the section ahead of the claim workflow", () => {
    assert.ok(
      SKILL.indexOf("## Creating a card") < SKILL.indexOf("## Claim one card"),
      "creation is read before claiming — the order a reader works in",
    );
  });

  it("says the create itself queues the card in todo", () => {
    assert.match(entry, /issue create/);
    assert.match(entry, /`todo`/, "the default status is named");
    assert.match(entry, /queue/i, "the queue is what the card lands in");
    assert.match(entry, /backlog/, "the one deliberate exception is named");
  });

  it("points the entry at the full manual", () => {
    assert.match(entry, /references\/create-card\.md/, "the manual is one hop away");
    assert.match(entry, /project dir <id> --json/, "the project's own rule is resolved first");
    assert.match(entry, /docs\/agents\/create-card\.md/, "the project page is named");
  });

  it("routes a team card at creation from the discovered role catalog", () => {
    // The root of the loop defect: `issue create` is the handoff, but the canonical
    // examples left the assignee off, so every card landed in the public pool and no
    // role workflow could ever load. The create must read the discovered catalog and
    // name the one accountable role in the same call.
    const routing = section(CREATE, "Routing: name the accountable role");
    assert.match(routing, /taskctl role list --json/, "the catalog read is the first step");
    assert.match(routing, /data\.roles\[\]\.agent/, "the assignee range is the catalog's agent names");
    assert.match(routing, /--assignee <role>/, "the create carries the accountable role");
    assert.match(routing, /--assignee-kind agent/, "…and its kind, so the dictionary records a role");
    assert.match(routing, /ASSIGNEE_NOT_IN_CATALOG/, "the out-of-range refusal is named");
    assert.match(routing, /--force-create/, "the escape is named");
    assert.match(routing, /unowned|not handed off/i, "an unassigned team card is named as unowned");
    assert.match(routing, /no role installed/i, "the no-team case is stated");
    assert.match(routing, /invent/i, "no role is invented without a guide");
  });

  it("discovers the project's create-card guidance before choosing a word", () => {
    const before = section(CREATE, "Before the create");
    const mode = section(CREATE, "Acceptance mode: who closes the card");
    assert.match(before, /docs\/agents\/create-card\.md/, "the project document is named");
    assert.match(before, /taskctl project dir <id> --json/, "the working directory is resolved first");
    assert.match(before, /explicit instruction from the human\s+wins/i, "the human's word outranks the document");
    assert.match(mode, /fallback when the mode is omitted/, "the unresolved card falls back to auto");
    assert.match(before, /never invent a project default/i, "the document is not a board default");
  });

  it("ships this project's card-creation guidance", () => {
    for (const word of ["off", "auto", "human"]) {
      assert.match(PROJECT, new RegExp("`" + word + "`"), `the project page names ${word}`);
    }
  });

  it("keeps the project page a thin override, not a second manual", () => {
    const lines = PROJECT.trimEnd().split("\n").length;
    assert.ok(lines <= 60, `the project page stays short (${lines} lines)`);
    assert.match(PROJECT, /references\/create-card\.md/, "the manual is named as its source");
    assert.match(PROJECT, /wins over/i, "what the page states outranks the manual");
    assert.match(PROJECT, /falls back/i, "an unstated topic inherits the manual");
    assert.doesNotMatch(
      PROJECT,
      /attachment add|role list --json|--as-human/,
      "the page records choices, not the create mechanics",
    );
  });

  it("discovers the project's epic guidance before splitting a container", () => {
    const before = section(CREATE, "Before the create");
    const epic = section(CREATE, "The epic decision: when work is a container");
    assert.match(before, /docs\/agents\/create-card\.md/, "the project document is named");
    assert.match(before, /explicit instruction from the human\s+wins/i, "the human's word outranks the document");
    assert.match(before, /taskctl project dir <id> --json/, "the working directory is resolved first");
    assert.match(before, /does not exist|absent|missing/i, "a missing document falls back to the board rules");
    assert.match(epic, /land on the base branch alone/i, "a child is sized by what can land alone");
  });

  it("states the parallel build-and-test pattern with its landing precondition", () => {
    const patterns = section(CREATE, "Epic patterns");
    assert.match(patterns, /test-design/, "the test-design child is named");
    assert.match(patterns, /test-execution/, "the execution child is named");
    assert.match(patterns, /--type blocks/, "the dependency direction is spelled out");
    assert.match(
      patterns,
      /land green with `dev` absent/i,
      "the split is only legal while test-design can land without the feature",
    );
    assert.match(
      patterns,
      /fold that work into `dev`|author and run the tests after `dev`/i,
      "the honest alternative is stated, not a phase split",
    );
  });

  it("attaches an existing document right after the create", () => {
    const attach = section(CREATE, "Attaching a document");
    assert.match(attach, /attachment add <ref> --file/, "the second call is spelled out");
    assert.match(attach, /--name plan\.md/, "the plan is stored under its one fixed name");
    assert.match(attach, /create has no .{0,3}--file/, "why it is a second call");
    assert.match(attach, /not retyped|rather than (?:a )?retype/i, "a plan is not re-typed");
    assert.match(attach, /--description/, "the wrong channel is named so it can be refused");
  });

  it("treats pointing at a file as the instruction, not a request to upload", () => {
    // A human says "the doc is at … , read it closely", not "attach it". The trigger is
    // the pointer, because a path named only in the conversation reaches no worker.
    const attach = section(CREATE, "Attaching a document");
    assert.match(attach, /points at a file/i);
    assert.match(attach, /nobody says .{0,3}upload it/i);
    assert.match(attach, /never this conversation|reads the card/i);
  });

  it("keeps the offer inside the conversation instead of scanning the tree", () => {
    const attach = section(CREATE, "Attaching a document");
    assert.match(attach, /named without a path/i);
    assert.match(attach, /never go hunting|nobody named/i, "no scan for an unnamed document");
  });

  it("reports the outcome in one line and does not ask whether to start", () => {
    const outcome = section(CREATE, "The one-line outcome");
    assert.match(outcome, /one line/i);
    assert.match(outcome, /identifier/);
    assert.match(outcome, /queued|已排队/);
    assert.match(outcome, /do not ask whether to start/i);
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
    const filing = section(CREATE, "Filing as the human");
    assert.match(filing, /interactive session with the human/i, "the conversational trigger is named");
    assert.match(
      filing,
      /,\s*or\s+when the instruction to create this card comes explicitly from them/i,
      "the explicit-instruction trigger is joined with `or`, not `and`",
    );
    assert.match(filing, /either one is enough/i, "one trigger suffices");
    assert.match(filing, /loop handoff/i, "the loop's own execution is an anti-trigger");
    assert.match(filing, /card brief/i);
    assert.match(filing, /file a card yourself|decide to file/i, "a self-initiated card outside a conversation");
    assert.match(filing, /claim, heartbeat, delivery or review/i, "the agent's own writes are excluded");
    assert.match(filing, /--reporter <name>/, "the fallback is named");
  });
});

describe("board skill: cli.md states the second call", () => {
  it("uploads a pre-existing file immediately after the create", () => {
    assert.match(CLI, /after `issue create`/);
    assert.match(CLI, /has no `--file`/);
  });
});
