/**
 * Parsed-geometry cache — sole gateway between the API's
 * `GET /api/projects/{projectId}/geometry` endpoint and every UI
 * surface that needs to reason about levels, grids, cores, openings,
 * floor plates, no-column zones, building bounds, and parse warnings.
 *
 * Architecture mirrors `scheme-adapter.js`:
 *   - async `loadParsedGeometry(projectId)` populates the cache
 *   - synchronous accessors (`getCachedNormalizedGeometry`,
 *     `getCachedRawGeometry`, `getCachedEnvelope`, `getPlanGeometry`)
 *     read from it for hot paths
 *   - listeners registered via `onGeometryChange` are notified after
 *     every successful refresh, after `acceptGeometry`, and after
 *     `clearGeometryCache` so dependent UI re-renders without polling.
 *
 * Concurrency:
 *   - In-flight loads are deduped by `projectId`. Two concurrent
 *     `loadParsedGeometry("river-lab")` calls share the same fetch
 *     and resolve to the same cached envelope.
 *   - Switching projects invalidates the cache atomically before the
 *     new fetch resolves, so consumers never see a half-updated
 *     mixture of two projects.
 *
 * Error semantics:
 *   - 404 (project has no geometry yet, e.g. fresh dev DB or before
 *     a parse has succeeded) is treated as a *valid empty state* —
 *     `loadParsedGeometry` returns `null` and the cache holds an
 *     "empty" sentinel. Callers can render a "no geometry yet" state
 *     instead of treating this as an error.
 *   - All other errors propagate; the cache is left untouched so
 *     the previous geometry stays visible.
 *
 * Coordinate conventions:
 *   - The *normalized* geometry (returned by `getCachedNormalizedGeometry`)
 *     uses the Three.js convention from `parsed-geometry-adapter.js`:
 *     plan x / z in feet (`buildingBounds` has `minX/minZ/maxX/maxZ`,
 *     polygons are arrays of `{x, z}`).
 *   - The *plan-frame* projection (returned by `getPlanGeometry`) is
 *     a convenience for the legacy 2D SVG canvas: same numeric values,
 *     but the second axis is renamed to `y` and core / NCZ polygons
 *     are flattened to bounding-box rectangles `[x, y, w, h]` so the
 *     existing `_drawCores` / `_drawNCZ` etc. don't need rewriting.
 */

import { fetchGeometry, acceptGeometry as acceptGeometryApi } from "../api/parse.js";
import { adaptParsedGeometry, GeometryAdapterError } from "./parsed-geometry-adapter.js";
import { ApiError } from "../api/client.js";

// ---------------------------------------------------------------------------
// Internal cache state
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} GeometryEnvelope
 * @property {string} geometryId
 * @property {string} projectId
 * @property {number} version
 * @property {"processing"|"completed"|"partial"|"failed"} parseStatus
 * @property {"pending"|"accepted"|"superseded"} reviewStatus
 * @property {?string} createdAt
 * @property {?string} completedAt
 * @property {?string} acceptedAt
 * @property {?string} acceptedBy
 * @property {?string} sourceFileId         - mirrored from geometry.metadata.sourceFileId
 * @property {?string} sourceFileFormat     - mirrored from geometry.metadata.fileFormat
 * @property {?number} overallConfidence    - mirrored from geometry.metadata
 * @property {string[]} apiWarnings         - mirrored from geometry.metadata
 * @property {string[]} adapterWarnings     - emitted by the normalizer
 */

/**
 * @typedef {Object} CacheEntry
 * @property {string} projectId
 * @property {?GeometryEnvelope} envelope
 * @property {?object} raw          - original ParsedGeometry JSON
 * @property {?object} normalized   - adaptParsedGeometry result
 * @property {?object} plan         - plan-frame projection (lazy)
 */

/** Active cache entry (single project at a time). */
let _entry = null;

/** projectId → in-flight fetch promise, for dedup. */
const _inflight = new Map();

/** Set<(entry: CacheEntry|null) => void> — change listeners. */
const _listeners = new Set();

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Fetch the latest geometry for a project (or a specific version when
 * `geometryId` is provided), normalize it, and populate the cache.
 *
 * @param {string} projectId
 * @param {{ geometryId?: string|null, force?: boolean }} [options]
 * @returns {Promise<object|null>} normalized geometry, or `null` when
 *   the project has no geometry yet (404). Errors other than 404
 *   propagate so callers can decide between "show stale cache" and
 *   "show error".
 */
export async function loadParsedGeometry(projectId, options = {}) {
  if (!projectId) {
    clearGeometryCache();
    return null;
  }

  // Switching projects: drop the previous cache *before* the new
  // fetch resolves so consumers never read a stale geometry attributed
  // to the new project.
  if (_entry && _entry.projectId !== projectId) {
    _entry = null;
    _notify();
  }

  const dedupKey = _dedupKey(projectId, options.geometryId ?? null);

  if (!options.force && _inflight.has(dedupKey)) {
    return _inflight.get(dedupKey);
  }

  const promise = _doLoad(projectId, options.geometryId ?? null);
  _inflight.set(dedupKey, promise);
  try {
    return await promise;
  } finally {
    _inflight.delete(dedupKey);
  }
}

async function _doLoad(projectId, geometryId) {
  let resp;
  try {
    resp = await fetchGeometry(projectId, geometryId);
  } catch (err) {
    if (err instanceof ApiError && err.code === "PROJECT_NOT_FOUND") {
      _setEmpty(projectId);
      return null;
    }
    if (err instanceof ApiError && err.code === "GEOMETRY_NOT_FOUND") {
      _setEmpty(projectId);
      return null;
    }
    if (err instanceof ApiError && err.status === 404) {
      _setEmpty(projectId);
      return null;
    }
    throw err;
  }

  if (!resp || !resp.geometry) {
    // API responded but the row hasn't produced geometry yet (parse
    // still processing). Treat as empty rather than crashing.
    _setEmpty(projectId, _envelopeFromResponse(projectId, resp));
    return null;
  }

  let normalized;
  try {
    normalized = adaptParsedGeometry(resp.geometry);
  } catch (err) {
    if (err instanceof GeometryAdapterError) {
      // The API gave us a payload the renderer can't consume. Don't
      // poison the cache with garbage — leave whatever was there
      // before and surface the error to the caller.
      console.error("[CivilAgent] Parsed geometry rejected by adapter:", err.message);
      throw err;
    }
    throw err;
  }

  const envelope = _envelopeFromResponse(projectId, resp, normalized);

  _entry = {
    projectId,
    envelope,
    raw: resp.geometry,
    normalized,
    plan: null, // lazy
  };
  _notify();
  return normalized;
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

/**
 * Move a parsed geometry from `pending` to `accepted`. Optimistically
 * stamps the cache so the inspector / tray flips state without
 * waiting for the round-trip; reverts on failure.
 *
 * @param {string} projectId
 * @param {string} geometryId
 * @param {{ note?: string }} [options]
 */
export async function acceptGeometry(projectId, geometryId, options = {}) {
  if (!projectId || !geometryId) {
    throw new Error("acceptGeometry: projectId and geometryId are required");
  }

  const previous = _entry;
  // Optimistic: only touch the cache if the geometry currently in cache
  // matches the one being accepted. Skipping otherwise avoids racing
  // against an unrelated project switch.
  if (
    previous &&
    previous.projectId === projectId &&
    previous.envelope?.geometryId === geometryId &&
    previous.envelope.reviewStatus === "pending"
  ) {
    _entry = {
      ...previous,
      envelope: {
        ...previous.envelope,
        reviewStatus: "accepted",
        acceptedAt: new Date().toISOString(),
      },
    };
    _notify();
  }

  try {
    const resp = await acceptGeometryApi(projectId, geometryId, options);
    // Reconcile with server state.
    if (resp && _entry?.envelope?.geometryId === geometryId) {
      _entry = {
        ..._entry,
        envelope: {
          ..._entry.envelope,
          reviewStatus: resp.reviewStatus ?? "accepted",
          acceptedAt: resp.acceptedAt ?? _entry.envelope.acceptedAt,
          acceptedBy: resp.acceptedBy ?? _entry.envelope.acceptedBy,
        },
      };
      _notify();
    }
    return resp;
  } catch (err) {
    // Revert optimistic update on failure.
    if (previous && _entry !== previous) {
      _entry = previous;
      _notify();
    }
    throw err;
  }
}

/**
 * Synchronously seed the cache from a payload the caller already
 * has in-hand (e.g. the new-project flow just received it from the
 * API). Avoids the empty-UI flash between workspace mount and the
 * follow-up `loadParsedGeometry()` round-trip.
 *
 * Idempotent. Safe to call before any `loadParsedGeometry()` —
 * subsequent loads will overwrite the seeded entry with the
 * authoritative server response.
 *
 * @param {string} projectId
 * @param {object} rawGeometry - ParsedGeometry payload
 * @param {Partial<GeometryEnvelope>} [envelopeOverrides]
 */
export function seedParsedGeometry(projectId, rawGeometry, envelopeOverrides = {}) {
  if (!projectId || !rawGeometry || typeof rawGeometry !== "object") return;

  let normalized;
  try {
    normalized = adaptParsedGeometry(rawGeometry);
  } catch (err) {
    if (err instanceof GeometryAdapterError) {
      console.warn("[CivilAgent] seedParsedGeometry: adapter rejected payload:", err.message);
      return;
    }
    throw err;
  }

  const envelope = {
    geometryId: envelopeOverrides.geometryId ?? null,
    projectId,
    version: Number.isFinite(envelopeOverrides.version) ? envelopeOverrides.version : 1,
    parseStatus: envelopeOverrides.parseStatus ?? "completed",
    reviewStatus: envelopeOverrides.reviewStatus ?? "pending",
    createdAt: envelopeOverrides.createdAt ?? null,
    completedAt: envelopeOverrides.completedAt ?? null,
    acceptedAt: envelopeOverrides.acceptedAt ?? null,
    acceptedBy: envelopeOverrides.acceptedBy ?? null,
    overallConfidence: normalized.metadata?.overallConfidence ?? null,
    apiWarnings: normalized.metadata?.apiWarnings ?? [],
    adapterWarnings: normalized.metadata?.adapterWarnings ?? [],
  };

  _entry = {
    projectId,
    envelope,
    raw: rawGeometry,
    normalized,
    plan: null,
  };
  _notify();
}

/** Drop the cache entirely. Idempotent. */
export function clearGeometryCache() {
  if (_entry === null) return;
  _entry = null;
  _notify();
}

/**
 * Drop the cache only when it belongs to `projectId`. Used by callers
 * that want to invalidate after a re-parse without disturbing other
 * projects. Returns `true` if anything was cleared.
 */
export function invalidateGeometryFor(projectId) {
  if (!_entry || _entry.projectId !== projectId) return false;
  _entry = null;
  _notify();
  return true;
}

// ---------------------------------------------------------------------------
// Synchronous accessors
// ---------------------------------------------------------------------------

/** @returns {object|null} normalized geometry (Three.js coordinate frame). */
export function getCachedNormalizedGeometry() {
  return _entry?.normalized ?? null;
}

/** @returns {object|null} the original ParsedGeometry JSON the API returned. */
export function getCachedRawGeometry() {
  return _entry?.raw ?? null;
}

/** @returns {GeometryEnvelope|null} */
export function getCachedEnvelope() {
  return _entry?.envelope ?? null;
}

/** @returns {string|null} project id the cache currently belongs to. */
export function getCachedProjectId() {
  return _entry?.projectId ?? null;
}

/**
 * Plan-frame projection for the legacy 2D SVG canvas + inspector
 * fallback paths. Computed once and memoised on the cache entry.
 *
 * Shape:
 *   {
 *     levels: [{ id, name, elevation, height, confidence, source }],
 *     gridLines: [{ id, axis, label, coordinate, confidence }],
 *     cores: [{ id, type, boundary: [x, y, w, h], levelIds, confidence }],
 *     noColumnZones: [{ id, name, reason, source, confidence,
 *                       boundary: [x, y, w, h] }],
 *     slabZones: [{ id, name, levelId, boundary: [x, y, w, h] }],
 *     buildingBounds: { minX, minY, maxX, maxY },
 *     overallConfidence: number|null,
 *     warnings: string[],
 *   }
 *
 * Returns `null` when the cache is empty.
 */
export function getPlanGeometry() {
  if (!_entry?.normalized) return null;
  if (_entry.plan) return _entry.plan;
  _entry.plan = _projectToPlan(_entry.normalized, _entry.envelope);
  return _entry.plan;
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

/**
 * Subscribe to cache changes (refresh, clear, accept). The listener
 * is invoked synchronously after the mutation; receives the new
 * cache entry or `null` when cleared.
 *
 * @param {(entry: CacheEntry|null) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onGeometryChange(listener) {
  if (typeof listener !== "function") return () => {};
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function _notify() {
  for (const listener of Array.from(_listeners)) {
    try {
      listener(_entry);
    } catch (err) {
      console.error("[CivilAgent] geometry-cache listener threw:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _setEmpty(projectId, envelope = null) {
  _entry = {
    projectId,
    envelope,
    raw: null,
    normalized: null,
    plan: null,
  };
  _notify();
}

function _envelopeFromResponse(projectId, resp, normalized = null) {
  if (!resp) return null;
  return {
    geometryId: resp.id ?? null,
    projectId,
    version: Number.isFinite(resp.version) ? resp.version : 0,
    parseStatus: resp.parseStatus ?? "processing",
    reviewStatus: resp.reviewStatus ?? "pending",
    createdAt: resp.createdAt ?? null,
    completedAt: resp.completedAt ?? null,
    acceptedAt: resp.acceptedAt ?? null,
    acceptedBy: resp.acceptedBy ?? null,
    sourceFileId: normalized?.metadata?.sourceFileId ?? resp?.metadata?.sourceFileId ?? null,
    sourceFileFormat: normalized?.metadata?.fileFormat ?? resp?.metadata?.fileFormat ?? null,
    overallConfidence: normalized?.metadata?.overallConfidence ?? null,
    apiWarnings: normalized?.metadata?.apiWarnings ?? [],
    adapterWarnings: normalized?.metadata?.adapterWarnings ?? [],
  };
}

function _dedupKey(projectId, geometryId) {
  return geometryId ? `${projectId}::${geometryId}` : `${projectId}::latest`;
}

// ---------------------------------------------------------------------------
// Plan-frame projection
// ---------------------------------------------------------------------------

function _projectToPlan(normalized, envelope) {
  const bounds = _toPlanBounds(normalized.buildingBounds);
  return {
    levels: normalized.levels.map((l) => ({
      id: l.id,
      name: l.name,
      elevation: l.elevation,
      height: l.height,
      confidence: l.confidence,
      source: l.source,
    })),
    gridLines: normalized.gridLines.map((g) => ({
      id: g.id,
      axis: g.axis,
      label: g.label,
      coordinate: g.coordinate,
      confidence: g.confidence,
      source: g.source,
    })),
    cores: normalized.cores.map((c) => ({
      id: c.id,
      type: c.type,
      levelIds: c.levelIds,
      confidence: c.confidence,
      source: c.source,
      boundary: _bboxToRect(c.bounds),
    })),
    noColumnZones: normalized.noColumnZones.map((z) => ({
      id: z.id,
      name: z.name,
      reason: z.reason,
      source: z.source,
      confidence: z.confidence,
      levelIds: z.levelIds,
      boundary: _bboxToRect(z.bounds),
    })),
    slabZones: _deriveSlabs(normalized),
    buildingBounds: bounds,
    overallConfidence: envelope?.overallConfidence ?? null,
    warnings: [
      ...(envelope?.apiWarnings ?? []),
      ...(envelope?.adapterWarnings ?? []),
    ],
  };
}

function _toPlanBounds(b) {
  if (!b) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: b.minX,
    minY: b.minZ,
    maxX: b.maxX,
    maxY: b.maxZ,
  };
}

function _bboxToRect(bbox) {
  // bbox uses Three.js `z` for the second axis; the SVG canvas wants
  // a `[x, y, w, h]` rectangle in plan coordinates.
  const x = bbox.minX;
  const y = bbox.minZ;
  const w = Math.max(0, bbox.maxX - bbox.minX);
  const h = Math.max(0, bbox.maxZ - bbox.minZ);
  return [x, y, w, h];
}

/**
 * Derive a thin slab-zone view from level plan boundaries — one slab
 * per level, named after the level. The 2D plan view uses these for
 * the loads / sizing pages where slab tributaries are rendered as
 * shaded rectangles.
 *
 * Future work: when the parser produces per-level floor-plate
 * polygons, replace this with the real boundary; for now the level's
 * planBoundary bounding box is the closest approximation we have.
 */
function _deriveSlabs(normalized) {
  const out = [];
  for (const lvl of normalized.levels) {
    if (!Array.isArray(lvl.planBoundary) || lvl.planBoundary.length === 0) continue;
    const bbox = _polyBounds(lvl.planBoundary);
    out.push({
      id: `SLAB-${lvl.id}`,
      name: lvl.name ? `${lvl.name} slab` : `${lvl.id} slab`,
      levelId: lvl.id,
      boundary: _bboxToRect(bbox),
    });
  }
  return out;
}

function _polyBounds(points) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}
