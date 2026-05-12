/**
 * Scheme adapter — sole gateway between the structural builder and
 * scheme-specific member data (columns, beams, shear walls, braces).
 *
 * Backed by an in-memory cache populated from the
 * `/api/projects/{projectId}/schemes` endpoint. The adapter exposes
 * a synchronous `getSchemeBundle()` so the canvas can swap the
 * active scheme on a single click — async data fetching happens at
 * project-load and after-generation boundaries via `loadSchemes()`.
 *
 * Coordinate convention (matches `parsed-geometry-adapter.js`):
 *   API plan units (x, y in feet) → world (x, z in Three.js space)
 *   The same `OriginTransform` from ParsedGeometry is applied here,
 *   exactly once. The engine outputs scheme coordinates in the same
 *   plan frame as `buildingBounds` / `planBoundary`, so we add the
 *   transform once and never again. (Don't double-transform — see
 *   the "no double transform" rule in the agent spec.)
 *
 * Sizing-dependent fields (`size`, `dcr`, `status`, `axialLoad`,
 * `tributaryArea`) are always `null` until Agent 4 fills them in.
 * Renderers must tolerate nulls — `OverlayController` falls back to
 * neutral materials, and `inspector.js` shows "—" for missing values.
 */

import { fetchSchemesForProject, activateScheme as activateSchemeApi } from "../api/schemes.js";
import { fetchSchemeMembers } from "../api/sizing.js";

/** UUID → scheme JSON (camelCase, exactly as the API returned it). */
let _schemeCache = new Map();

/** UUID → "active" | "alternate" — kept in sync with cache for fast lookups. */
let _statusByScheme = new Map();

/**
 * UUID → sizing payload from `/schemes/{id}/members`. Lazy-populated by
 * `loadSizing()` and cleared whenever a scheme is recalculated. Each
 * value is the API envelope:
 *
 *   {
 *     members: [{ memberId, memberType, selectedSize, weightPlf,
 *                 dcr, governingCheck, status, allChecks: [...] }],
 *     sizingStatus, sizingRunId, sizedAt,
 *     assumptionsUsed, warnings,
 *   }
 *
 * Plus a memoised `_byMemberId` map so the synchronous accessors don't
 * have to repeat the lookup on every frame.
 */
let _sizingCache = new Map();

let _activeProjectId = null;
let _activeGeometryId = null;
let _activeRunId = null;

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/**
 * Fetch every scheme for the project (optionally filtered by geometry)
 * and rebuild the in-memory cache. Subsequent `getSchemeBundle()` /
 * `getMemberDcrChecks()` calls read from the cache synchronously.
 *
 * Returns an array of camelCase scheme objects from the API.
 *
 * Idempotent: calling it again with the same project replaces the
 * cache. Errors propagate to the caller (use try/catch).
 */
export async function loadSchemes(projectId, { geometryId = null } = {}) {
  if (!projectId) {
    _schemeCache = new Map();
    _statusByScheme = new Map();
    _sizingCache = new Map();
    _activeProjectId = null;
    _activeGeometryId = null;
    _activeRunId = null;
    return [];
  }
  const data = await fetchSchemesForProject(projectId, { geometryId });
  _schemeCache = new Map();
  _statusByScheme = new Map();
  // Drop sizing cache when the underlying scheme list changes — stale
  // sizing rows referencing a regenerated/removed scheme would lie
  // about D/C numbers in the overlay.
  _sizingCache = new Map();
  for (const s of data?.schemes || []) {
    _schemeCache.set(s.id, s);
    _statusByScheme.set(s.id, s.status);
  }
  _activeProjectId = projectId;
  _activeGeometryId = data?.geometryId ?? geometryId ?? null;
  _activeRunId = data?.generationRunId ?? null;
  return Array.from(_schemeCache.values());
}

/** Synchronous accessor — list of schemes currently in the cache. */
export function listCachedSchemes() {
  return Array.from(_schemeCache.values());
}

/** UUID of the cached scheme currently flagged active, or null. */
export function getActiveSchemeId() {
  for (const [id, status] of _statusByScheme) {
    if (status === "active") return id;
  }
  // Fallback to the first cached scheme so the canvas always has
  // something to render.
  const first = _schemeCache.keys().next().value;
  return first ?? null;
}

export function getCachedScheme(schemeId) {
  return _schemeCache.get(schemeId) || null;
}

export function clearSchemeCache() {
  _schemeCache = new Map();
  _statusByScheme = new Map();
  _sizingCache = new Map();
  _activeProjectId = null;
  _activeGeometryId = null;
  _activeRunId = null;
}

/**
 * Activate a scheme via the API and update the local cache so the
 * next render reflects the new active state without a refetch.
 */
export async function setActiveScheme(projectId, schemeId) {
  await activateSchemeApi(projectId, schemeId);
  for (const [id, scheme] of _schemeCache) {
    const next = id === schemeId ? "active" : (scheme.status === "active" ? "alternate" : scheme.status);
    if (next !== scheme.status) {
      scheme.status = next;
    }
    _statusByScheme.set(id, scheme.status);
  }
}

// ---------------------------------------------------------------------------
// Public render-side accessors
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sizing cache (Agent 4)
// ---------------------------------------------------------------------------

/**
 * Internal helper — index `members[]` by `memberId` once and stash the
 * map next to the envelope so the per-frame accessors stay O(1).
 */
function _indexSizing(envelope) {
  const map = new Map();
  for (const m of envelope?.members || []) {
    if (m?.memberId) map.set(m.memberId, m);
  }
  // Mutate but don't enumerate — keeps the API-shaped envelope intact
  // for any caller that wants the raw payload (e.g., the assumptions
  // panel echoing `assumptionsUsed`).
  Object.defineProperty(envelope, "_byMemberId", {
    value: map,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return envelope;
}

/**
 * Fetch and cache sizing results for a scheme. Returns the API envelope
 * `{ members, sizingStatus, sizingRunId, sizedAt, assumptionsUsed,
 * warnings }`. The cache is keyed by `schemeId`; subsequent
 * `getSchemeBundle()` and `getMemberDcrChecks()` calls see the data
 * synchronously.
 *
 * Pass `force: true` to bypass the cache (e.g. after a recalculation
 * completes — the sizing-runner does this).
 */
export async function loadSizing(projectId, schemeId, { force = false } = {}) {
  if (!projectId || !schemeId) return null;
  if (!force && _sizingCache.has(schemeId)) {
    return _sizingCache.get(schemeId);
  }
  const envelope = await fetchSchemeMembers(projectId, schemeId);
  const indexed = _indexSizing(envelope || { members: [] });
  _sizingCache.set(schemeId, indexed);
  return indexed;
}

/**
 * Drop the sizing cache for a scheme. Called by the sizing-runner the
 * moment a `POST /calculate` is enqueued so the UI doesn't keep
 * displaying stale D/C numbers while the worker recomputes.
 */
export function invalidateSizing(schemeId) {
  if (!schemeId) {
    _sizingCache = new Map();
    return;
  }
  _sizingCache.delete(schemeId);
}

/** Synchronous read of the cached sizing envelope (or null). */
export function getCachedSizing(schemeId) {
  return _sizingCache.get(schemeId) || null;
}

/** Synchronous read of a single member summary (or null). */
export function getMemberSizingSummary(schemeId, memberId) {
  const env = _sizingCache.get(schemeId);
  if (!env) return null;
  return env._byMemberId?.get(memberId) || null;
}

/**
 * Return the D/C-check rows for a scheme — the canonical input to the
 * Sizing overlay's `applySizingColors()`. Synchronous: reads from the
 * cache populated by `loadSizing()`. Returns `[]` when no sizing data
 * is available (the overlay falls back to neutral materials).
 *
 * `id` matches `column.id` / `beam.id` from the scheme, which in turn
 * matches `mesh.userData.id` set by `StructuralModelBuilder` — joining
 * to the 3D registry needs no remapping.
 *
 * @param {string} schemeId
 * @returns {Array<{id:string, dcr:number, status:string, selectedSize:string|null, governingCheck:string|null, memberType:string}>}
 */
export function getMemberDcrChecks(schemeId) {
  const env = _sizingCache.get(schemeId);
  if (!env || !env.members?.length) return [];
  return env.members.map((m) => ({
    id: m.memberId,
    dcr: typeof m.dcr === "number" ? m.dcr : null,
    status: m.status || null,
    selectedSize: m.selectedSize || null,
    governingCheck: m.governingCheck || null,
    memberType: m.memberType || null,
  }));
}

/**
 * Return the scheme bundle in scene-friendly shape with explicit
 * (x, z) Three.js coordinates. Synchronous — reads from the cache.
 * If the cache miss, returns an empty bundle so the renderer doesn't
 * blow up; the caller can show a "Loading schemes…" message and
 * call `loadSchemes()` first.
 *
 * @param {string} schemeId
 * @param {{tx?:number, ty?:number}} [transform]
 * @returns {{columns:object[], beams:object[], shearWalls:object[], braces:object[]}}
 */
export function getSchemeBundle(schemeId, transform = { tx: 0, ty: 0 }) {
  const scheme = _schemeCache.get(schemeId);
  if (!scheme) {
    return { columns: [], beams: [], shearWalls: [], braces: [] };
  }
  const tx = Number.isFinite(transform?.tx) ? transform.tx : 0;
  const ty = Number.isFinite(transform?.ty) ? transform.ty : 0;

  // Merge in Agent 4 sizing data when available — falls back to nulls
  // (the inspector and overlay both handle missing data gracefully, so
  // this is safe to call before sizing has run).
  const sizingEnv = _sizingCache.get(schemeId);
  const memberMap = sizingEnv?._byMemberId || new Map();

  const columns = (scheme.columns || []).map((c) => {
    const sized = memberMap.get(c.id);
    return {
      id: c.id,
      x: c.x + tx,
      z: c.y + ty,                       // api.y → three.z (handled here, ONCE)
      startLevel: c.startLevel,
      endLevel: c.endLevel,
      size: sized?.selectedSize ?? c.size ?? null,
      gridLabel: c.gridLabel ?? null,
      dcr: sized?.dcr ?? c.dcr ?? null,
      status: sized?.status ?? c.status ?? null,
      governingCheck: sized?.governingCheck ?? null,
      weightPlf: sized?.weightPlf ?? null,
      axialLoad: c.axialLoad ?? null,
      tributaryArea: c.tributaryArea ?? null,
      locked: !!c.locked,
      source: c.source || "generated",
    };
  });

  const beams = (scheme.beams || []).map((b) => {
    const sized = memberMap.get(b.id);
    return {
      id: b.id,
      start: { x: b.start.x + tx, z: b.start.y + ty },
      end:   { x: b.end.x   + tx, z: b.end.y   + ty },
      levelId: b.levelId,
      size: sized?.selectedSize ?? b.size ?? null,
      dcr: sized?.dcr ?? b.dcr ?? null,
      status: sized?.status ?? b.status ?? null,
      governingCheck: sized?.governingCheck ?? null,
      weightPlf: sized?.weightPlf ?? null,
      span: b.span ?? null,
    };
  });

  // Convert each shear wall (centerline + thickness) into a 4-point
  // boundary polygon — that's the shape `buildSchemeShearWall`
  // expects. Agent 3 always emits an empty shearWalls list right
  // now; this conversion is here so the path stays correct when the
  // lateral-system agent eventually populates the field.
  const shearWalls = (scheme.shearWalls || []).map((w) => {
    const startW = { x: w.start.x + tx, z: w.start.y + ty };
    const endW   = { x: w.end.x   + tx, z: w.end.y   + ty };
    const dx = endW.x - startW.x;
    const dz = endW.z - startW.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const tFt = (w.thickness ?? 12) / 12;  // inches → ft
    let nx = 0, nz = 0;
    if (length > 1e-6) {
      // Perpendicular unit vector × half-thickness.
      nx = (-dz / length) * (tFt / 2);
      nz = ( dx / length) * (tFt / 2);
    }
    const boundary = [
      { x: startW.x + nx, z: startW.z + nz },
      { x: endW.x   + nx, z: endW.z   + nz },
      { x: endW.x   - nx, z: endW.z   - nz },
      { x: startW.x - nx, z: startW.z - nz },
    ];
    return {
      id: w.id,
      boundary,
      direction: null,
      thickness: w.thickness ?? 12,
      dcr: w.dcr ?? null,
      status: w.status ?? null,
      length,
    };
  });

  const braces = (scheme.braces || []).map((br) => ({
    id: br.id,
    start: { x: br.start.x + tx, z: br.start.y + ty },
    end:   { x: br.end.x   + tx, z: br.end.y   + ty },
    levels: br.levels || [],
    dcr: br.dcr ?? null,
    status: br.status ?? null,
  }));

  return { columns, beams, shearWalls, braces };
}

// ---------------------------------------------------------------------------
// Diagnostics — useful for the inspector / sizing pages
// ---------------------------------------------------------------------------

export function getCurrentGeometryId() {
  return _activeGeometryId;
}

export function getCurrentGenerationRunId() {
  return _activeRunId;
}

export function getCurrentProjectId() {
  return _activeProjectId;
}
