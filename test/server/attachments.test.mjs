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
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";
import { attachmentContentPath, sanitizeFilename } from "../../src/server/routes/attachments.mjs";
import { ATTACHMENT_MAX_BYTES } from "../../src/foundation/constants.mjs";

const AGENT = { kind: "agent", id: "linus" };
const tempDirs = [];
let taskd;
let base;
let dataDir;
let taskId;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-attach-"));
  tempDirs.push(dataDir);
  taskd = await createTaskd({ dataDir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;

  const { commands, repos } = taskd.board;
  commands.createProject({ id: "proj", name: "P", actor: AGENT });
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

/** The audit rows one attachment's route writes produced, in order. */
function attachmentActivities(attachmentId) {
  return taskd.board.db
    .prepare("SELECT event, task_id, changes_json FROM task_activities WHERE task_id = ? AND event LIKE 'attachment_%' ORDER BY id")
    .all(taskId)
    .filter((row) => JSON.parse(row.changes_json).attachmentId === attachmentId);
}

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

  /**
   * A second PUT replaces what is stored (T-20261013-014304). It is the case the
   * write order lives or dies by: the new bytes arrive as a staging file and
   * *swap* into place, so the attachment path is only ever replaced whole — an
   * overwrite is never a truncate-then-write, and the row follows the disk.
   */
  it("replaces the stored bytes on a second PUT", async () => {
    const attachment = theAttachment();
    const first = Buffer.from("first\n");
    const second = Buffer.from("a second, longer payload\n");
    const path = join(dataDir, "attachments", attachment.id);

    const one = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`, { method: "PUT", body: first });
    assert.equal(one.status, 200);
    assert.equal(statSync(path).size, first.length);

    const two = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`, { method: "PUT", body: second });
    assert.equal(two.status, 200);
    assert.equal((await two.json()).data.size, second.length);
    assert.equal(statSync(path).size, second.length, "the file was replaced, not appended to");
    assert.deepEqual(readFileSync(path), second);
    assert.equal(theAttachment().size, second.length, "and the row kept up");

    const get = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`);
    assert.equal(get.status, 200);
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), second);
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

/**
 * T-20261014-212017-4 — the **metadata** routes, which are what turned this
 * surface from reserved into usable (`T-20261014-212017-2` G1: "建行/列表/删除三面全缺").
 *
 * Every case here drives a real socket against a real board and a real data
 * directory. The three refusals that matter are the type allow-list, the size
 * ceiling (`ATTACHMENT_MAX_BYTES`), and the removal's **hard delete** — the
 * ruling this card records: the row and its bytes go together, and re-uploading
 * is the whole recovery story.
 *
 * The size ceiling gets *two* cases plus a pairing case, because an upload is
 * two requests and the ceiling can be reached in either one — T-20261015-075845-2
 * is about those two answers being one answer.
 */
describe("attachments — the write surface (metadata routes)", () => {
  const create = (body) =>
    fetch(`${base}/api/v1/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists what the card carries, in the table's own vocabulary", async () => {
    const response = await fetch(`${base}/api/v1/tasks/${taskId}/attachments`);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.task_id, taskId);
    const names = data.attachments.map((row) => row.filename);
    assert.ok(names.includes("notes.txt"), JSON.stringify(names));
    for (const row of data.attachments) {
      assert.deepEqual(Object.keys(row).sort(), ["comment_id", "content_type", "created_at", "filename", "id", "kind", "size", "task_id"]);
    }
  });

  it("404s the listing of a card that does not exist", async () => {
    const response = await fetch(`${base}/api/v1/tasks/TD-9999/attachments`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "NOT_FOUND");
  });

  it("includes the attachment list in the single-card read, and not in the list read", async () => {
    const single = await fetch(`${base}/api/v1/tasks/${taskId}`);
    assert.equal(single.status, 200);
    const { data } = await single.json();
    assert.deepEqual(data.attachments.map((row) => row.filename), ["notes.txt"]);
    for (const row of data.attachments) {
      assert.deepEqual(Object.keys(row).sort(), ["comment_id", "content_type", "created_at", "filename", "id", "kind", "size", "task_id"]);
    }

    // The board read is unchanged: attachments are a detail, not a list field.
    const listed = await fetch(`${base}/api/v1/tasks?project_id=proj`);
    const { data: board } = await listed.json();
    assert.equal(Object.hasOwn(board.tasks[0], "attachments"), false);
  });

  it("mints a row, stores bytes against it, and hands them back as a download", async () => {
    const created = await create({ filename: "spec.md", content_type: "text/markdown", size: 11 });
    assert.equal(created.status, 200);
    const { attachment, upload_url } = (await created.json()).data;
    assert.equal(attachment.filename, "spec.md");
    assert.equal(attachment.content_type, "text/markdown");
    assert.equal(attachment.kind, "attachment", "the surface is download-only; `inline` has no writer here");
    assert.equal(upload_url, `/api/v1/attachments/${attachment.id}/content`);

    const put = await fetch(`${base}${upload_url}`, { method: "PUT", body: Buffer.from("hello world") });
    assert.equal(put.status, 200);

    const get = await fetch(`${base}${upload_url}`);
    assert.equal(get.status, 200);
    // The three headers the type boundary is made of: a download, a type the
    // browser may not second-guess, and nothing left in a cache after a delete.
    assert.equal(get.headers.get("content-disposition"), 'attachment; filename="spec.md"');
    assert.equal(get.headers.get("x-content-type-options"), "nosniff");
    assert.equal(get.headers.get("cache-control"), "no-store");
    assert.equal(Buffer.from(await get.arrayBuffer()).toString(), "hello world");

    const audit = attachmentActivities(attachment.id);
    assert.deepEqual(audit.map((row) => row.event), ["attachment_added", "attachment_updated"]);
    assert.equal(audit[0].task_id, taskId, "the trail names the card");
    assert.equal(JSON.parse(audit[1].changes_json).size, 11, "the content write records its size");
  });

  it("refuses a content type outside the allow-list", async () => {
    const response = await create({ filename: "page.html", content_type: "text/html" });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "ATTACHMENT_TYPE_UNSUPPORTED");
    assert.ok(body.error.details.allowed.includes("text/plain"));
    assert.equal(body.error.details.allowed.includes("text/html"), false);
  });

  it("folds a parameterised type to its base and accepts it", async () => {
    const response = await create({ filename: "notes.txt", content_type: "text/plain; charset=utf-8" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.attachment.content_type, "text/plain");
  });

  it("accepts a video, and still hands it back as a download rather than a document", async () => {
    const created = await create({ filename: "clip.mp4", content_type: "video/mp4", size: 4 });
    assert.equal(created.status, 200);
    const { attachment, upload_url } = (await created.json()).data;
    assert.equal(attachment.content_type, "video/mp4");

    await fetch(`${base}${upload_url}`, { method: "PUT", body: Buffer.from("fake") });
    const get = await fetch(`${base}${upload_url}`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "video/mp4");
    // A video is a file, not a page: the type boundary is the same three headers
    // a text attachment gets. The drawer previews through a blob URL, so this
    // route never has to say `inline`.
    assert.equal(get.headers.get("content-disposition"), 'attachment; filename="clip.mp4"');
    assert.equal(get.headers.get("x-content-type-options"), "nosniff");
    assert.equal(get.headers.get("cache-control"), "no-store");

    await fetch(`${base}/api/v1/attachments/${attachment.id}`, { method: "DELETE" });
  });

  it("accepts a declared size exactly at the ceiling", async () => {
    // The boundary the refusals do not exercise: a file that *fits* is accepted
    // on the metadata half without allocating the payload itself.
    const response = await create({ filename: "at-limit.bin", content_type: "application/octet-stream", size: ATTACHMENT_MAX_BYTES });
    assert.equal(response.status, 200);
    const { attachment } = (await response.json()).data;
    assert.equal(attachment.size, ATTACHMENT_MAX_BYTES);
    await fetch(`${base}/api/v1/attachments/${attachment.id}`, { method: "DELETE" });
  });

  it("refuses a declared size over the ceiling", async () => {
    const response = await create({ filename: "huge.bin", content_type: "application/octet-stream", size: ATTACHMENT_MAX_BYTES + 1 });
    assert.equal(response.status, 413);
    const { error } = await response.json();
    assert.equal(error.code, "ATTACHMENT_TOO_LARGE");
    assert.equal(error.http, 413, "the payload's own status agrees with the status line");
    assert.equal(error.details.maxBytes, ATTACHMENT_MAX_BYTES);
    assert.equal(error.details.received, ATTACHMENT_MAX_BYTES + 1, "the declared size is known exactly here");
  });

  it("refuses a body over the transport's own byte ceiling", async () => {
    const created = await create({ filename: "big.bin" });
    const { attachment } = (await created.json()).data;
    const put = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`, {
      method: "PUT",
      body: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1),
    });
    assert.equal(put.status, 413);
    const { error } = await put.json();
    assert.equal(error.code, "ATTACHMENT_TOO_LARGE", "the ceiling is the attachment's, not the router's");
    assert.equal(error.http, 413);
    assert.equal(error.details.maxBytes, ATTACHMENT_MAX_BYTES);
    // The body was refused *mid-stream*, so its length was never established —
    // and the refusal says so rather than guessing at one.
    assert.equal(error.details.received, null);
  });

  /**
   * The two halves of one upload, and the point of T-20261015-075845-2 (F2):
   * the same oversized file must be refused the same way whichever half of it
   * the board notices first. Before this card the metadata route answered
   * `ATTACHMENT_TOO_LARGE` and the byte route answered `VALIDATION_FAILED`, so
   * the web drawer rendered a sentence for one and its generic fallback for the
   * other (`web/src/i18n/messages.mjs` maps codes, never server prose).
   */
  it("states one refusal across both over-limit paths, differing only in what each can know", async () => {
    const declared = await create({
      filename: "huge.bin",
      content_type: "application/octet-stream",
      size: ATTACHMENT_MAX_BYTES + 1,
    });
    const declaredError = (await declared.json()).error;

    const created = await create({ filename: "big.bin" });
    const { attachment } = (await created.json()).data;
    const put = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`, {
      method: "PUT",
      body: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1),
    });
    const bytesError = (await put.json()).error;

    assert.equal(declared.status, put.status);
    // Everything a client branches on is identical — only `received` differs,
    // because the byte path stopped counting at the ceiling instead of reading
    // the whole body to find out how big it was. So that one field comes off
    // both sides before the comparison.
    const withoutReceived = ({ details, ...rest }) => {
      const { received, ...detailRest } = details;
      return { ...rest, details: detailRest };
    };
    assert.deepEqual(withoutReceived(bytesError), withoutReceived(declaredError));
    assert.equal(bytesError.code, "ATTACHMENT_TOO_LARGE");
    assert.equal(declaredError.details.received, ATTACHMENT_MAX_BYTES + 1, "the declared size is known exactly here");
    assert.equal(bytesError.details.received, null, "and is honestly unknown here");
  });

  it("removes an attachment for good — the row and its bytes together", async () => {
    const created = await create({ filename: "gone.txt", content_type: "text/plain" });
    const { attachment } = (await created.json()).data;
    const path = join(dataDir, "attachments", attachment.id);
    await fetch(`${base}/api/v1/attachments/${attachment.id}/content`, { method: "PUT", body: Buffer.from("bye") });
    assert.equal(statSync(path).size, 3, "the bytes are on disk before the delete");

    const removed = await fetch(`${base}/api/v1/attachments/${attachment.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const payload = (await removed.json()).data;
    assert.equal(payload.removed, true);
    assert.equal(payload.attachment.filename, "gone.txt");

    // Nothing left behind: no row in the listing, no bytes on disk, and the
    // content endpoint is an honest 404 again.
    const listing = (await (await fetch(`${base}/api/v1/tasks/${taskId}/attachments`)).json()).data.attachments;
    assert.equal(listing.some((row) => row.id === attachment.id), false);
    assert.equal(statSync(path, { throwIfNoEntry: false }), undefined);
    const after = await fetch(`${base}/api/v1/attachments/${attachment.id}/content`);
    assert.equal(after.status, 404);

    assert.deepEqual(
      attachmentActivities(attachment.id).map((row) => row.event),
      ["attachment_added", "attachment_updated", "attachment_removed"],
    );
  });

  it("removes a row that never got its bytes", async () => {
    const created = await create({ filename: "never-uploaded.txt" });
    const { attachment } = (await created.json()).data;
    const removed = await fetch(`${base}/api/v1/attachments/${attachment.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200, "a row with no bytes is the ordinary case, not an error");
  });

  it("404s a delete of an id that is not there, and refuses one that is not a safe name", async () => {
    const missing = await fetch(`${base}/api/v1/attachments/11111111-2222-3333-4444-555555555555`, { method: "DELETE" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    const escape = await fetch(`${base}/api/v1/attachments/..%2f..%2fetc%2fpasswd`, { method: "DELETE" });
    assert.equal(escape.status, 404);
  });

  it("advertises the surface on /meta so a client can feature-detect it (G7)", async () => {
    const meta = (await (await fetch(`${base}/meta`)).json()).data;
    assert.equal(meta.capabilities.attachments, true);
  });
});
