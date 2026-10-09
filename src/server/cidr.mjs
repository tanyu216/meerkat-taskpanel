/**
 * CIDR matching for the board's IP allow-list (ARCHITECTURE §7).
 *
 * The rule the design asks for is short — "支持多段 CIDR 允许列表… 默认放行全部；
 * 用户可增删/收紧；不在白名单 ⇒ 403" — and the whole of it is here, as pure
 * functions over strings, so the policy can be unit-tested without a socket.
 *
 * Two decisions worth naming:
 *
 *   * **IPv4 and IPv6 are compared as byte arrays.** There is no integer
 *     packing trick per family; one `bits` loop handles `192.168.0.0/16` and
 *     `2001:db8::/32` identically. A count under 64 bits could not express the
 *     latter at all.
 *   * **An IPv4-mapped IPv6 address is normalised to IPv4** (`::ffff:10.0.0.7`
 *     → `10.0.0.7`), because that is how a dual-stack Node socket reports a
 *     client that arrived over IPv4 — and a list written as `10.0.0.0/8` must
 *     match it.
 *
 * A malformed entry is dropped rather than treated as a wildcard: a typo in a
 * security control must fail *closed*, never open.
 */

/**
 * Parse a dotted-quad or colon-hex address into bytes.
 *
 * @param {string} text
 * @returns {Uint8Array|null} 4 bytes for IPv4, 16 for IPv6, or null if unparseable
 */
export function parseAddress(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;

  // `::ffff:a.b.c.d` / `::ffff:0:a.b.c.d` is an IPv4 address wearing a v6 hat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped !== null) return parseIPv4(mapped[1]);

  if (trimmed.includes(":")) return parseIPv6(trimmed);
  return parseIPv4(trimmed);
}

/** @param {string} text @returns {Uint8Array|null} */
function parseIPv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** @param {string} text @returns {Uint8Array|null} */
function parseIPv6(text) {
  // A trailing embedded IPv4 (`::ffff:1.2.3.4`) is two more 16-bit groups.
  let working = text;
  let embedded = null;
  const lastColon = working.lastIndexOf(":");
  const tail = working.slice(lastColon + 1);
  if (tail.includes(".")) {
    embedded = parseIPv4(tail);
    if (embedded === null) return null;
    working = `${working.slice(0, lastColon + 1)}0:0`;
  }

  const doubles = working.split("::");
  if (doubles.length > 2) return null;

  const head = doubles[0] === "" ? [] : doubles[0].split(":");
  const tailGroups = doubles.length === 2 ? (doubles[1] === "" ? [] : doubles[1].split(":")) : [];
  const groups = [...head, ...tailGroups];

  const parsed = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    parsed.push(Number.parseInt(group, 16));
  }

  if (doubles.length === 2) {
    const missing = 8 - parsed.length;
    if (missing < 1) return null;
    parsed.splice(head.length, 0, ...new Array(missing).fill(0));
  }
  // The `0:0` we appended above stood in for the embedded address's two groups.
  if (embedded !== null) {
    parsed.splice(parsed.length - 2, 2, (embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]);
  }
  if (parsed.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = parsed[i] >> 8;
    bytes[i * 2 + 1] = parsed[i] & 0xff;
  }
  return bytes;
}

/**
 * Parse one `address/prefix` (or a bare address, meaning a full-length prefix).
 *
 * @param {string} text
 * @returns {{bytes: Uint8Array, bits: number, length: number, raw: string}|null}
 */
export function parseCidr(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const slash = trimmed.lastIndexOf("/");
  const addressText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixText = slash === -1 ? null : trimmed.slice(slash + 1);

  const bytes = parseAddress(addressText);
  if (bytes === null) return null;
  const length = bytes.length * 8;

  if (prefixText === null) return { bytes, bits: length, length, raw: trimmed };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const bits = Number(prefixText);
  if (bits > length) return null;
  return { bytes, bits, length, raw: trimmed };
}

/**
 * Is `address` inside `rule`?
 *
 * @param {string} address @param {{bytes: Uint8Array, bits: number, length: number}} rule
 */
export function addressInCidr(address, rule) {
  const bytes = parseAddress(address);
  // Compare byte counts, not bit counts: `rule.length` is the prefix's address
  // width in bits (32/128), while `bytes.length` is 4 or 16.
  if (bytes === null || bytes.length !== rule.bytes.length) return false;

  let remaining = rule.bits;
  for (let i = 0; i < bytes.length && remaining > 0; i += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((bytes[i] & mask) !== (rule.bytes[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Parse the `TASKD_ALLOW_CIDRS` value into a policy.
 *
 * @param {unknown} value comma / whitespace / semicolon separated entries
 * @returns {{configured: boolean, rules: object[], invalid: string[]}}
 *   `configured: false` means "no list was given" ⇒ allow every address.
 *   `configured: true` with zero valid rules ⇒ deny every non-loopback address.
 */
export function parseAllowList(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { configured: false, rules: [], invalid: [] };
  }
  const entries = value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const rules = [];
  const invalid = [];
  for (const entry of entries) {
    const rule = parseCidr(entry);
    if (rule === null) invalid.push(entry);
    else rules.push(rule);
  }
  return { configured: true, rules, invalid };
}

/**
 * Is `address` permitted by the list?
 *
 * @param {string|null} address
 * @param {{configured: boolean, rules: object[]}} allowList
 */
export function isAddressAllowed(address, allowList) {
  if (allowList === null || allowList === undefined || allowList.configured !== true) return true;
  if (typeof address !== "string") return false;
  return allowList.rules.some((rule) => addressInCidr(address, rule));
}
