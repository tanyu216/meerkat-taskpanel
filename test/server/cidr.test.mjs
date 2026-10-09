/**
 * M6a — the IP allow-list (§7) and the way it composes with the token rule.
 *
 * The matching itself is pure and fully unit-tested. The *policy* — "a blocked
 * address is a 403 before the token is ever read, loopback is never blocked, and
 * an unset list means allow-all" — is asserted through `authorize()` with
 * synthetic requests, because a test process cannot genuinely arrive from a
 * non-loopback address (the same limitation `auth.test.mjs` documents).
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  addressInCidr,
  isAddressAllowed,
  parseAddress,
  parseAllowList,
  parseCidr,
} from "../../src/server/cidr.mjs";
import { authorize } from "../../src/server/auth.mjs";
import { createTaskd } from "../../src/server/index.mjs";

const request = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });
const url = (query = "") => new URL(`http://board.local/api/v1/projects${query}`);

describe("server/cidr — parsing", () => {
  it("parses IPv4 and IPv6 addresses to bytes", () => {
    assert.deepEqual([...parseAddress("192.168.1.20")], [192, 168, 1, 20]);
    assert.deepEqual([...parseAddress("::1")], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual([...parseAddress("2001:db8::1")].slice(0, 4), [0x20, 0x01, 0x0d, 0xb8]);
    // IPv4-mapped IPv6 normalises to the IPv4 address it carries.
    assert.deepEqual([...parseAddress("::ffff:10.0.0.7")], [10, 0, 0, 7]);
    assert.deepEqual([...parseAddress("::ffff:0:10.0.0.7")].slice(-4), [10, 0, 0, 7]);
  });

  it("returns null for anything that is not an address", () => {
    for (const value of ["", "  ", "999.1.1.1", "1.2.3", "1.2.3.4.5", "nope", "::gggg", 42, null, undefined]) {
      assert.equal(parseAddress(value), null, String(value));
    }
  });

  it("parses CIDRs, including a bare address as a full-length prefix", () => {
    assert.deepEqual({ bits: parseCidr("10.0.0.0/8").bits, length: parseCidr("10.0.0.0/8").length }, { bits: 8, length: 32 });
    assert.equal(parseCidr("10.0.0.1").bits, 32);
    assert.equal(parseCidr("2001:db8::/32").bits, 32);
    assert.equal(parseCidr("10.0.0.0/33"), null, "a prefix longer than the address is a typo");
    assert.equal(parseCidr("10.0.0.0/x"), null);
    assert.equal(parseCidr(""), null);
  });
});

describe("server/cidr — matching", () => {
  it("matches inside a prefix and rejects outside it", () => {
    const lan = parseCidr("192.168.0.0/16");
    assert.equal(addressInCidr("192.168.1.20", lan), true);
    assert.equal(addressInCidr("192.168.255.255", lan), true);
    assert.equal(addressInCidr("192.169.0.1", lan), false);

    const six = parseCidr("2001:db8::/32");
    assert.equal(addressInCidr("2001:db8:1234::9", six), true);
    assert.equal(addressInCidr("2001:db9::1", six), false);
  });

  it("never matches across address families", () => {
    assert.equal(addressInCidr("::1", parseCidr("127.0.0.0/8")), false);
    assert.equal(addressInCidr("10.0.0.1", parseCidr("::/0")), false, "a v6 wildcard is not a v4 wildcard");
  });

  it("honours /0 and a full-length prefix", () => {
    assert.equal(addressInCidr("8.8.8.8", parseCidr("0.0.0.0/0")), true);
    assert.equal(addressInCidr("8.8.8.8", parseCidr("8.8.8.8/32")), true);
    assert.equal(addressInCidr("8.8.8.9", parseCidr("8.8.8.8/32")), false);
  });
});

describe("server/cidr — the configured policy", () => {
  it("treats an unset or blank value as 'allow everything'", () => {
    for (const value of [undefined, null, "", "   "]) {
      const policy = parseAllowList(value);
      assert.equal(policy.configured, false);
      assert.equal(isAddressAllowed("8.8.8.8", policy), true);
    }
    assert.equal(isAddressAllowed("8.8.8.8", undefined), true, "no policy at all is allow-all");
  });

  it("parses a multi-segment list and only allows what is inside it", () => {
    const policy = parseAllowList("192.168.0.0/16, 203.0.113.0/24  10.0.0.0/8;::1/128");
    assert.equal(policy.configured, true);
    assert.deepEqual(policy.invalid, []);
    assert.equal(policy.rules.length, 4);
    assert.equal(isAddressAllowed("10.1.2.3", policy), true);
    assert.equal(isAddressAllowed("203.0.113.7", policy), true);
    assert.equal(isAddressAllowed("198.51.100.1", policy), false);
  });

  it("fails closed on a typo instead of opening up", () => {
    const policy = parseAllowList("192.168.0.0/16, not-an-ip");
    assert.deepEqual(policy.invalid, ["not-an-ip"]);
    assert.equal(policy.rules.length, 1);

    const allBad = parseAllowList("nonsense");
    assert.equal(allBad.configured, true);
    assert.deepEqual(allBad.rules, []);
    assert.equal(isAddressAllowed("10.0.0.1", allBad), false, "an all-typo list allows nothing");
  });

  it("refuses a non-string address when a list is configured", () => {
    const policy = parseAllowList("10.0.0.0/8");
    assert.equal(isAddressAllowed(null, policy), false);
    assert.equal(isAddressAllowed(undefined, policy), false);
  });
});

describe("server/cidr — authorize composes the list, the token and loopback", () => {
  const allowList = parseAllowList("10.0.0.0/8");

  it("answers 403 ip_not_allowed before it looks at the token", () => {
    // Even a *valid* token must not get an address out of the list in.
    const verdict = authorize({
      req: request("198.51.100.9", { authorization: "Bearer valid-token" }),
      url: url(),
      token: "valid-token",
      allowList,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.payload.error.details.reason, "ip_not_allowed");
    assert.match(verdict.payload.error.hint.fix, /TASKD_ALLOW_CIDRS/);
  });

  it("lets an allowed address through the list, then still demands the token", () => {
    const missing = authorize({ req: request("10.1.2.3"), url: url(), token: "t", allowList });
    assert.equal(missing.status, 401);
    assert.equal(missing.payload.error.details.reason, "missing_token");

    const ok = authorize({ req: request("10.1.2.3", { authorization: "Bearer t" }), url: url(), token: "t", allowList });
    assert.deepEqual(ok, { ok: true, loopback: false });
  });

  it("never blocks loopback, even when the list excludes it", () => {
    const exclusive = parseAllowList("10.0.0.0/8");
    const verdict = authorize({ req: request("127.0.0.1"), url: url(), token: "t", allowList: exclusive });
    assert.deepEqual(verdict, { ok: true, loopback: true });
  });

  it("still refuses to rotate from an allowed remote address", () => {
    const verdict = authorize({ req: request("10.1.2.3"), url: url(), token: "t", rotate: true, allowList });
    assert.equal(verdict.status, 403);
    assert.equal(verdict.payload.error.details.reason, "loopback_only");
  });
});

describe("server/cidr — over a real socket, the list is enforced", () => {
  it("serves loopback with the list set, and reports it on /meta", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "taskpanel-cidr-"));
    const taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {}, allowCidrs: "10.0.0.0/8" });
    try {
      const response = await fetch(`${taskd.url}/api/v1/projects`);
      assert.equal(response.status, 200, "loopback is exempt from the list");

      const meta = (await (await fetch(`${taskd.url}/meta`)).json()).data;
      assert.equal(meta.capabilities.allow_list, true);
    } finally {
      await taskd.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
