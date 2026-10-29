/**
 * The review-card protocol: the loop creates a review card through the fields
 * the board *declares* (`--review-of` / `--review-round`), never by writing the
 * board's meta keys by hand.
 *
 * The distinction matters at the packaging boundary: `--meta review_of=…` only
 * happens to work because the board mirrors the meta key today. A declared
 * field is the toolkit's contract; a meta string is an implementation detail
 * the orchestrator should not know.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { reviewCreateArgs } from "../../src/orchestrator/board.mjs";
import { cleanupTempDirs, dataOf, withCli } from "../cli/helpers/cli-harness.mjs";

after(cleanupTempDirs);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const ACTION = Object.freeze({
  project_id: "demo",
  title: "Review DEMO-0001",
  description: "Review the delivery at DEMO-0001.",
  reviewer: "jobs",
  original_ref: "DEMO-0001",
  round: 1,
  target: "review:DEMO-0001:r1",
  idem: "loop-review|DEMO-0001|r1",
  acceptance: ["the thing works"],
});

const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

describe("the review-card protocol", () => {
  it("uses the board's declared fields, not the meta escape hatch", () => {
    const args = reviewCreateArgs(ACTION);
    assert.ok(args.includes("--review-of"), JSON.stringify(args));
    assert.equal(flagValue(args, "--review-of"), "DEMO-0001");
    assert.ok(args.includes("--review-round"));
    assert.equal(flagValue(args, "--review-round"), "1");
    assert.equal(
      args.some((arg) => /^review_(of|round)=/.test(arg)),
      false,
      `the board's meta keys must not be hand-written: ${JSON.stringify(args)}`,
    );
    // The one meta key that is genuinely the loop's own marker stays.
    assert.equal(flagValue(args, "--meta"), "flow=B");
    // The loop files in its own voice, never the human's: no reporter flag and
    // no --as-human, or an automated card would count as a leader event.
    assert.equal(
      args.some((arg) => arg === "--as-human" || arg.startsWith("--reporter")),
      false,
      `the loop must not file as the human: ${JSON.stringify(args)}`,
    );
  });

  it("carries no human voice anywhere in board.mjs's create argvs", () => {
    const source = readFileSync(join(ROOT, "src/orchestrator/board.mjs"), "utf8");
    assert.equal(
      /--as-human|--reporter/.test(source),
      false,
      "the workflow pass files review cards and fix children as the system, never the human",
    );
  });

  it("the argv the loop builds is accepted by the CLI and stamps both markers", async () => {
    await withCli(async (ctx) => {
      ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
      const original = dataOf(
        ctx.run(["issue", "create", "--project", "demo", "--title", "Original", "--json"]),
      );
      // A review card may only be created for an in_review original.
      dataOf(ctx.run(["issue", "move", original.task.identifier, "in_progress", "--json"]));
      dataOf(
        ctx.run(["issue", "deliver", original.task.identifier, "--report-file", "-", "--json"], {
          input: JSON.stringify({
            conclusion: "delivered",
            acceptance: [{ text: "a", status: "met", note: "evidence[1] — the commit" }],
            evidence: [
              { kind: "commit", sha: "abc1234" },
              { kind: "path", path: "x" },
            ],
          }),
        }),
      );
      const action = {
        ...ACTION,
        original_ref: original.task.identifier,
        target: `review:${original.task.identifier}:r1`,
        idem: `loop-review|${original.task.identifier}|r1`,
      };

      // Run as the loop does. The CLI harness otherwise injects `--as-human`,
      // which would give this card a human reporter and hide a regression.
      const created = dataOf(
        ctx.run([...reviewCreateArgs(action), "--json"], { actorKind: "taskd" }),
      );

      assert.equal(created.task.reporter, null, "an automated review card names no human");
      assert.equal(created.task.review_of_id, original.task.id);
      assert.equal(created.task.review_round, 1);
      assert.equal(created.task.meta.review_of, original.task.identifier);
      assert.equal(created.task.meta.review_round, 1);
      assert.equal(created.task.meta.flow, "B");
      assert.equal(created.task.assignee.display_name, "jobs");
      assert.deepEqual(created.task.meta.acceptance, ["the thing works"]);
    });
  });

  it("board.mjs carries no hand-written review meta key", () => {
    const source = readFileSync(join(ROOT, "src/orchestrator/board.mjs"), "utf8");
    assert.equal(
      /--meta",\s*`review_(of|round)=/.test(source),
      false,
      "the loop must create review cards through --review-of / --review-round",
    );
  });
});
