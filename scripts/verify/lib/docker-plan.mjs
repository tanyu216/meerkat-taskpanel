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
 * @param {string} [ctx] build context; the repository root by default
 * @returns {string[]}
 */
export function buildArgs(ctx = ".") {
  return ["build", "-f", "docker/Dockerfile", "-t", imageTag(), ctx];
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

/** @returns {string[]} `docker compose up -d --build` */
export function composeUpArgs() {
  return ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build"];
}

/** @returns {string[]} `docker compose down -v` */
export function composeDownArgs() {
  return ["compose", "-f", COMPOSE_FILE, "down", "-v"];
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
