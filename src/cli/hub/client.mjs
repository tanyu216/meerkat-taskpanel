/**
 * Compatibility shim: the hub's client protocol now lives in
 * `src/foundation/hub-client.mjs`, so the loop orchestrator can register brief
 * watches without importing the CLI layer.
 *
 * Re-exported here for the CLI's existing importers and tests.
 */

export { hubAnswer, hubError, hubRecords } from "../../foundation/hub-client.mjs";
