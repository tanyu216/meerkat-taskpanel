/**
 * JSON-Schema fragments for the tool table.
 *
 * Six lines of builders, and they earn their keep: the 18 tools describe ~90
 * properties, and writing `{type: "string", description: "…"}` ninety times is
 * how a tool schema ends up disagreeing with itself. The builders also make the
 * *rule* visible — every property has a type and a description, and every
 * object closes itself (`additionalProperties: false`) — which is what
 * `test/mcp/protocol.test.mjs` asserts across the whole table.
 *
 * Deliberately minimal: MCP's `inputSchema` is JSON Schema, but nothing here
 * needs `oneOf`, `$ref` or formatting. A tool argument that would need them is
 * usually an argument that should have been two.
 */

/** @param {string} description */
export const string = (description) => ({ type: "string", description });

/** @param {string} description */
export const integer = (description) => ({ type: "integer", description });

/** @param {string} description */
export const boolean = (description) => ({ type: "boolean", description });

/** A free-form JSON object (`meta`); its keys are the caller's business. */
export const object = (description) => ({ type: "object", description });

/** @param {string} description */
export const stringArray = (description) => ({ type: "array", description, items: { type: "string" } });

/** An array of free-form objects (`report.evidence`, `report.acceptance`). */
export const objectArray = (description) => ({ type: "array", description, items: { type: "object" } });

/**
 * @param {readonly string[]} values
 * @param {string} description
 */
export const oneOf = (values, description) => ({ type: "string", description, enum: [...values] });

/**
 * Assemble an object schema.
 *
 * `required` is a separate argument rather than a flag on each property, so the
 * argument list of a tool reads top-to-bottom at the call site ("ref, then to,
 * then if_version") instead of being reconstructed by scanning 12 properties for
 * a marker.
 *
 * @param {Record<string, object>} properties
 * @param {string[]} required
 */
export function input(properties, required = []) {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}
