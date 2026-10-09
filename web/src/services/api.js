/**
 * HTTP client for the local `taskd` (M6a contract).
 *
 * One `fetch` wrapper, one envelope rule: a request resolves to the `data` half
 * of `{ok:true,data:…}` and rejects with an `ApiError` carrying the server's
 * `{code,message,http,details,hint}`. Nothing else in the app touches `fetch`.
 *
 * URLs are **relative** (`/api/v1/…`), so dev (Vite proxy) and production
 * (taskd serving `web/dist` from the same origin) are the same code path — there
 * is no API-base switch to get wrong.
 */

const BASE = "/api/v1";

/** A server error, carrying the machine-readable `code` the UI branches on. */
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
 * @param {{body?: object, query?: object, signal?: AbortSignal}} [options]
 * @returns {Promise<any>} the unwrapped `data`
 */
export async function request(method, path, options = {}) {
  const { body, query, signal } = options;
  const url = `${BASE}${path}${buildQuery(query)}`;
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

/** `GET /health` (no auth) — used by the dev/connection indicator. */
export async function health() {
  const response = await fetch("/health");
  return response.json();
}

/* --------------------------------------------------------------- endpoints */

export const api = {
  meta: () => get("/meta"),
  health,

  projects: (query) => get("/projects", query),
  project: (id) => get(`/projects/${encodeURIComponent(id)}`),
  createProject: (body) => post("/projects", body),

  tasks: (query) => get("/tasks", query),
  task: (ref) => get(`/tasks/${encodeURIComponent(ref)}`),
  createTask: (body) => post("/tasks", body),
  patchTask: (ref, body) => patch(`/tasks/${encodeURIComponent(ref)}`, body),
  moveTask: (ref, body) => post(`/tasks/${encodeURIComponent(ref)}/move`, body),
  taskComments: (ref, query) => get(`/tasks/${encodeURIComponent(ref)}/comments`, query),
  addComment: (ref, body) => post(`/tasks/${encodeURIComponent(ref)}/comments`, body),
  taskRelations: (ref) => get(`/tasks/${encodeURIComponent(ref)}/relations`),
  taskActivities: (ref, query) => get(`/tasks/${encodeURIComponent(ref)}/activities`, query),
  taskSessions: (ref) => get(`/tasks/${encodeURIComponent(ref)}/sessions`),

  assignees: (query) => get("/assignees", query),
  reporters: (query) => get("/reporters", query),
  labels: (query) => get("/labels", query),
};
