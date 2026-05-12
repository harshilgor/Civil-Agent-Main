/**
 * Parse trigger + progress streaming.
 *
 * Two surfaces:
 *
 *   - `triggerParse(projectId, fileId)`        - kicks off a worker job
 *   - `subscribeProgress(geometryId, hooks)`   - streams progress events
 *   - `fetchGeometry(projectId, [geometryId])` - downloads the final
 *      `ParsedGeometry` payload
 *
 * The progress event schema mirrors `ProgressEvent` in
 * `packages/engine/geometry_parser/progress.py`:
 *
 *   {
 *     jobId, geometryId, step, status, detail,
 *     substeps: [{ name, status, detail?, durationMs? }],
 *     progress: 0..1,
 *     terminal: bool,
 *     errorCode?: string,
 *     timestamp: ISO8601
 *   }
 *
 * The WS server emits a `{ type: "heartbeat" }` line every ~15s — we
 * skip those silently. On a terminal event the server closes with code
 * 1000; we treat any close as the end of the stream.
 */

import { request, wsUrl } from "./client.js";

/** Step ordering — mirrors `PARSE_STEPS` in the parser constants. */
export const PARSE_STEPS = [
  "download",
  "init",
  "levels",
  "grids",
  "cores",
  "openings",
  "floor_plates",
  "existing_elements",
  "no_column_zones",
  "validation",
  "complete",
];

/** Human-readable label for a parser step. */
export function stepLabel(step) {
  return ({
    download: "Downloading file",
    init: "Initialising parser",
    levels: "Extracting levels",
    grids: "Extracting grids",
    cores: "Identifying cores",
    openings: "Detecting openings",
    floor_plates: "Building floor plate boundaries",
    existing_elements: "Reading existing elements",
    no_column_zones: "Computing no-column zones",
    validation: "Validating geometry",
    complete: "Finalising",
  })[step] || step;
}

/**
 * Trigger a parse job for an uploaded file.
 * @returns {Promise<{ jobId: string, geometryId: string, status: "queued"|"deduped" }>}
 */
export async function triggerParse(projectId, fileId, options = {}) {
  return await request(`/api/projects/${projectId}/geometry/parse`, {
    method: "POST",
    body: { fileId, force: !!options.force, options: options.parseOptions || null },
  });
}

/**
 * Open a WebSocket and stream progress events to the supplied hooks.
 *
 * @param {string} geometryId
 * @param {object} hooks
 * @param {(event) => void} [hooks.onEvent]   - any non-heartbeat event
 * @param {(event) => void} [hooks.onTerminal] - last event before close
 * @param {(err: Error) => void} [hooks.onError]
 * @param {() => void} [hooks.onClose]
 * @returns {{ close: () => void }} - call `close()` to end the stream
 */
export function subscribeProgress(geometryId, hooks = {}) {
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
      try { ws.close(1000); } catch { /* already closed */ }
    },
  };
}

/**
 * Fetch the latest accepted/completed geometry for a project,
 * or a specific version when `geometryId` is provided.
 *
 * Returns the full `GeometryResponse` envelope:
 *   {
 *     id, projectId, version,
 *     parseStatus: "processing"|"completed"|"partial"|"failed",
 *     reviewStatus: "pending"|"accepted"|"superseded",
 *     createdAt, completedAt, acceptedAt, acceptedBy,
 *     geometry: ParsedGeometry | null,
 *   }
 *
 * The actual geometry payload sits at `.geometry`; the envelope fields
 * carry the version + status metadata the inspector and tray surface.
 */
export async function fetchGeometry(projectId, geometryId = null) {
  const path = geometryId
    ? `/api/projects/${projectId}/geometry/${geometryId}`
    : `/api/projects/${projectId}/geometry`;
  return await request(path);
}

/**
 * Move a parsed geometry from `pending` review to `accepted`. The API
 * returns the updated envelope; callers should swap that into their
 * cache so dependent UI (inspector, tray) reflects the new state
 * without a refetch.
 *
 * @param {string} projectId
 * @param {string} geometryId
 * @param {{ note?: string }} [options] - optional acceptance note (max 1000 chars)
 */
export async function acceptGeometry(projectId, geometryId, options = {}) {
  return await request(
    `/api/projects/${projectId}/geometry/${geometryId}/accept`,
    {
      method: "PATCH",
      body: options.note ? { note: options.note } : {},
    },
  );
}
