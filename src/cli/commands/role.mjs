/**
 * `role list` / `role sync --file <path|->` — the local role catalog.
 *
 * The supervisor publishes the roles it discovered through `role sync`; humans
 * and the `meerkat` skill read them with `role list`. Both commands are
 * **local by construction** (`local: true`): no board, no token, no identity.
 * The board never learns roles — this file is host-local state, and the
 * supervisor speaks it through `taskctl` like every other board decision.
 *
 * `sync` is a **full replacement**, the chosen semantics: the supervisor is the
 * discovery authority, so the file is whatever its last scan found. Identical
 * content is a no-op (the stored `updated_at` is left alone); a malformed or
 * missing file is simply replaced, which is how a deleted or hand-broken
 * projection heals on the next tick.
 */

import { DomainError } from "../../foundation/errors.mjs";
import { normalizeRoleCatalog, sameCatalog } from "../../foundation/role-catalog.mjs";
import {
  defaultRoleCatalogPath,
  readRoleCatalog,
  writeRoleCatalog,
} from "../../foundation/role-catalog-file.mjs";
import { table } from "../output/human.mjs";

/** @param {string} message @param {string} [fix] */
function usageError(message, fix = "run `taskctl role --help`") {
  return new DomainError("CLI_USAGE", { message, hint: { fix } });
}

/** @param {string} message */
function ioError(message) {
  return new DomainError("CLI_IO", {
    message,
    hint: { fix: "check the path, or pipe a catalog with `--file -`" },
  });
}

/** The one catalog path every action uses. */
function catalogFile(ctx) {
  return defaultRoleCatalogPath(ctx.env ?? {}, { cwd: ctx.cwd });
}

/**
 * A read failure is reported as a warning and treated as absent: la `list` still
 * answers ("nothing published"), and the next `sync` repairs the file. A malformed
 * projection must never be half-read into an assignee range.
 *
 * @param {ReturnType<typeof readRoleCatalog>} read
 * @returns {string[]}
 */
function readWarnings(read) {
  return read.ok ? [] : [`${read.code}: ${read.message}`];
}

function runRoleList(ctx) {
  const file = catalogFile(ctx);
  const read = readRoleCatalog(file);
  const warnings = readWarnings(read);
  const roles = read.ok && read.present ? read.catalog.roles : [];
  const source = read.ok && read.present ? read.catalog.source : null;
  const updatedAt = read.ok && read.present ? read.catalog.updated_at : null;

  const human = roles.length === 0
    ? [`no roles in ${file}`, ...warnings].join("\n")
    : [
        `role catalog: ${file}${source === null ? "" : ` (source: ${source}${updatedAt === null ? "" : `, updated: ${updatedAt}`})`}`,
        table(
          ["agent", "id", "title", "lanes", "installed_on"],
          roles.map((role) => [
            role.agent,
            role.id,
            role.title === "" ? "-" : role.title,
            role.lanes.length === 0 ? "-" : role.lanes.join(","),
            role.installed_on.length === 0 ? "-" : role.installed_on.join(","),
          ]),
        ),
        ...warnings,
      ].join("\n");

  return {
    data: {
      file,
      present: read.ok ? read.present : true,
      source,
      updated_at: updatedAt,
      roles,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    human,
  };
}

async function runRoleSync(ctx) {
  const target = ctx.flags.file;
  if (typeof target !== "string" || target.trim() === "") {
    throw usageError(
      "`role sync` needs --file <path|->",
      "pipe the discovered set: `taskctl role sync --file -`",
    );
  }

  let text;
  try {
    text = target.trim() === "-"
      ? await ctx.readStdin()
      : ctx.readFile(target.trim());
  } catch (err) {
    throw ioError(`cannot read the role catalog payload (${err?.code ?? err?.message ?? "unknown error"})`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw ioError(`the role catalog payload is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  const normalized = normalizeRoleCatalog(raw);
  if (!normalized.ok) {
    throw usageError(`the role catalog payload is invalid: ${normalized.message}`);
  }
  // The sync time is the honest "last published" stamp; a payload's own
  // `updated_at` describes when it was built, which is the same instant in the
  // normal supervisor path but not something a caller can be trusted to set.
  const catalog = { ...normalized.catalog, updated_at: new Date().toISOString() };

  const file = catalogFile(ctx);
  const existing = readRoleCatalog(file);
  if (existing.ok && existing.present && sameCatalog(existing.catalog, catalog)) {
    return {
      data: {
        file,
        changed: false,
        roles: catalog.roles.length,
        source: catalog.source,
        primary_kind: catalog.primary_kind,
        updated_at: existing.catalog.updated_at,
      },
      human: `synced ${catalog.roles.length} role(s) (unchanged) — ${file}`,
    };
  }

  const written = writeRoleCatalog(file, catalog);
  if (!written.ok) {
    throw new DomainError("CLI_IO", {
      message: written.message,
      hint: { fix: "point MEERKAT_TASKPANEL_CONFIG_DIR at a writable directory, or fix the file's permissions" },
    });
  }

  return {
    data: {
      file,
      changed: true,
      roles: catalog.roles.length,
      source: catalog.source,
      primary_kind: catalog.primary_kind,
      updated_at: catalog.updated_at,
    },
    human: `synced ${catalog.roles.length} role(s) (changed) — ${file}`,
  };
}

export const COMMANDS = [
  {
    name: "list",
    summary: "List the roles the supervisor discovered (from the local roles.json).",
    usage: "role list",
    positionals: [],
    // Local by construction: the catalog is a host file, never board state.
    local: true,
    flags: [],
    run: runRoleList,
  },
  {
    name: "sync",
    summary: "Replace the local role catalog with a discovered role set (supervisor-only).",
    usage: "role sync --file <path|->",
    positionals: [],
    local: true,
    flags: [
      {
        flag: "file",
        key: "file",
        as: "string",
        value: "<path|->",
        summary: "The catalog payload; `-` reads stdin (the supervisor's form).",
      },
    ],
    run: runRoleSync,
  },
];
