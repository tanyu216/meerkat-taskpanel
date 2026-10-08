/**
 * Human output — small, shared building blocks.
 *
 * Each command chooses its own shape (a move reads differently from a list), but
 * the *words* come from here so `assignees list` and `issue get` label an actor
 * the same way, and both use the wire names the `--json` output uses.
 *
 * The one rule worth stating: an actor is always shown as `display_name#id`.
 * The display name is what a human recognises; the id is what they need in order
 * to type the next command (card A7).
 */

/** `linus#a1b2…` — the display name plus the id, or `-` when there is nobody. */
export function actorLabel(ref) {
  if (ref === null || ref === undefined) return "-";
  const name = ref.display_name ?? ref.id ?? "?";
  const id = ref.id ?? "";
  return id === "" ? String(name) : `${name}#${id}`;
}

/** A `key: value` block, in the order given. */
export function fields(entries) {
  const width = Math.max(...entries.map(([key]) => String(key).length), 1);
  return entries.map(([key, value]) => `${String(key).padEnd(width)}  ${value ?? "-"}`).join("\n");
}

/**
 * An aligned table. Columns are sized to their widest cell; the last column is
 * not padded (trailing spaces are noise in a terminal and in a diff).
 */
export function table(headers, rows) {
  const cells = rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "-" : String(cell))));
  const width = headers.map((header, index) =>
    Math.max(String(header).length, ...cells.map((row) => (row[index] ?? "").length)),
  );
  const line = (row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? String(cell) : String(cell).padEnd(width[index])))
      .join("  ")
      .trimEnd();
  return [line(headers.map((h) => String(h))), ...cells.map(line)].join("\n");
}

/** The one-line summary of a task, shared by every `issue` listing. */
export function taskLine(task) {
  return [
    task.identifier,
    task.status,
    task.priority,
    actorLabel(task.assignee),
    actorLabel(task.reporter),
  ].join("  ");
}

/** `none` for an empty list — an empty line reads like a bug. */
export function orNone(lines) {
  return lines.length === 0 ? "none" : lines.join("\n");
}
