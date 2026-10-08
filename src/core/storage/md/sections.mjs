/**
 * The card body: `## Sections` and the little line formats inside them.
 *
 * The shapes mirror the team's existing cards exactly, because the migrator's
 * job is to read *those* files:
 *
 *   ## Progress
 *   - 2026-10-08T15:31:25.161Z did a thing
 *
 *   ## Comments
 *   - 2026-10-08T15:43:04.955Z · decision · elon — text with \n escapes
 *
 *   ## Sessions
 *   - seg:seg1 · owner:linus · backend:claude · id:<uuid> · phase:x · status:running · pid: · 2026-…
 *
 *   ## Report           (or `### R2 · <ts> · <author>` per round)
 *
 * Everything here is pure text work; `import.mjs` turns it into rows.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { ACCEPTANCE_STATUSES, EVIDENCE_KINDS } from "../../domain/enums.mjs";

/** The section order every card is written in. */
export const SECTION_ORDER = Object.freeze([
  "Background",
  "Acceptance",
  "Progress",
  "Comments",
  "Sessions",
  "Report",
]);

/** Separators used inside comment and session lines. */
const FIELD_SEP = " · ";
const AUTHOR_SEP = " — ";

/**
 * Split a body into `##` sections.
 *
 * @param {string} body
 * @returns {{sections: Map<string, string>, extra: string}} `extra` is content
 *   before the first heading (kept, so nothing is silently dropped)
 */
export function splitSections(body) {
  const lines = String(body).split("\n");
  const sections = new Map();
  const prelude = [];
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current !== null) sections.set(current, trimBlank(buffer).join("\n"));
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      flush();
      current = heading[1];
      buffer = [];
      continue;
    }
    if (current === null) prelude.push(line);
    else buffer.push(line);
  }
  flush();

  return { sections, extra: trimBlank(prelude).join("\n") };
}

function trimBlank(lines) {
  const out = [...lines];
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out.at(-1).trim() === "") out.pop();
  return out;
}

/**
 * Render sections back into a body, in canonical order.
 * @param {Map<string, string>} sections
 */
export function joinSections(sections) {
  const chunks = [];
  const names = [
    ...SECTION_ORDER.filter((name) => sections.has(name)),
    ...[...sections.keys()].filter((name) => !SECTION_ORDER.includes(name)),
  ];
  for (const name of names) {
    const text = sections.get(name);
    chunks.push(`## ${name}\n`);
    if (String(text).trim() !== "") chunks.push(`\n${String(text).replace(/\s+$/, "")}\n`);
  }
  return chunks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Acceptance (checkbox list → meta, never a report)
// ---------------------------------------------------------------------------

/**
 * `- [ ] text` / `- [x] text`.
 * @param {string} text
 * @returns {{text: string, checked: boolean}[]}
 */
export function parseAcceptanceBlock(text) {
  const items = [];
  for (const line of String(text).split("\n")) {
    const match = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (match === null) {
      if (line.trim() !== "") {
        throw new DomainError("MD_PARSE_ERROR", {
          message: `unreadable acceptance line: ${JSON.stringify(line)}`,
          details: { section: "Acceptance", found: line },
        });
      }
      continue;
    }
    items.push({ text: match[2].trim(), checked: match[1].toLowerCase() === "x" });
  }
  return items;
}

/** @param {{text: string, checked: boolean}[]} items */
export function renderAcceptanceBlock(items) {
  return items.map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`).join("\n");
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Each line is one progress note, order preserved. @param {string} text */
export function parseProgressBlock(text) {
  return String(text)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s?/, "").trim())
    .filter((line) => line !== "");
}

/**
 * @param {{ts: string, text: string}[]} entries
 */
export function renderProgressBlock(entries) {
  return entries.map((entry) => `- ${entry.ts === "" ? "" : `${entry.ts} `}${entry.text}`).join("\n");
}

/**
 * Split `- <ts> <text>`. Only a timestamp-shaped first token is treated as one,
 * so a note that happens to start with a word keeps all of its text.
 * @param {string} line
 */
export function splitProgressLine(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\S*)\s+(.*)$/.exec(line);
  if (match === null) return { ts: "", text: line };
  return { ts: match[1], text: match[2] };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** Escape a body so it survives one line of markdown. */
export function escapeInline(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** The inverse of `escapeInline`. */
export function unescapeInline(text) {
  return String(text).replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/**
 * `- <ts> · <kind> · <author> — <body>`
 * @param {string} text
 */
export function parseCommentsBlock(text) {
  const comments = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^-\s*(.*)$/.exec(trimmed);
    if (match === null) {
      throw new DomainError("MD_PARSE_ERROR", {
        message: `unreadable comment line: ${JSON.stringify(line)}`,
        details: { section: "Comments", found: line },
      });
    }
    const rest = match[1];
    const authorAt = rest.indexOf(AUTHOR_SEP);
    if (authorAt === -1) {
      throw new DomainError("MD_PARSE_ERROR", {
        message: `comment line has no ' — ' separator: ${JSON.stringify(line)}`,
        details: { section: "Comments", found: line },
      });
    }
    const head = rest.slice(0, authorAt);
    const body = rest.slice(authorAt + AUTHOR_SEP.length);
    const parts = head.split(FIELD_SEP);
    if (parts.length < 3) {
      throw new DomainError("MD_PARSE_ERROR", {
        message: `comment line needs '<ts> · <kind> · <author>': ${JSON.stringify(line)}`,
        details: { section: "Comments", found: line },
      });
    }
    comments.push({
      ts: parts[0].trim(),
      kind: parts[1].trim(),
      authorId: parts.slice(2).join(FIELD_SEP).trim(),
      body: unescapeInline(body).replace(/\s+$/, ""),
    });
  }
  return comments;
}

/** @param {{ts: string, kind: string, authorId: string, body: string}[]} comments */
export function renderCommentsBlock(comments) {
  return comments
    .map((comment) => `- ${comment.ts}${FIELD_SEP}${comment.kind}${FIELD_SEP}${comment.authorId}${AUTHOR_SEP}${escapeInline(comment.body)}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_FIELDS = ["seg", "owner", "backend", "id", "phase", "status", "pid"];

/**
 * `- seg:x · owner:y · backend:z · id:<uuid> · phase:p · status:s · pid:n · <ts>`
 * @param {string} text
 */
export function parseSessionsBlock(text) {
  const sessions = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^-\s*(.*)$/.exec(trimmed);
    if (match === null) {
      throw new DomainError("MD_PARSE_ERROR", {
        message: `unreadable session line: ${JSON.stringify(line)}`,
        details: { section: "Sessions", found: line },
      });
    }
    const parts = match[1].split(FIELD_SEP);
    const last = parts.at(-1).trim();
    if (!/^\d{4}-\d{2}-\d{2}T/.test(last)) {
      throw new DomainError("MD_PARSE_ERROR", {
        message: `session line must end with a timestamp: ${JSON.stringify(line)}`,
        details: { section: "Sessions", found: line },
      });
    }
    const entry = { ts: last };
    for (const part of parts.slice(0, -1)) {
      const colon = part.indexOf(":");
      if (colon === -1) {
        throw new DomainError("MD_PARSE_ERROR", {
          message: `session field must be '<name>:<value>': ${JSON.stringify(part)}`,
          details: { section: "Sessions", found: part },
        });
      }
      const name = part.slice(0, colon).trim();
      if (!SESSION_FIELDS.includes(name)) {
        throw new DomainError("MD_PARSE_ERROR", {
          message: `unknown session field ${JSON.stringify(name)}`,
          details: { section: "Sessions", allowed: SESSION_FIELDS },
        });
      }
      entry[name] = part.slice(colon + 1).trim();
    }
    for (const field of SESSION_FIELDS) if (entry[field] === undefined) entry[field] = "";
    sessions.push(entry);
  }
  return sessions;
}

/** @param {{seg: string, owner: string, backend: string, sessionId: string, phase?: string|null, status: string, pid?: number|null, ts: string}[]} sessions */
export function renderSessionsBlock(sessions) {
  return sessions
    .map((session) =>
      `- ${[
        `seg:${session.seg}`,
        `owner:${session.owner}`,
        `backend:${session.backend}`,
        // The parser produces `id`; rows from the database produce `sessionId`.
        `id:${session.sessionId ?? session.id ?? ""}`,
        `phase:${session.phase ?? ""}`,
        `status:${session.status}`,
        `pid:${session.pid ?? ""}`,
        session.ts,
      ].join(FIELD_SEP)}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const REPORT_HEADING = /^###\s+R(\d+)(?:\s*·\s*(.*?))?(?:\s*·\s*(.*))?$/;
const SUB_BLOCK = /^(acceptance|evidence|leftovers):\s*$/;

/**
 * Parse the `## Report` section: either the single legacy body (round 1) or one
 * `### R<n> · <ts> · <author>` block per round.
 *
 * @param {string} text
 * @returns {object[]} one entry per round, in order
 */
export function parseReportBlock(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const heading = REPORT_HEADING.exec(line.trim());
    if (heading !== null) {
      if (current !== null) blocks.push(current);
      current = { round: Number(heading[1]), ts: heading[2]?.trim() ?? null, authorId: heading[3]?.trim() ?? null, lines: [] };
      continue;
    }
    if (current === null) {
      if (line.trim() === "") continue;
      current = { round: 1, ts: null, authorId: null, lines: [] };
    }
    current.lines.push(line);
  }
  if (current !== null) blocks.push(current);

  return blocks.map((block) => parseReportBody(block));
}

function parseReportBody(block) {
  const acceptance = [];
  const evidence = [];
  const conclusion = [];
  let leftovers = "";
  let mode = "conclusion";

  for (const line of block.lines) {
    const trimmed = line.trim();
    if (SUB_BLOCK.test(trimmed)) {
      mode = SUB_BLOCK.exec(trimmed)[1];
      continue;
    }
    if (trimmed === "") {
      if (mode === "conclusion") conclusion.push("");
      else if (mode === "leftovers") leftovers += "\n";
      continue;
    }
    if (mode === "conclusion") {
      const item = /^-\s*\[([a-z_]+)\]\s*(.*)$/.exec(trimmed);
      if (item !== null) {
        mode = "acceptance";
        acceptance.push(splitNote(item[1], item[2]));
        continue;
      }
      conclusion.push(trimmed);
      continue;
    }
    if (mode === "acceptance") {
      const item = /^-\s*\[([a-z_]+)\]\s*(.*)$/.exec(trimmed);
      if (item === null) {
        if (trimmed.startsWith("-")) {
          throw new DomainError("MD_PARSE_ERROR", {
            message: `acceptance items look like '- [met] text': ${JSON.stringify(trimmed)}`,
            details: { section: "Report", found: trimmed },
          });
        }
        continue;
      }
      acceptance.push(splitNote(item[1], item[2]));
      continue;
    }
    if (mode === "evidence") {
      if (trimmed.startsWith("leftovers:")) {
        mode = "leftovers";
        leftovers += trimmed.slice("leftovers:".length).trim();
        continue;
      }
      evidence.push(parseEvidenceLine(trimmed));
      continue;
    }
    if (mode === "leftovers") leftovers += `${leftovers === "" ? "" : "\n"}${trimmed}`;
  }

  return {
    round: block.round,
    ts: block.ts,
    authorId: block.authorId,
    conclusion: conclusion.join("\n").trim(),
    acceptance,
    evidence,
    leftovers: leftovers.trim() === "" ? null : leftovers.trim(),
  };
}

function splitNote(status, rest) {
  const at = rest.indexOf(" — ");
  const text = at === -1 ? rest : rest.slice(0, at);
  const note = at === -1 ? null : rest.slice(at + 3);
  return {
    status,
    text: text.trim(),
    ...(note === null ? {} : { note: note.trim() }),
  };
}

function parseEvidenceLine(line) {
  const rest = line.replace(/^-\s*/, "");
  const [kind, ...tail] = rest.split(" ");
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `unknown evidence anchor ${JSON.stringify(kind)}`,
      details: { section: "Report", allowed: EVIDENCE_KINDS, found: line },
    });
  }
  const remainder = tail.join(" ");
  if (kind === "commit") return { kind, sha: remainder.trim() };
  if (kind === "path") return { kind, path: remainder.trim() };
  if (kind === "coverage") {
    const [lines, scope] = remainder.split(" · ");
    return { kind, lines: Number(lines), ...(scope === undefined ? {} : { scope: scope.trim() }) };
  }
  const match = /^exit\s+(-?\d+)\s*·\s*(.*)$/.exec(remainder.trim());
  if (match === null) {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `command anchors look like 'command exit 0 · <cmd>': ${JSON.stringify(line)}`,
      details: { section: "Report", found: line },
    });
  }
  return { kind: "command", exit_code: Number(match[1]), cmd: match[2].trim() };
}

/**
 * @param {{round: number, ts: string, authorId: string, conclusion: string, acceptance: object[], evidence: object[], leftovers: string|null}[]} reports
 */
export function renderReportBlock(reports) {
  const chunks = [];
  for (const report of reports) {
    chunks.push(`### R${report.round} · ${report.ts} · ${report.authorId}`);
    chunks.push("");
    if (report.conclusion.trim() !== "") {
      chunks.push(report.conclusion.trim());
      chunks.push("");
    }
    if (report.acceptance.length > 0) {
      chunks.push("acceptance:");
      for (const item of report.acceptance) {
        const status = ACCEPTANCE_STATUSES.includes(item.status) ? item.status : "not_met";
        chunks.push(`- [${status}] ${item.text}${item.note ? ` — ${item.note}` : ""}`);
      }
      chunks.push("");
    }
    if (report.evidence?.items !== undefined && report.evidence.items.length > 0) {
      chunks.push("evidence:");
      for (const anchor of report.evidence.items) chunks.push(renderEvidenceLine(anchor));
      chunks.push("");
    }
    if (report.leftovers !== null && report.leftovers !== undefined && report.leftovers !== "") {
      chunks.push(`leftovers: ${report.leftovers}`);
      chunks.push("");
    }
  }
  return chunks.join("\n").trimEnd();
}

function renderEvidenceLine(anchor) {
  switch (anchor.kind) {
    case "commit":
      return `- commit ${anchor.sha}`;
    case "path":
      return `- path ${anchor.path}`;
    case "command":
      return `- command exit ${anchor.exit_code} · ${anchor.cmd}`;
    case "coverage":
      return `- coverage ${anchor.lines}${anchor.scope ? ` · ${anchor.scope}` : ""}`;
    default:
      throw new DomainError("REPORT_INVALID", {
        message: `cannot render evidence anchor ${JSON.stringify(anchor.kind)}`,
        details: { anchor },
      });
  }
}
