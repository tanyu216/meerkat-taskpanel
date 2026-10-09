/**
 * M6a — static hosting of a built board (§8).
 *
 * The frontend build (`web/dist`) is M6b's, so these cases build a **stand-in**
 * directory: what is under test is the hosting contract (types, SPA fallback,
 * traversal refusal, and the graceful "no build here" path), not any particular
 * bundle. The negative case matters as much as the positive one — a backend
 * checkout has no `web/dist` at all and must keep answering 404, not 500.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";
import { contentTypeFor, safeResolve } from "../../src/server/static.mjs";

const tempDirs = [];
let web;
let taskd;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-static-"));
  tempDirs.push(dir);
  web = join(dir, "dist");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>board</title>");
  writeFileSync(join(web, "assets", "app.js"), "export const ok = true;\n");
  writeFileSync(join(dir, "secret.txt"), "not yours");

  const dataDir = join(dir, "data");
  taskd = await createTaskd({ dataDir, host: "127.0.0.1", port: 0, env: {}, staticDir: web });
  base = taskd.url;
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("server/static — pure path and type rules", () => {
  it("maps a small set of extensions and defaults to octet-stream", () => {
    assert.match(contentTypeFor("index.html"), /text\/html/);
    assert.match(contentTypeFor("app.js"), /javascript/);
    assert.equal(contentTypeFor("logo.svg"), "image/svg+xml");
    assert.equal(contentTypeFor("blob.bin"), "application/octet-stream");
    assert.equal(contentTypeFor("font.woff2"), "font/woff2");
  });

  it("resolves inside the root and refuses escapes", () => {
    const root = "/srv/web";
    assert.equal(safeResolve(root, "/"), join(root, "index.html"));
    assert.equal(safeResolve(root, "/assets/app.js"), join(root, "assets/app.js"));
    assert.equal(safeResolve(root, "/../secret.txt"), null);
    assert.equal(safeResolve(root, "/%2e%2e/secret.txt"), null, "encoded traversal is still traversal");
    assert.equal(safeResolve(root, "/assets/%00.js"), null);
    assert.equal(safeResolve(root, "/..%2f..%2fetc%2fpasswd"), null);
  });
});

describe("server/static — serving over a real socket", () => {
  it("serves the shell at the root and an asset by path", async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.match(await index.text(), /<title>board<\/title>/);

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.equal(await asset.text(), "export const ok = true;\n");
  });

  it("falls back to the shell for a client-side route, but not for a missing asset", async () => {
    const deep = await fetch(`${base}/board/PROJ-0001`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /<title>board<\/title>/);

    const missing = await fetch(`${base}/assets/gone.js`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");
  });

  it("refuses directory traversal over a real request", async () => {
    // `%2e%2e%2f` stays opaque to the URL parser (a plain `../` would be
    // normalised away by the *client*), so this genuinely exercises the server.
    const response = await fetch(`${base}/%2e%2e%2fsecret.txt`);
    assert.equal(response.status, 404, "the file above the root must not be reachable");
  });

  it("answers HEAD with the headers and no body", async () => {
    const response = await fetch(`${base}/assets/app.js`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "24");
    assert.equal(await response.text(), "");
  });

  it("never shadows the API: an unknown /api path stays a JSON 404", async () => {
    const response = await fetch(`${base}/api/v1/nope`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
  });
});

describe("server/static — a checkout with no build", () => {
  it("404s instead of failing, and says so on /meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-nobuild-"));
    tempDirs.push(dir);
    const bare = await createTaskd({
      dataDir: join(dir, "data"),
      host: "127.0.0.1",
      port: 0,
      env: {},
      staticDir: join(dir, "missing"),
    });
    try {
      assert.equal((await fetch(`${bare.url}/`)).status, 404);
      const meta = (await (await fetch(`${bare.url}/meta`)).json()).data;
      assert.equal(meta.capabilities.static_hosting, false);
    } finally {
      await bare.close();
    }
  });
});
