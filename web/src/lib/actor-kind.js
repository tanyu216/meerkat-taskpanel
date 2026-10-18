/**
 * Reading an actor's kind.
 *
 * A kind is a **platform** (`claude`, `codex`, …), the word `human`, or
 * **nothing** (`null` — the reference recorded none). Since the server-side
 * `0023`, the kind lives on the *reference* (a card's `assignee_kind`, a
 * comment's `author_kind`) rather than on the person's registry row: one row per
 * person cannot hold "worked from `claude` on Tuesday, from `codex` on Friday".
 *
 * The design, though, asks two-valued questions, and both of its attributes are
 * **closed domains** (`DOMAINS` in `test/web/blocks.contract.mjs`, and the
 * stylesheet keys on them):
 *
 *   * `data-assignee-kind` is `agent | human` — the category, not the platform;
 *   * `data-agent-platform` is one of the four host platforms.
 *
 * So neither may carry the kind verbatim. `kindLabel` answers the first by
 * **"is this *not* the human?"**, and `platformOfKind` answers the second by
 * naming the platform, or nothing when the kind does not name one the design has
 * a face for.
 *
 * It lives in `lib/`, not in the store, so the pure row builders
 * (`waiting-queue.js`, `activity-feed.js`) can read a kind without pulling Vue
 * into their unit tests.
 */

/**
 * The four platforms the design gives a badge and a colour to
 * (`DOMAINS.PLATFORM`). A kind is an *open* string on the wire — a host may call
 * itself anything — so this is where the board decides which of them it can
 * render, and anything else leaves the badge **absent** rather than putting an
 * unstyled value into a closed attribute.
 */
export const DESIGN_PLATFORMS = Object.freeze(["claude", "openclaw", "codex", "pi"]);

const DESIGN_PLATFORM_SET = new Set(DESIGN_PLATFORMS);

/**
 * Is this actor anything other than the person?
 *
 * The rule is the schema's own: **`human` is the one reserved value, and
 * everything else is an agent** (`0018` dropped the enumeration for exactly that
 * reason). That includes the literal `agent` — a card that names an assignee and
 * no platform records `agent`, which is the *category*, and reading it as "not
 * an agent" would make every imported card a person's.
 *
 * `null`, `undefined` and `""` read as **not an agent**: nothing was recorded, and
 * the repo's prior is that a misread handle is the cheaper error — reading a
 * person as an agent opens the agent-only affordances, where reading an agent as
 * a person only costs a badge.
 *
 * @param {unknown} kind
 */
export function isAgentKind(kind) {
  const text = typeof kind === "string" ? kind.trim() : "";
  return text !== "" && text !== "human";
}

/** The kind as `data-assignee-kind`'s two-valued domain. */
export function kindLabel(kind) {
  return isAgentKind(kind) ? "agent" : "human";
}

/**
 * The platform a kind names, or `null` when it names none the design can render.
 *
 * @param {unknown} kind
 */
export function platformOfKind(kind) {
  const text = typeof kind === "string" ? kind.trim() : "";
  return DESIGN_PLATFORM_SET.has(text) ? text : null;
}
