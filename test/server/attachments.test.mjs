/**
 * M6a — the two routes the router cannot own.
 *
 * `GET|PUT /api/v1/attachments/:id/content` is bytes in / bytes out, so it is
 * handled ahead of the JSON router. These cases drive it over a real socket: the
 * row stays metadata, the bytes live on disk under the data directory, and an id
 * that could escape that directory is refused before it is ever joined.
 *
 * Attachments are a *reserved* surface (§13) — no command creates them yet — so
 * the fixtures insert the metadata row directly, exactly as a future importer
 * would.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";
import { attachmentContentPath, sanitizeFilename } from "../../src/server/routes/attachments.mjs";

const AGENT = { kind: "agent", id: "linus" };
const tempDirs = [];
let taskd;
let base;
let dataDir;
let taskId;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "taskpanel-attach-"));
  tempDirs.push(dataDir);
  taskd = await createTaskd({ dataDir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;

  const { commands, repos } = taskd.board;
  commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/p", actor: AGENT });
  taskId = commands.createTask({ projectId: "proj", title: "with a file", actor: AGENT }).id;
  repos.attachments.insert({
    taskId,
    filename: "notes.txt",
    contentType: "text/plain",
    createdAt: new Date().toISOString(),
    kind: "attachment",
  });
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The one attachment the fixture inserted. */
const theAttachment = () => taskd.board.repos.attachments.listByTask(taskId)[0];

describe("attachments — path and header safety", () => {
  it("builds a content path only for a safe id", () => {
    assert.equal(attachmentContentPath("/data", "abc-123"), join("/data", "attachments", "abc-123"));
    for (const id of ["../escape", "a/b", "", ".", "..", "a\\b", null, 42]) {
      assert.equal(attachmentContentPath("/data", id), null, String(id));
    }
  });

  it("strips header-breaking characters from a filename", () => {
    assert.equal(sanitizeFilename('a"b\r\nc.txt'), "a_b_c.txt");
    assert.equal(sanitizeFilename(null), "attachment");
  });
});

describe("attachments — content over HTTP", () => {
  it("404s with a repair hint when the row has no stored bytes", async () => {
    const attachment = theAttachment();
    const response = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "NOT_FOUND");
    assert.match(body.error.hint.fix, /PUT the bytes/);
  });

  it("stores bytes with PUT and streams them back with GET", async () => {
    const attachment = theAttachment();
    const payload = Buffer.from("hello attachment\n");

    const put = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`, { method: "PUT", body: payload });
    assert.equal(put.status, 200);
    const stored = (await put.json()).data;
    assert.equal(stored.stored, true);
    assert.equal(stored.size, payload.length);
    assert.equal(statSync(join(dataDir, "attachments", attachment.id)).size, payload.length);

    const get = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "text/plain");
    assert.match(get.headers.get("content-disposition"), /notes\.txt/);
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), payload);

    // The PUT kept the metadata row honest, so a listing can show a size.
    assert.equal(theAttachment().size, payload.length);
    assert.equal(theAttachment().contentType, "text/plain", "the row's own type is untouched");
  });

  it("404s an attachment id that does not exist, and one that is not a safe path", async () => {
    const missing = await fetch(`${base}/api/v1/attachments/11111111-2222-3333-4444-555555555555/content`);
    assert.equal(missing.status, 404);

    // `..%2f..%2fetc%2fpasswd` reaches the handler as `../../etc/passwd`.
    const escape = await fetch(`${base}/api/v1/attachments/..%2f..%2fetc%2fpasswd/content`);
    assert.equal(escape.status, 404);
    assert.equal((await escape.json()).error.code, "NOT_FOUND");
  });
});
