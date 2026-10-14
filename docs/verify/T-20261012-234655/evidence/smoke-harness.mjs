import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessTaskd, sendInProcess } from "./lib/inproc-http.mjs";

const dir = mkdtempSync(join(tmpdir(), "smoke-"));
const taskd = await createInProcessTaskd({ dataDir: dir, env: {}, gc: false, busyTimeoutMs: 100 });
console.log("url reported:", taskd.url);
const health = await sendInProcess(taskd, { method: "GET", path: "/health" });
console.log("GET /health ->", health.status, JSON.stringify(health.json));
const created = await sendInProcess(taskd, {
  method: "POST", path: "/api/v1/projects",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "proj", name: "proj" }),
});
console.log("POST /api/v1/projects ->", created.status, JSON.stringify(created.json));
await taskd.close();
rmSync(dir, { recursive: true, force: true });
