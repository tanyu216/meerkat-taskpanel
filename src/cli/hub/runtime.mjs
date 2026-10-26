/**
 * Compatibility shim.
 *
 * The hub's path/protocol/start helpers live in
 * `src/foundation/hub-client.mjs`; the generic owner-only file, pid and lock
 * primitives live in `src/foundation/daemon-state.mjs`. Both are re-exported
 * here for the CLI hub server, commands and tests that imported them from this
 * module first.
 */

export {
  HUB_IDLE_MS,
  HUB_PROTOCOL,
  HUB_START_TIMEOUT_MS,
  ensureHub,
  hubCall,
  hubDir,
  hubHealthy,
  hubKey,
  hubPaths,
  logTail,
  newHubToken,
} from "../../foundation/hub-client.mjs";

export {
  acquireLock,
  ensurePrivateDir as ensureHubDir,
  lockIsStale,
  pidAlive,
  readJsonFile,
  releaseLock,
  removeFile,
  writeJsonFile,
} from "../../foundation/daemon-state.mjs";
