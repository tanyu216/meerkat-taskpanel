/**
 * `taskctl status` — where the board `taskctl` talks to is, and whether it is up.
 *
 * It is a **local read**, not a command sent to the board: it reads the runtime
 * pointer, asks `/health`, and prints the answer. That is why it is a top-level
 * command rather than `taskd status` — `taskd` is the server process, and this
 * command does not control it, does not need a token, and does not start one.
 * It is also why it needs no `--actor-kind`: nothing is written, so there is no
 * author to name.
 *
 * Exit code 0 even when the board is not running. "The board is down" is the
 * answer the caller asked for, not a failure of the question — a supervisor that
 * is deciding whether to wake the board must be able to read it without treating
 * `status` itself as broken.
 *
 * The pointer never carries a token (`runtime-pointer.mjs` refuses one), and
 * this command reports only `pointer`/`data_dir`/`pid`/`url`/`running` — the
 * token file path is deliberately not part of the shape.
 */

import { CONTRACT_SCHEMA_VERSION, VERSION } from "../../foundation/constants.mjs";
import { resolveDataDir, resolveRuntimePointerPath } from "../../foundation/runtime-locator.mjs";
import { probeHealth, readPointer } from "../../foundation/transport/runtime.mjs";

/** A non-empty string, or `null` — the pointer's fields are optional by contract. */
function textOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Is `pid` a live process? `process.kill(pid, 0)` sends no signal; it only asks
 * the OS. `EPERM` means the process exists but belongs to someone else — alive,
 * which is the question.
 *
 * Deliberately local rather than `core/storage/writer-lock.mjs#isProcessAlive`:
 * the CLI may not import `core/storage` (it would drag `node:sqlite` in), and
 * this is the whole of what the read needs.
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * The `--json` payload. One construction, read by the CLI contract checker so
 * the frozen keys and the live ones cannot drift.
 *
 * @param {{pointer: string|null, data_dir: string, pid: number|null, url: string|null, running: boolean, note: string|null}} runtime
 */
export function statusPayload(runtime) {
  return {
    runtime,
    version: VERSION,
    schema_version: CONTRACT_SCHEMA_VERSION,
  };
}

/** A probe runtime for the contract checker — the shape, never a real board. */
export const STATUS_RUNTIME_PROBE = Object.freeze({
  pointer: null,
  data_dir: "/probe",
  pid: null,
  url: null,
  running: false,
  note: null,
});

function humanReport(runtime) {
  const lines = [`board: ${runtime.running ? "running" : "not running"}`];
  if (runtime.url !== null) lines.push(`  url:     ${runtime.url}`);
  lines.push(`  data:    ${runtime.data_dir}`);
  if (runtime.pid !== null) lines.push(`  pid:     ${runtime.pid}`);
  if (runtime.pointer !== null) lines.push(`  pointer: ${runtime.pointer}`);
  if (runtime.note !== null) lines.push(`  note:    ${runtime.note}`);
  return lines.join("\n");
}

export const COMMANDS = [
  {
    name: "status",
    summary: "Report the board this taskctl talks to: pointer, data dir, pid, url and whether it answers.",
    usage: "status [--url <url>]",
    // Runs before the identity check and before any board is contacted; see
    // `src/cli/index.mjs`. A `local` command receives no client and no token.
    local: true,
    positionals: [],
    flags: [],
    async run(ctx) {
      const env = ctx.env ?? process.env;
      const explicitUrl = textOrNull(ctx.flags.url);
      const expectedPointer = resolveRuntimePointerPath({ env });
      // `--url` is a pin: report and probe exactly that address, and do not
      // consult (or fall back to) the runtime pointer.
      const pointer = explicitUrl === null ? readPointer({ env }) : null;
      const recordedPid = Number.isInteger(pointer?.pid) ? pointer.pid : null;
      const pidAlive = isProcessAlive(recordedPid);
      const url = explicitUrl ?? textOrNull(pointer?.url);
      const running = url !== null && (await probeHealth(url));

      /** @type {string[]} */
      const notes = [];
      if (explicitUrl === null && pointer === null) {
        notes.push(`no readable runtime pointer at ${expectedPointer}; the board is not running`);
      } else if (explicitUrl === null && url === null) {
        notes.push("the runtime pointer names no board URL");
      }
      if (recordedPid !== null && !pidAlive) notes.push(`pointer names pid ${recordedPid}, which is gone (stale pointer)`);

      const runtime = {
        pointer: explicitUrl !== null ? null : textOrNull(pointer?.path),
        data_dir: textOrNull(pointer?.dataDir) ?? resolveDataDir({ env }),
        pid: recordedPid,
        url,
        running,
        note: notes.length === 0 ? null : notes.join("; "),
      };
      return { data: statusPayload(runtime), human: humanReport(runtime) };
    },
  },
];
