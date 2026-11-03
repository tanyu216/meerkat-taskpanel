/**
 * Git ref probes shared by the loop's workspace module and the local project
 * map.
 *
 * Every function takes an injected `run`; this module never spawns a process.
 * The caller owns the process boundary and its error vocabulary. The exit-code
 * distinction is load-bearing: `rev-parse --verify --quiet` exits 1 for an
 * absent ref, but 128 when git could not answer at all (not a repository, a
 * broken checkout). An absent ref may fall back; an unprobeable one must never
 * be treated as absent — that would let a transient git failure delete a live
 * workspace record or accept a broken project rule.
 */

/**
 * Probe a commit-ish ref.
 *
 * @param {{projectDir: string, ref: string, run: Function}} input
 * @returns {{ok: true, exists: boolean} |
 *   {ok: false, reason: "empty" | "unavailable" | "unresolvable", stderr?: string}}
 */
export function probeGitRef({ projectDir, ref, run }) {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (value === "") return { ok: false, reason: "empty" };
  const result = run("git", [
    "-C",
    String(projectDir),
    "rev-parse",
    "--verify",
    "--quiet",
    `${value}^{commit}`,
  ]);
  if (result === null) return { ok: false, reason: "unavailable" };
  if (result.status === 0) return { ok: true, exists: true };
  if (result.status === 1) return { ok: true, exists: false };
  return {
    ok: false,
    reason: "unresolvable",
    stderr: String(result.stderr ?? "").trim(),
  };
}

/**
 * Probe a local branch. `merge_ref` must name one: a tag or a raw commit is not
 * a branch a lane can be merged into.
 *
 * @param {{projectDir: string, ref: string, run: Function}} input
 * @returns {{ok: true, exists: boolean} |
 *   {ok: false, reason: "empty" | "unavailable" | "unresolvable", stderr?: string}}
 */
export function probeLocalBranch({ projectDir, ref, run }) {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (value === "") return { ok: false, reason: "empty" };
  const result = run("git", [
    "-C",
    String(projectDir),
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${value}`,
  ]);
  if (result === null) return { ok: false, reason: "unavailable" };
  if (result.status === 0) return { ok: true, exists: true };
  if (result.status === 1) return { ok: true, exists: false };
  return {
    ok: false,
    reason: "unresolvable",
    stderr: String(result.stderr ?? "").trim(),
  };
}

/**
 * The project directory's current branch. A detached HEAD is refused: merging a
 * lane into a detached checkout would leave the work unreachable.
 *
 * @param {{projectDir: string, run: Function}} input
 * @returns {{ok: true, ref: string} | {ok: false, reason: "unreadable" | "detached"}}
 */
export function readCurrentBranch({ projectDir, run }) {
  const result = run("git", ["-C", String(projectDir), "rev-parse", "--abbrev-ref", "HEAD"]);
  if (result === null || result.status !== 0) {
    return { ok: false, reason: "unreadable" };
  }
  const ref = String(result.stdout ?? "").trim();
  if (ref === "" || ref === "HEAD") return { ok: false, reason: "detached" };
  return { ok: true, ref };
}
