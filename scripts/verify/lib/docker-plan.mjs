import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * Argument builders for the container verification flow.
 *
 * Every function here is a pure constructor: it returns a fresh argument array and
 * touches nothing. `scripts/verify/docker.mjs` is the only place that actually spawns
 * docker, which keeps the invocation shape (and therefore the CI contract) testable
 * without a Docker daemon.
 *
 * No `shell: true` anywhere — arguments are always passed as arrays.
 */

/** Image built by `verify:docker` and by CI. */
const VERIFY_IMAGE = "meerkat-taskpanel:verify";

/** Image built by `docker compose` for the deploy smoke test. */
const COMPOSE_FILE = "docker/docker-compose.yml";

/** @returns {string} tag of the image used for in-container verification */
export function imageTag() {
  return VERIFY_IMAGE;
}

/**
 * `docker build` arguments.
 *
 * `pullFlag` is the builder's no-pull form (`--pull=false` or `--pull=never`,
 * resolved by `base-image.mjs`). It is supplied by the caller rather than baked
 * in because the flag's *type* differs between the legacy builder and BuildKit;
 * when the probe could not run, passing nothing is still safe — the base-image
 * preflight has already put the image in the local store, so Docker's default
 * `missing` policy has nothing to fetch.
 *
 * @param {string} [ctx] build context; the repository root by default
 * @param {{pullFlag?: string|null}} [options]
 * @returns {string[]}
 */
export function buildArgs(ctx = ".", options = {}) {
  const args = ["build", "-f", "docker/Dockerfile", "-t", imageTag()];
  if (options.pullFlag) args.push(options.pullFlag);
  return [...args, ctx];
}

/**
 * `docker image inspect` printing the image id.
 *
 * A non-zero exit is the daemon saying "not in the local store", which is exactly
 * the preflight's input — no separate `docker images` text parsing.
 *
 * @param {string} ref
 * @returns {string[]}
 */
export function imageInspectArgs(ref) {
  return ["image", "inspect", "--format", "{{.Id}}", ref];
}

/**
 * `docker pull` — the one explicit network access the preflight may perform.
 *
 * @param {string} ref
 * @returns {string[]}
 */
export function pullArgs(ref) {
  return ["pull", ref];
}

/**
 * `docker run` arguments for the full in-container suite.
 *
 * @param {string} [tag]
 * @returns {string[]}
 */
export function runVerifyInContainerArgs(tag = imageTag()) {
  return ["run", "--rm", tag, "bash", "docker/verify-in-container.sh"];
}

/** @returns {string} path to the compose file, relative to the repository root */
export function composeFile() {
  return COMPOSE_FILE;
}

/**
 * The compose project name for one checkout.
 *
 * **Why this exists.** `docker compose` derives the project name from the
 * *directory* when one is not given, and every worktree of this repository has a
 * directory called `docker/`. So two lanes running `verify:docker` at the same
 * time share the project name, the network `docker_default` and the container
 * `docker-taskd-1`: the second one to start fails with
 *
 *     Error response from daemon: Conflict. The container name "/docker-taskd-1"
 *     is already in use by container "…"
 *
 * and the two teardowns then fight over the same container (`removal of container
 * … is already in progress`). The red lands on whichever run started second, and
 * it is a flake produced by the gate's own naming — the two gates tested
 * different trees and neither was wrong.
 *
 * The name is derived from the checkout's **absolute path**, so it is
 * *stable for a checkout* (an `up` and the `down` that follows it agree) and
 * *different between checkouts* (concurrent runs do not touch each other). A hash,
 * because a compose project name must match `[a-z0-9][a-z0-9_-]*` and a path does
 * not.
 *
 * @param {string} projectDir the checkout root
 * @returns {string}
 */
export function composeProjectName(projectDir) {
  const digest = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 12);
  return `meerkat-taskpanel-${digest}`;
}

/**
 * `docker compose …`, with the project named explicitly.
 *
 * The `-p` is **required, not defaulted**: omitting it is exactly the collision
 * this module exists to prevent, and a default would silently restore it the day
 * someone adds a fourth caller.
 *
 * @param {string} project a name from `composeProjectName`
 * @returns {string[]}
 */
const composeArgs = (project) => {
  if (typeof project !== "string" || project === "") {
    throw new Error("a compose project name is required (see composeProjectName)");
  }
  return ["compose", "-p", project, "-f", COMPOSE_FILE];
};

/** @param {string} project @returns {string[]} `docker compose -p … up -d --build` */
export function composeUpArgs(project) {
  return [...composeArgs(project), "up", "-d", "--build"];
}

/** @param {string} project @returns {string[]} `docker compose -p … down -v` */
export function composeDownArgs(project) {
  return [...composeArgs(project), "down", "-v"];
}

/**
 * `docker compose -p … ps -q <service>` — the container id for a service.
 *
 * It carries the project for the same reason the others do, and it is the one
 * whose omission would be *silent*: `ps` against the wrong project prints nothing,
 * and the healthcheck that reads it would report "no container found" rather than
 * a collision.
 *
 * @param {string} project @param {string} service
 * @returns {string[]}
 */
export function composePsArgs(project, service) {
  return [...composeArgs(project), "ps", "-q", service];
}

/**
 * `docker inspect` arguments that print a container's health status.
 *
 * @param {string} container
 * @returns {string[]}
 */
export function healthInspectArgs(container) {
  return ["inspect", "--format", "{{.State.Health.Status}}", container];
}
