/**
 * Step 19: token on disk and the runtime pointer (A13, V13).
 *
 * File modes are the kind of thing that "works" until a umask eats it, so they
 * are asserted from `stat`, not from the flags we passed.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  TOKEN_FORMAT,
  ensureToken,
  generateToken,
  hasToken,
  isToken,
  readToken,
  rotateToken,
  tokenFilePath,
} from "../../../../src/core/storage/secrets/token-store.mjs";
import {
  POINTER_KEYS,
  readRuntimePointer,
  removeRuntimePointer,
  serializePointer,
  writeRuntimePointer,
} from "../../../../src/core/storage/secrets/runtime-pointer.mjs";
import { cleanupTempDirs, makeTempDir, TS } from "../../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const mode = (path) => statSync(path).mode & 0o777;
const dataDir = () => join(makeTempDir("token-"), "data");

describe("secrets/token-store", () => {
  it("creates a token with 0600 in a 0700 directory, and does not replace it", () => {
    const dir = dataDir();
    const created = ensureToken(dir);
    assert.equal(created.created, true);
    assert.match(created.token, TOKEN_FORMAT);
    assert.equal(created.file, tokenFilePath(dir));
    assert.equal(mode(dir), 0o700, "the data directory is private");
    assert.equal(mode(created.file), 0o600, "the token file is private");
    assert.equal(readFileSync(created.file, "utf8").trim(), created.token);

    const again = ensureToken(dir);
    assert.equal(again.created, false);
    assert.equal(again.token, created.token, "an existing token is never rotated by accident");
    assert.equal(readdirSync(dir).length, 1, "no temporary file survived");
  });

  it("generates a fresh token per call and validates the shape", () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
    assert.equal(isToken(a), true);
    assert.equal(isToken(a.replace(/^td_/, "tk_")), false);
    assert.equal(isToken("td_short"), false);
    assert.equal(isToken(`${a}A`), false, "an extra character is not a token");
    assert.equal(isToken(null), false);
    assert.equal(isToken(a.toUpperCase()), false, "hex is lowercase");
    assert.equal(generateToken(() => Buffer.alloc(32, 0xab)), `td_${"ab".repeat(32)}`);
  });

  it("refuses to serve or overwrite a corrupt token file", () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenFilePath(dir), "not-a-token\n", "utf8");

    assert.throws(() => readToken(dir), (err) => {
      assert.equal(err.code, "TOKEN_FILE_CORRUPT");
      assert.equal(err.http, 500);
      assert.match(err.hint.fix, /delete/);
      return true;
    });
    assert.throws(() => ensureToken(dir), (err) => err.code === "TOKEN_FILE_CORRUPT");
    assert.equal(readFileSync(tokenFilePath(dir), "utf8"), "not-a-token\n", "left alone for a human");
    assert.equal(readToken(join(dir, "nope")), null, "no file yet is not an error");
    assert.equal(hasToken(dir), true);
    assert.equal(hasToken(join(dir, "nope")), false);
  });

  it("rotates atomically and tightens permissions it did not set", () => {
    const dir = dataDir();
    const first = ensureToken(dir);
    const rotated = rotateToken(dir);
    assert.equal(rotated.rotated, true);
    assert.notEqual(rotated.token, first.token);
    assert.equal(readToken(dir), rotated.token);
    assert.equal(mode(rotated.file), 0o600);

    chmodSync(rotated.file, 0o644);
    chmodSync(dir, 0o755);
    ensureToken(dir);
    assert.equal(mode(rotated.file), 0o600, "a permissive file is tightened, not trusted");
    assert.equal(mode(dir), 0o700);
    assert.equal(readdirSync(dir).filter((name) => name.includes(".tmp-")).length, 0, "no temp files");
  });

  it("tightens a permissive directory rather than trusting it, and cleans up a failed write", () => {
    const dir = dataDir();
    ensureToken(dir);
    chmodSync(dir, 0o777);
    rotateToken(dir);
    assert.equal(mode(dir), 0o700, "a world-writable data directory is not left that way");

    // A realistic failure: something replaced `token` with a directory, so the
    // atomic rename cannot land. The temp file must not survive it.
    const blocked = dataDir();
    ensureToken(blocked);
    const file = tokenFilePath(blocked);
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => rotateToken(blocked), (err) => {
      assert.equal(err.code, "TOKEN_FILE_CORRUPT");
      assert.match(err.message, /could not write the token file/);
      return true;
    });
    assert.equal(readdirSync(blocked).filter((name) => name.includes(".tmp-")).length, 0);
  });
});

describe("secrets/runtime-pointer", () => {
  const pointer = {
    url: "http://127.0.0.1:9527",
    host: "0.0.0.0",
    port: 9527,
    dataDir: "/tmp/board",
    tokenFile: "/tmp/board/token",
    pid: 4242,
    version: "0.0.0",
    updatedAt: TS,
  };

  it("writes the pointer 0600 in a 0700 directory, with the documented keys", () => {
    const path = join(makeTempDir("pointer-"), "state", "runtime.json");
    const written = writeRuntimePointer(pointer, { path });
    assert.equal(written.path, path);
    assert.equal(mode(path), 0o600);
    assert.equal(mode(dirname(path)), 0o700, "the directory that holds it is private too");
    assert.deepEqual(Object.keys(written.pointer).sort(), [...POINTER_KEYS].sort());
    assert.equal(written.pointer.pid, 4242);
    assert.deepEqual(readRuntimePointer({ path }), written.pointer);
    assert.equal(removeRuntimePointer({ path }), true);
    assert.equal(readRuntimePointer({ path }), null);
    assert.equal(readRuntimePointer({ path }), null, "reading a missing pointer is not an error");
  });

  it("refuses to write a pointer that would contain a token", () => {
    const dir = makeTempDir("pointer-leak-");
    const token = generateToken();
    // Two shapes of mistake: a token smuggled into a kept key (a URL query
    // string) and one in a key that would have been dropped.
    assert.throws(
      () => writeRuntimePointer({ ...pointer, url: `http://127.0.0.1:9527/?token=${token}` }, { path: join(dir, "runtime.json") }),
      (err) => {
        assert.equal(err.code, "RUNTIME_POINTER_TOKEN_LEAK");
        return true;
      },
    );
    assert.throws(() => writeRuntimePointer({ ...pointer, token }, { path: join(dir, "runtime.json") }), (err) => {
      assert.equal(err.code, "RUNTIME_POINTER_TOKEN_LEAK");
      assert.equal(err.http, 500);
      assert.equal(err.message.includes(token), false, "the message must not repeat the secret");
      return true;
    });
    assert.equal(readdirSync(dir).length, 0, "nothing was written");
  });

  it("fails cleanly when the pointer cannot be written", () => {
    const dir = makeTempDir("pointer-bad-");
    // The parent is a *file*, so the directory cannot be created.
    writeFileSync(join(dir, "state"), "x", "utf8");
    assert.throws(() => writeRuntimePointer(pointer, { path: join(dir, "state", "runtime.json") }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.match(err.message, /runtime pointer directory/);
      return true;
    });

    // The target itself is a directory, so the atomic rename cannot land.
    const blocked = join(makeTempDir("pointer-blocked-"), "state");
    mkdirSync(join(blocked, "runtime.json"), { recursive: true });
    assert.throws(() => writeRuntimePointer(pointer, { path: join(blocked, "runtime.json") }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.match(err.message, /could not write the runtime pointer/);
      return true;
    });
    assert.deepEqual(
      readdirSync(blocked).filter((name) => name.includes(".tmp-")),
      [],
      "no temp file survives a failed write",
    );
  });

  it("tightens a pointer directory that was left open", () => {
    const dir = join(makeTempDir("pointer-mode-"), "state");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeRuntimePointer(pointer, { path: join(dir, "runtime.json") });
    assert.equal(mode(dir), 0o700);
  });

  it("serialises only known keys and drops empty ones", () => {
    const text = serializePointer({ url: "u", host: "h", port: 1, dataDir: "d", tokenFile: "t", pid: null, secret: "x" });
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), ["url", "host", "port", "dataDir", "tokenFile"]);
    assert.equal(text.includes("secret"), false);
    assert.equal(/td_\*{4}/.test(serializePointer({ url: "http://x/?token=td_****" })), true, "a redacted placeholder is allowed");
  });
});
