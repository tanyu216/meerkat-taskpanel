/**
 * One `taskd` per data directory (R1).
 *
 * The design is single-writer: one process owns the SQLite file, and every
 * surface reaches it over loopback HTTP. Nothing enforced that. Two `taskd`
 * processes on the same `TASKD_DATA_DIR` produced two writers and, worse, a
 * *pointer* fight — both wrote the runtime pointer and either one removed it on
 * exit, so an exiting stranger could make the surviving board unreachable.
 *
 * The guard is the oldest one there is: a lock **file** created with `O_EXCL`
 * (`openSync(path, "wx")`). Creation is atomic, so exactly one process wins;
 * the loser reads the file, learns whose it is, and is refused.
 *
 * Three decisions worth naming:
 *
 *   1. **Stale locks are recovered, not respected.** A daemon killed with
 *      `SIGKILL` cannot clean up, so a lock whose pid is gone is *not* an error:
 *      it is proof the previous owner died, and the new process takes it over.
 *      Without this, a crash would require a human to delete a file.
 *   2. **Release is ownership-checked.** The same rule as the runtime pointer:
 *      only the process that wrote the lock removes it, so the loser of a race
 *      (or a process that mistook a stale lock for its own) cannot unlink the
 *      winner's lock and let a third instance in.
 *   3. **It is a *refusal*, not a warning.** `BOARD_ALREADY_RUNNING` (409) names
 *      the pid and the file, so the operator learns exactly what to stop. A
 *      warning would leave two writers running, which is the thing the design
 *      forbids.
 *
 * The lock is advisory — it guards the *supported* way to start a board, not an
 * adversarial one. A process that opens the SQLite file directly (the md
 * migrator) is unaffected, exactly as before; SQLite's own write lock is what
 * keeps *that* case from corrupting anything.
 */

import { closeSync, fsyncSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { SECRET_FILE_MODE, VERSION, WRITER_LOCK_FILENAME } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { redactText } from "../../shared/redact.mjs";
import { ensureDir } from "./paths.mjs";

/**
 * The lock file for a data directory.
 * @param {string} dataDir
 */
export function writerLockPath(dataDir) {
  return join(dataDir, WRITER_LOCK_FILENAME);
}

/**
 * Is `pid` a process that exists right now?
 *
 * `process.kill(pid, 0)` sends no signal: it performs the permission/existence
 * check and throws `ESRCH` when there is no such process. `EPERM` means the
 * process exists but belongs to somebody else — still alive, which is the answer
 * that matters here. Anything else (a pid the platform rejects) is treated as
 * "not alive", which is the permissive direction for *stale* recovery only; the
 * file itself is still there and is still inspected.
 *
 * @param {unknown} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Take the data directory's write lock.
 *
 * @param {string} dataDir
 * @param {{pid?: number, now?: string, logger?: Function}} [options]
 * @returns {{path: string, pid: number, release: () => boolean}}
 * @throws {DomainError} BOARD_ALREADY_RUNNING when a live process holds it
 */
export function acquireWriterLock(dataDir, options = {}) {
  const pid = options.pid ?? process.pid;
  const path = writerLockPath(dataDir);
  ensureDir(dirname(path));

  // One retry, and only for a stale lock: `O_EXCL` either wins or shows us the
  // holder. The retry exists so the steal is atomic-ish — if a third process
  // wins the race to re-create it between our unlink and our open, the second
  // `openSync` fails with EEXIST and that process is the holder.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = createLockFile(path, { pid, now: options.now });
    if (created) return lockHandle(path, pid);

    const holder = readLock(path);
    if (holder !== null && isProcessAlive(holder.pid)) {
      throw new DomainError("BOARD_ALREADY_RUNNING", {
        message: `another taskd (pid ${holder.pid}) already owns ${dataDir}`,
        details: { dataDir, pid: holder.pid, path, startedAt: holder.startedAt ?? null },
        hint: {
          fix: `stop it (kill ${holder.pid}), or set TASKD_DATA_DIR to another directory`,
          lockFile: path,
        },
      });
    }

    // The holder is gone (or the file is junk): the lock is a fossil, and a
    // fossil must not need a human. Log it, remove it, and try once more.
    if (typeof options.logger === "function") {
      options.logger({ event: "writer_lock_stale", path, pid: holder?.pid ?? null });
    }
    rmSync(path, { force: true });
  }

  throw new DomainError("BOARD_ALREADY_RUNNING", {
    message: `could not take the write lock for ${dataDir}: another process keeps winning the race`,
    details: { dataDir, path, pid },
    hint: { fix: `check for another taskd, then remove ${path} if none is running` },
  });
}

/**
 * `O_EXCL` create, contents and all. Returns `false` when somebody else holds it.
 *
 * @param {string} path
 * @param {{pid: number, now?: string}} input
 */
function createLockFile(path, input) {
  let fd;
  try {
    fd = openSync(path, "wx", SECRET_FILE_MODE);
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw new DomainError("VALIDATION_FAILED", {
      message: `could not create the write lock: ${redactText(err.message)}`,
      details: { path },
      hint: { fix: "check the data directory is writable" },
      cause: err,
    });
  }
  try {
    writeSync(
      fd,
      `${JSON.stringify({ pid: input.pid, version: VERSION, startedAt: input.now ?? new Date().toISOString() }, null, 2)}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The lock file as an object, or `null` when it is missing or not one. */
function readLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The handle the owner keeps.
 *
 * `release()` removes the file **only while it still names us**. That is what
 * makes the loser harmless: it may have read a stale lock, but it can never
 * delete the winner's. Returns whether the lock is gone.
 *
 * @param {string} path @param {number} pid
 */
function lockHandle(path, pid) {
  let released = false;
  return {
    path,
    pid,
    release() {
      if (released) return true;
      const holder = readLock(path);
      // Not ours any more (a recovered fossil, or somebody else's) — leave it.
      if (holder !== null && holder.pid !== pid) return false;
      try {
        unlinkSync(path);
      } catch (err) {
        if (err?.code !== "ENOENT") return false;
      }
      released = true;
      return true;
    },
  };
}
