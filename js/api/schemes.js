/**
 * Scheme generation + retrieval helpers.
 *
 * Wraps `/api/projects/{projectId}/schemes/*` and uses the shared
 * `request()` helper from `client.js` so auth headers (`X-Dev-User`
 * / `X-Dev-Org` in dev, `Authorization: Bearer` in prod) and the
 * structured `ApiError` envelope come along for free.
 *
 * The `subscribeSchemeProgress` helper reuses the same WebSocket
 * channel as the parse worker — Agent 3's job streams through
 * `parse-progress:{geometryId}` to keep the frontend WS plumbing
 * single-purpose.
 */

import { request, wsUrl } from "./client.js";

/**
 * Trigger scheme generation for a project.
 * Returns `{ jobId, geometryId, generationRunId, status: "queued" }`.
 *
 * Both arguments are optional:
 *   - omit `geometryId` to use the latest accepted/completed geometry
 *   - omit `constraints` to use material-system bay defaults
 */
export async function triggerGenerateSchemes(projectId, { geometryId = null, constraints = null } = {}) {
  return await request(`/api/projects/${projectId}/schemes/generate`, {
    method: "POST",
    body: { geometryId, constraints },
  });
}

/**
 * Fetch all non-archived schemes for a project, optionally filtered
 * by geometry id. Returns `{ schemes, geometryId, generationRunId }`.
 */
export async function fetchSchemesForProject(projectId, { geometryId = null, includeArchived = false } = {}) {
  const params = new URLSearchParams();
  if (geometryId) params.set("geometry_id", geometryId);
  if (includeArchived) params.set("include_archived", "true");
  const qs = params.toString();
  const path = qs
    ? `/api/projects/${projectId}/schemes?${qs}`
    : `/api/projects/${projectId}/schemes`;
  return await request(path);
}

/** Fetch a single scheme with full member data. */
export async function fetchScheme(projectId, schemeId) {
  return await request(`/api/projects/${projectId}/schemes/${schemeId}`);
}

/**
 * Activate a scheme. The server demotes any other active scheme on
 * the same geometry to `alternate` in the same transaction and
 * writes a `scheme_activated` audit event.
 */
export async function activateScheme(projectId, schemeId) {
  return await request(`/api/projects/${projectId}/schemes/${schemeId}`, {
    method: "PATCH",
    body: { status: "active" },
  });
}

/** Soft-delete (archive) a scheme. */
export async function archiveScheme(projectId, schemeId) {
  return await request(`/api/projects/${projectId}/schemes/${schemeId}`, {
    method: "DELETE",
  });
}

/**
 * Subscribe to scheme-generation progress over the same WebSocket
 * channel the parser uses. Hooks mirror `subscribeProgress` in
 * `parse.js`.
 *
 * @param {string} geometryId
 * @param {object} hooks
 * @param {(event) => void} [hooks.onEvent]
 * @param {(event) => void} [hooks.onTerminal]
 * @param {(err: Error) => void} [hooks.onError]
 * @param {() => void} [hooks.onClose]
 * @returns {{ close: () => void }}
 */
export function subscribeSchemeProgress(geometryId, hooks = {}) {
  const url = wsUrl(`/ws/parse-progress/${geometryId}`);
  let ws;
  let closed = false;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    hooks.onError?.(err);
    return { close: () => {} };
  }

  ws.addEventListener("message", (msg) => {
    let payload;
    try { payload = JSON.parse(msg.data); } catch { return; }
    if (payload?.type === "heartbeat") return;
    hooks.onEvent?.(payload);
    if (payload?.terminal) hooks.onTerminal?.(payload);
  });

  ws.addEventListener("error", (err) => {
    if (closed) return;
    hooks.onError?.(err);
  });

  ws.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    hooks.onClose?.();
  });

  return {
    close: () => {
      closed = true;
      try { ws.close(1000); } catch { /* already closed */ }
    },
  };
}
