import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createTaskd } = await import(`file://${process.cwd()}/src/server/index.mjs`);
const dir = mkdtempSync(join(tmpdir(), "probe-listen-"));
try {
  const t = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {}, gc: false });
  console.log("listening ok:", t.url);
  const r = await fetch(`${t.url}/health`);
  console.log("health:", r.status);
  await t.close();
} catch (e) {
  console.log("listen FAILED:", e.code ?? e.message);
} finally { rmSync(dir, { recursive: true, force: true }); }
