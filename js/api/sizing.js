/**
 * Sizing trigger + result fetch + progress streaming.
 *
 * Wraps `/api/projects/{projectId}/schemes/{schemeId}/...` endpoints
 * exposed by Agent 4 (`apps/api/routers/sizing.py`) plus the
 * project-scoped assumptions endpoints. Reuses the shared `request()`
 * helper from `client.js` so auth headers, base URL, and the
 * structured `ApiError` envelope come along for free.
 *
 * The progress channel for sizing is **scheme-scoped** — Agent 4
 * publishes to `sizing-progress:{schemeId}` (NOT the parser's
 * geometry-scoped channel). This keeps multi-scheme dashboards from
 * cross-talking when several sizing jobs run on different schemes for
 * the same geometry.
 *
 * Progress event shape mirrors the parser:
 *
 *   {
 *     jobId, schemeId, step, status, detail,
 *     substeps: [{ name, status, detail?, durationMs? }],
 *     progress: 0..1,
 *     terminal: bool,
 *     errorCode?: string,
 *     timestamp: ISO8601
 *   }
 */

import { request, wsUrl } from "./client.js";

/**
 * Step ordering — mirrors `SIZING_PROGRESS_STEPS` in
 * `apps/worker/jobs/calculate_sizing.py`. If the worker order changes,
 * update this list (and `sizingStepLabel`) so the progress UI doesn't
 * silently desync.
 */
export const SIZING_STEPS = [
  "init",
  "tributary",
  "beam_sizing",
  "column_takedown",
  "metrics",
  "persist",
  "complete",
];

/** Human-readable label for a sizing step. */
export function sizingStepLabel(step) {
  return (
    {
      init: "Loading scheme",
      tributary: "Computing tributary areas",
      beam_sizing: "Sizing beams",
      column_takedown: "Sizing columns + load takedown",
      metrics: "Aggregating scheme metrics",
      persist: "Saving results",
      complete: "Complete",
    }[step] || step
  );
}

/**
 * Trigger sizing for a scheme. The body is optional — when omitted the
 * worker uses stored project assumptions (or hard-coded defaults).
 *
 * Engineers can override individual fields without sending the full
 * blob; missing keys are treated as "use project default".
 *
 * @param {string} projectId
 * @param {string} schemeId
 * @param {object} [body]
 * @param {object} [body.assumptions] - partial overrides, camelCase
 * @returns {Promise<{ jobId: string, schemeId: string, sizingRunId: string, status: "queued" }>}
 */
export async function triggerCalculateSizing(projectId, schemeId, body = {}) {
  return await request(
    `/api/projects/${projectId}/schemes/${schemeId}/calculate`,
    {
      method: "POST",
      body: body || {},
    },
  );
}

/**
 * Fetch the per-member governing-check summary for a sized scheme.
 * Returns `{ members: [...], sizingStatus, sizingRunId, sizedAt,
 * assumptionsUsed, warnings }`.
 *
 * `members[].memberId` matches `column.id` / `beam.id` in the scheme,
 * which in turn matches `mesh.userData.id` in the 3D scene — so the
 * caller can join sizing data straight onto the registry without any
 * remapping.
 */
export async function fetchSchemeMembers(projectId, schemeId) {
  return await request(
    `/api/projects/${projectId}/schemes/${schemeId}/members`,
  );
}

/**
 * Fetch the full check trace + (for columns) load takedown for a
 * single member. Used by the inspector when an engineer drills into a
 * specific beam or column. Acceptable per-member API call because it
 * is user-initiated, not hovered.
 */
export async function fetchSchemeMemberDetail(projectId, schemeId, memberId) {
  return await request(
    `/api/projects/${projectId}/schemes/${schemeId}/members/${memberId}`,
  );
}

/**
 * Fetch the full column-by-column load takedown for a scheme.
 * Returns `{ columns: [{ columnId, gridLabel, levels: [...] }] }`
 * with levels already sorted top → bottom by the API.
 */
export async function fetchSchemeTakedown(projectId, schemeId) {
  return await request(
    `/api/projects/${projectId}/schemes/${schemeId}/takedown`,
  );
}

/**
 * Read the project's stored sizing assumptions.
 *
 * Always resolves to a usable payload — when no row exists the API
 * synthesises one with hard-coded defaults so the engineer sees the
 * actual values the calculator will use.
 */
export async function fetchProjectAssumptions(projectId) {
  return await request(`/api/projects/${projectId}/assumptions`);
}

/**
 * Upsert the project's sizing assumptions. The API merges the supplied
 * fields with stored values, so callers can PUT a partial blob without
 * losing keys they didn't touch.
 */
export async function updateProjectAssumptions(projectId, assumptions) {
  return await request(`/api/projects/${projectId}/assumptions`, {
    method: "PUT",
    body: { assumptions: assumptions || {} },
  });
}

/**
 * Subscribe to live sizing progress for a scheme.
 *
 * Hooks mirror `subscribeProgress` in `parse.js`. The server seeds the
 * stream with the last published snapshot (if any), so late joiners
 * still see where the job is — same UX guarantee the parser provides.
 *
 * @param {string} schemeId
 * @param {object} hooks
 * @param {(event) => void} [hooks.onEvent]    - any non-heartbeat event
 * @param {(event) => void} [hooks.onTerminal] - last event before close
 * @param {(err: Error) => void} [hooks.onError]
 * @param {() => void} [hooks.onClose]
 * @returns {{ close: () => void }}
 */
export function subscribeSizingProgress(schemeId, hooks = {}) {
  const url = wsUrl(`/ws/sizing-progress/${schemeId}`);
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
    try {
      payload = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (payload?.type === "heartbeat") return;
    hooks.onEvent?.(payload);
    if (payload?.terminal) {
      hooks.onTerminal?.(payload);
    }
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
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    },
  };
}
