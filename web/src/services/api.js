/**
 * HTTP client for the local `taskd` (M6a contract).
 *
 * One `fetch` wrapper, one envelope rule: a request resolves to the `data` half
 * of `{ok:true,data:…}` and rejects with an `ApiError` carrying the server's
 * `{code,message,http,details,hint}`. Nothing else in the app touches `fetch`.
 *
 * **`code` is what the UI renders; `message` never is** (T-20261014-152924 ④).
 * The message is the server's own prose about the write it refused — for a
 * constraint failure that is the storage engine's words — so it is kept here for
 * the console and for tests, and every surface turns `code` into a sentence with
 * `errorTextKey` (`i18n/messages.mjs`) plus `t()`: see `stores/board.js` and
 * `ToastRegion.vue`, which render exactly what that pair returns and fall back
 * to `error.generic` for a code they do not know. The two ends agree by
 * construction — one vocabulary, one lookup.
 *
 * URLs are **relative** (`/api/v1/…`), so dev (Vite proxy) and production
 * (taskd serving `web/dist` from the same origin) are the same code path — there
 * is no API-base switch to get wrong.
 */

const BASE = "/api/v1";

/**
 * A server error, carrying the machine-readable `code` the UI branches on.
 *
 * `message` (inherited from `Error`) exists so a stack and a console read
 * usefully; it is **not** a UI string — see the module note above.
 */
export class ApiError extends Error {
  /**
   * @param {{code?: string, message?: string, http?: number, details?: object, hint?: object|null}} payload
   * @param {number} [httpStatus]
   */
  constructor(payload, httpStatus) {
    super(payload?.message ?? payload?.code ?? "request failed");
    this.name = "ApiError";
    this.code = payload?.code ?? "INTERNAL";
    this.http = payload?.http ?? httpStatus ?? 0;
    this.details = payload?.details ?? {};
    this.hint = payload?.hint ?? null;
  }

  /** A 409 version conflict (the only one the board treats specially). */
  get isVersionConflict() {
    return this.code === "VERSION_CONFLICT";
  }
}

function buildQuery(query) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * @param {"GET"|"POST"|"PATCH"|"PUT"|"DELETE"} method
 * @param {string} path e.g. `/tasks/TD-1`
 * @param {{body?: object, query?: object, signal?: AbortSignal, root?: boolean}} [options]
 *   `root` addresses a route outside `/api/v1` — only `/meta` today.
 * @returns {Promise<any>} the unwrapped `data`
 */
export async function request(method, path, options = {}) {
  const { body, query, signal, root = false } = options;
  const url = `${root ? "" : BASE}${path}${buildQuery(query)}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Network-level failure (server down, aborted): surface it as an ApiError so
    // callers have one error type to handle.
    if (err?.name === "AbortError") throw err;
    throw new ApiError({ code: "NETWORK", message: "The board did not respond.", http: 0, details: { cause: String(err) } });
  }

  let envelope = null;
  try {
    envelope = await response.json();
  } catch {
    envelope = null;
  }
  if (!envelope || envelope.ok !== true) {
    const payload = envelope?.error ?? { code: "INTERNAL", message: `unexpected response (${response.status})` };
    throw new ApiError(payload, response.status);
  }
  return envelope.data;
}

export const get = (path, query) => request("GET", path, { query });
export const post = (path, body) => request("POST", path, { body });
export const patch = (path, body) => request("PATCH", path, { body });
export const del = (path) => request("DELETE", path);

/**
 * The one non-JSON request the board has: an attachment's bytes
 * (`PUT /api/v1/attachments/:id/content`, §5.1). The body is the file verbatim
 * and the answer is still the usual envelope, so the error path is shared with
 * `request` — one `ApiError`, one `code` for the UI to branch on.
 *
 * @param {string} path
 * @param {Blob|ArrayBuffer|Uint8Array} bytes
 * @param {string} contentType
 */
export async function putBytes(path, bytes, contentType) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: bytes,
    });
  } catch (err) {
    throw new ApiError({ code: "NETWORK", message: "The board did not respond.", http: 0, details: { cause: String(err) } });
  }
  let envelope = null;
  try {
    envelope = await response.json();
  } catch {
    envelope = null;
  }
  if (!envelope || envelope.ok !== true) {
    const payload = envelope?.error ?? { code: "INTERNAL", message: `unexpected response (${response.status})` };
    throw new ApiError(payload, response.status);
  }
  return envelope.data;
}

/** `GET /health` (no auth) — used by the dev/connection indicator. */
export async function health() {
  const response = await fetch("/health");
  return response.json();
}

/* --------------------------------------------------------------- endpoints */

export const api = {
  // `/meta` is a root route, not `/api/v1/meta` (`src/server/index.mjs`).
  meta: () => request("GET", "/meta", { root: true }),
  health,

  // B19 — the access policy and the persisted token. Both verbs are
  // loopback-only server-side; the read answers the token because the panel
  // shows the credential a refresh must keep showing.
  access: () => get("/access"),
  saveAccess: (body) => request("PUT", "/access", { body }),

  projects: (query) => get("/projects", query),
  project: (id) => get(`/projects/${encodeURIComponent(id)}`),
  createProject: (body) => post("/projects", body),

  tasks: (query) => get("/tasks", query),
  task: (ref) => get(`/tasks/${encodeURIComponent(ref)}`),
  createTask: (body) => post("/tasks", body),
  patchTask: (ref, body) => patch(`/tasks/${encodeURIComponent(ref)}`, body),
  moveTask: (ref, body) => post(`/tasks/${encodeURIComponent(ref)}/move`, body),
  reopenTask: (ref, body) => post(`/tasks/${encodeURIComponent(ref)}/reopen`, body),
  taskComments: (ref, query) => get(`/tasks/${encodeURIComponent(ref)}/comments`, query),
  addComment: (ref, body) => post(`/tasks/${encodeURIComponent(ref)}/comments`, body),
  taskRelations: (ref) => get(`/tasks/${encodeURIComponent(ref)}/relations`),
  taskActivities: (ref, query) => get(`/tasks/${encodeURIComponent(ref)}/activities`, query),
  taskSessions: (ref) => get(`/tasks/${encodeURIComponent(ref)}/sessions`),
  taskReports: (ref) => get(`/tasks/${encodeURIComponent(ref)}/reports`),

  // Relations are add/remove only (the board keeps history readable): a
  // `depends_on` edge is written as `blocks` with **source = the prerequisite**
  // (`stores/board.js#saveDepends`), and removed by its numeric id.
  addRelation: (ref, body) => post(`/tasks/${encodeURIComponent(ref)}/relations`, body),
  removeRelation: (ref, relationId) => del(`/tasks/${encodeURIComponent(ref)}/relations/${encodeURIComponent(relationId)}`),

  // The attachment surface (T-20261014-212017-4). Its truth is the `attachments`
  // **table** — the G2 ruling — never a `meta.attachments` array, which has no
  // writer at all. Upload is two requests by design (row, then bytes) and the
  // caller owns rolling the row back when the byte half fails.
  taskAttachments: (ref) => get(`/tasks/${encodeURIComponent(ref)}/attachments`),
  addAttachment: (ref, body) => post(`/tasks/${encodeURIComponent(ref)}/attachments`, body),
  removeAttachment: (id) => del(`/attachments/${encodeURIComponent(id)}`),
  uploadAttachmentContent: (id, bytes, contentType) => putBytes(`/attachments/${encodeURIComponent(id)}/content`, bytes, contentType),
  attachmentContentUrl: (id) => `${BASE}/attachments/${encodeURIComponent(id)}/content`,

  // One dictionary read since 0019: `actors` is the single table, and
  // `assignee`/`reporter` became roles a card fills.
  actors: (query) => get("/actors", query),
  labels: (query) => get("/labels", query),
};
