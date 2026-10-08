/**
 * The tool table: 18 tools, frozen, in one place.
 *
 * The list is the card's, verbatim. Two properties of this file are the
 * milestone's, and both are enforced by tests rather than by review:
 *
 *   * **Nothing may be added silently.** `TOOL_NAMES` is frozen and
 *     `test/mcp/protocol.test.mjs` asserts the advertised set is *equal* to the
 *     frozen array — not a superset, not "contains". A tool someone adds in a
 *     hurry fails that test, which is the only way "no dictionary-management
 *     tools" stays true a year from now.
 *   * **Nothing may be omitted silently** either, for the same reason in the
 *     other direction.
 *
 * `validateInput` is here because it is the other half of the schema: a
 * published `inputSchema` that the server does not enforce would be decoration.
 * The rules it implements are exactly the ones the schema can express —
 * *required*, *declared*, *typed*, *in range* — and nothing about the board.
 * That line matters: this is a validation of the **request**, not of the
 * **world**. "Is `DEMO-0001` in `in_review`?" is the service's question, and
 * asking it here would be a second gate.
 */

import { invalidParams } from "./result.mjs";
import { COMMENT_TOOLS } from "./tools/comments.mjs";
import { DICTIONARY_TOOLS } from "./tools/dictionary.mjs";
import { PROJECT_TOOLS } from "./tools/projects.mjs";
import { RELATION_TOOLS } from "./tools/relations.mjs";
import { SESSION_TOOLS } from "./tools/sessions.mjs";
import { TASK_TOOLS } from "./tools/tasks.mjs";

/**
 * Every tool this server has.
 *
 * Order is the order `tools/list` reports, which is also the order they are
 * grouped in — tasks first, because that is what a caller reaches for.
 */
export const TOOLS = Object.freeze([
  ...TASK_TOOLS,
  ...COMMENT_TOOLS,
  ...RELATION_TOOLS,
  ...SESSION_TOOLS,
  ...DICTIONARY_TOOLS,
  ...PROJECT_TOOLS,
]);

/** The 18 names, frozen (card Acceptance #2). */
export const TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));

/** @param {string} name */
export function findTool(name) {
  return TOOLS.find((tool) => tool.name === name);
}

/** The public projection of a tool: what `tools/list` advertises. */
export function publicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly === true },
  };
}

/** Every tool as `tools/list` reports it. */
export function toolsList() {
  return TOOLS.map(publicTool);
}

// ---------------------------------------------------------------------------
// Schema enforcement
// ---------------------------------------------------------------------------

/** A label for the offending argument, so the message can name it. */
function describe(tool, key) {
  return `task tool "${tool.name}" argument "${key}"`;
}

/** @param {object} property @param {unknown} value */
function matchesType(property, value) {
  if (Array.isArray(property.anyOf)) return property.anyOf.some((branch) => matchesType(branch, value));

  switch (property.type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      if (!Array.isArray(value)) return false;
      // `items` is optional in JSON Schema; every array here declares one.
      return property.items === undefined || value.every((item) => matchesType(property.items, item));
    default:
      // An untyped fragment cannot be checked, and refusing it would make a
      // forgotten `type:` look like a client error.
      return true;
  }
}

/** @param {object} property @param {string} value */
function matchesEnum(property, value) {
  if (Array.isArray(property.anyOf)) return property.anyOf.some((branch) => matchesEnum(branch, value));
  if (!Array.isArray(property.enum)) return true;
  return property.enum.includes(value);
}

/**
 * Enforce a tool's `inputSchema` against what the caller sent.
 *
 * `null` counts as absent for a required argument: a model that emits
 * `{"ref": null}` means "I have no ref", and answering `-32602` is a far better
 * reply than forwarding `null` to the service and printing whatever it says.
 *
 * @param {object} tool
 * @param {Record<string, unknown>} args
 * @throws {DomainError} CLI_USAGE — surfaced as JSON-RPC `-32602`
 */
export function validateInput(tool, args) {
  const schema = tool.inputSchema;

  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      throw invalidParams(`Missing required argument "${key}" for tool "${tool.name}"`, {
        details: { tool: tool.name, argument: key, required: [...schema.required] },
        hint: { fix: `see tools/list for the schema of ${tool.name}` },
      });
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (property === undefined) {
      throw invalidParams(`Unknown argument "${key}" for tool "${tool.name}"`, {
        details: { tool: tool.name, argument: key, allowed: Object.keys(schema.properties ?? {}) },
        hint: { fix: `remove "${key}"; ${tool.name} declares application/json with additionalProperties: false` },
      });
    }
    if (value === undefined) continue;
    if (!matchesType(property, value)) {
      throw invalidParams(`${describe(tool, key)} must be of type ${property.type ?? "the declared shape"}`, {
        details: { tool: tool.name, argument: key, received: value, expected: property.type ?? property.anyOf },
        hint: { fix: property.description },
      });
    }
    if (typeof value === "string" && !matchesEnum(property, value)) {
      throw invalidParams(`${describe(tool, key)} must be one of ${property.enum.join(", ")}`, {
        details: { tool: tool.name, argument: key, received: value, allowed: [...property.enum] },
      });
    }
  }

  // Cross-field rules that a per-property schema cannot state (a tool-level
  // hook rather than a second schema language).
  if (typeof tool.validate === "function") tool.validate(args);
}
