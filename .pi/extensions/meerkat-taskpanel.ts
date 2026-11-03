/**
 * The Pi extension — how Pi finds the board skill without a copy of it.
 *
 * Pi is a Shape-B agent kind: it loads a JS/TS module that exposes lifecycle callbacks, and it
 * runs the module *as written*. The root `package.json` declares both halves under `pi`:
 *
 *   "pi": { "skills": ["./skills"], "extensions": ["./.pi/extensions/meerkat-taskpanel.ts"] }
 *
 * so the skills path is declared there as well; this module re-registers the same
 * directory at runtime, which is what the reference implementation does
 * (`obra/superpowers` @ v7.0.0, `.pi/extensions/superpowers.ts`) and what keeps working
 * on a Pi build that discovers skills only through `resources_discover`.
 *
 * The `import type` is deliberately undeclared and never type-checked by this repository:
 * Pi supplies `ExtensionAPI` at load time. That is the reference's documented arrangement
 * (`docs/porting-to-a-new-harness.md` § "Build/dependency check") and it is why this file
 * costs the project no dependency. If Pi is ever changed to type-check or bundle plugin
 * sources, that check must be revisited deliberately — not answered by adding a devDep.
 *
 * The directory resolves from this file, so it follows the package wherever it is
 * installed: `resolve(<repo>/<.pi>/<extensions>, "../..")` is the package root, and its
 * `skills/` is the one tree.
 *
 * It also forwards `tool_call` to the installed worktree guard. A project opts in by
 * carrying `docs/agents/worktrees.md`; everywhere else the CLI's policy allows the call.
 * The guard is a guardrail, not a sandbox — Pi has none of its own.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillsDir = resolve(packageRoot, "skills");
const cliEntry = resolve(packageRoot, "src", "cli", "index.mjs");

export default function meerkatTaskpanelPiExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", async () => ({ skillPaths: [skillsDir] }));

  pi.on("tool_call", async (event) => {
    const payload = JSON.stringify({
      toolName: event.toolName,
      input: event.input,
      cwd: process.cwd(),
    });
    const result = spawnSync(process.execPath, [cliEntry, "worktree", "guard", "--runtime", "pi"], {
      input: payload,
      encoding: "utf8",
      timeout: 10_000,
    });
    // A broken CLI must not brick the session; the guard fails open on purpose.
    if (result.error !== undefined || result.status !== 0) return undefined;
    try {
      const decision = JSON.parse(result.stdout);
      return decision.block === true ? { block: true, reason: decision.reason } : undefined;
    } catch {
      return undefined;
    }
  });
}
