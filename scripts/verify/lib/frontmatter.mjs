/**
 * Minimal reader for a markdown file's leading YAML frontmatter block.
 *
 * The verification tooling only needs a handful of scalar fields (`name`,
 * `description`), so this stays a hand-rolled line reader — pulling in a YAML parser
 * would break the project's zero-dependency / offline constraint.
 *
 * Lives in its own module (rather than inside `profiles.mjs`) because both the host
 * profile checks and the bundle inspector read frontmatter; a shared import keeps
 * `profiles.mjs -> bundle.mjs -> frontmatter.mjs` acyclic.
 */

/**
 * Return one field's value from the leading `---` frontmatter block, or `null` when the
 * block or the field is absent. Matching single/double quotes are stripped.
 *
 * @param {string} text
 * @param {string} field
 * @returns {string|null}
 */
export function readFrontmatterField(text, field) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!match) return null;

  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim() === field) {
      let value = line.slice(colon + 1).trim();
      const first = value[0];
      if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }

  return null;
}
