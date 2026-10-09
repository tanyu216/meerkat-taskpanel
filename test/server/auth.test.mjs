/**
 * Step 8: who may talk to the board (§7.1, V10).
 *
 * The loopback half is driven over **real HTTP** — a request from this process
 * genuinely arrives from `127.0.0.1`, so the exemption is tested, not simulated.
 *
 * The remote half cannot be tested that way: a test process on this machine
 * cannot arrive from a non-loopback address. Those cases therefore call
 * `authorize()` with a synthetic request, which is the same function the server
 * calls on the real path. That is stated here rather than papered over: the
 * *logic* is covered, the socket-level delivery of a remote address is not.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { isLoopbackAddress, isLoopbackRequest, presentedToken, authorize } from "../../src/server/auth.mjs";
import { createTaskd } from "../../src/server/index.mjs";
import { isTokenShape } from "../../src/shared/transport/token.mjs";

const tempDirs = [];
let taskd;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-auth-"));
  tempDirs.push(dataDir);
  taskd = await createTaskd({ dataDir, host: "127.0.0.1", port: 0, env: {} });
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A request as the server would see one from `address`. */
const request = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });

describe("server/auth — loopback detection", () => {
  it("recognises the three spellings of 'this machine', and the whole 127/8 block", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.1.5", "::ffff:127.9.9.9"]) {
      assert.equal(isLoopbackAddress(address), true, address);
    }
    for (const address of ["10.0.0.7", "192.168.1.20", "::2", "8.8.8.8", "", null, undefined, 42]) {
      assert.equal(isLoopbackAddress(address), false, String(address));
    }
    assert.equal(isLoopbackRequest(request("127.0.0.1")), true);
    assert.equal(isLoopbackRequest({}), false);
  });
});

describe("server/auth — the local case, over real HTTP", () => {
  it("lets a loopback request read the board with no token at all", async () => {
    const response = await fetch(`${taskd.url}/api/v1/projects`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });

  it("rotates the token from loopback, and never puts the secret in the response", async () => {
    const before = readFileSync(join(dataDir, "token"), "utf8").trim();
    const response = await fetch(`${taskd.url}/api/v1/token`, { method: "POST" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.data.token_file, "string");
    assert.equal(existsSync(body.data.token_file), true);

    const after_ = readFileSync(join(dataDir, "token"), "utf8").trim();
    assert.notEqual(after_, before, "the token really changed");
    assert.equal(isTokenShape(after_), true);
    assert.equal(JSON.stringify(body).includes(after_), false, "a secret must never cross the socket");
  });
});

describe("server/auth — a request from elsewhere", () => {
  const REMOTE = request("192.168.1.50");
  const url = (query = "") => new URL(`http://board.local/api/v1/projects${query}`);

  it("demands a token (401) and says which of the two problems it is", () => {
    const missing = authorize({ req: REMOTE, url: url(), token: taskd.token });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 401);
    assert.equal(missing.payload.error.details.reason, "missing_token");
    assert.equal(missing.payload.error.http, 401);
    assert.match(missing.payload.error.hint.fix, /--token|TASKD_TOKEN/);

    const bad = authorize({
      req: request("192.168.1.50", { authorization: "Bearer td_deadbeef" }),
      url: url(),
      token: taskd.token,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 401);
    assert.equal(bad.payload.error.details.reason, "bad_token");
  });

  it("accepts Authorization: Bearer and ?token= interchangeably", () => {
    const bearer = authorize({
      req: request("192.168.1.50", { authorization: `Bearer ${taskd.token}` }),
      url: url(),
      token: taskd.token,
    });
    assert.deepEqual(bearer, { ok: true, loopback: false });

    const query = authorize({ req: REMOTE, url: url(`?token=${taskd.token}`), token: taskd.token });
    assert.deepEqual(query, { ok: true, loopback: false });

    assert.equal(presentedToken(REMOTE, url(`?token=${taskd.token}`)), taskd.token);
    assert.equal(presentedToken(request("127.0.0.1", { authorization: "Bearer   spaced  " }), url()), "spaced");
  });

  it("refuses to rotate a token from anywhere but this machine (403, loopback_only)", () => {
    const verdict = authorize({ req: REMOTE, url: url(), token: taskd.token, rotate: true });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.payload.error.code, "VALIDATION_FAILED");
    assert.equal(verdict.payload.error.details.reason, "loopback_only");
    assert.match(verdict.payload.error.hint.fix, /token rotate/);
  });

  it("refuses a wrong-length token without throwing (constant-time compare)", () => {
    const verdict = authorize({
      req: request("10.1.2.3", { authorization: "Bearer td_x" }),
      url: url(),
      token: taskd.token,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 401);
  });
});
