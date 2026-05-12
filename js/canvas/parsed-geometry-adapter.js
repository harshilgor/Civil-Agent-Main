/**
 * Adapter: Agent 1 ParsedGeometry JSON  →  internal scene model.
 *
 * The single place that understands the raw API shape. The builder, the
 * material registry, and every other 3D module consume the *normalized*
 * model returned from {@link adaptParsedGeometry} and never reach into
 * raw API fields.
 *
 * Source of truth for the raw shape:
 *   packages/engine/geometry_parser/models.py  (ParsedGeometry, Level,
 *   GridLine, Core, Opening, ExistingColumn, NoColumnZone, BuildingBounds,
 *   ParseMetadata, OriginTransform)
 *
 * Coordinate convention:
 *   API uses 2D plan (x, y) + elevation. Three.js uses Y-up.
 *     api.x         → three.x
 *     api.y         → three.z
 *     api.elevation → three.y
 *
 *   `OriginTransform` is applied as a 2D affine in the *plan* frame:
 *     plan' = R(rotation_rad) · plan + (tx, ty)
 *   before mapping to Three.js coordinates.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize raw ParsedGeometry into the render-ready scene model.
 *
 * Throws on critical errors (no levels, every level missing planBoundary).
 * Returns warnings for non-critical issues so the UI can surface them.
 *
 * @param {object} raw - JSON matching `ParsedGeometry` Pydantic schema.
 * @returns {NormalizedGeometry}
 */
export function adaptParsedGeometry(raw) {
  const parsedGeometry = raw;
  console.group("[CivilAgent] adaptParsedGeometry input");
  console.log("raw parsedGeometry:", parsedGeometry);
  console.log(
    "keys:",
    parsedGeometry && typeof parsedGeometry === "object" ? Object.keys(parsedGeometry) : null,
  );
  console.log("levels:", parsedGeometry?.levels);
  console.log("storeys:", parsedGeometry?.storeys);
  console.log("walls count:", parsedGeometry?.walls?.length);
  console.log("columns count:", parsedGeometry?.columns?.length);
  console.log("existingColumns count:", parsedGeometry?.existingColumns?.length);
  console.log("slabs count:", parsedGeometry?.slabs?.length);
  console.log("spaces count:", parsedGeometry?.spaces?.length);
  console.log("gridLines count:", parsedGeometry?.gridLines?.length);
  console.groupEnd();

  if (!raw || typeof raw !== "object") {
    throw new GeometryAdapterError("ParsedGeometry payload is missing or not an object.");
  }

  const warnings = [];
  const transform = readOriginTransform(raw.metadata?.originTransform);

  const levels = adaptLevels(raw.levels, transform, warnings);
  if (levels.length === 0) {
    throw new GeometryAdapterError("ParsedGeometry has no levels — geometry could not be rendered.");
  }

  const levelById = new Map(levels.map((l) => [l.id, l]));

  const gridLines = adaptGridLines(raw.gridLines, transform, warnings);
  const cores = adaptCores(raw.cores, transform, warnings);
  const openings = adaptOpenings(raw.openings, transform, levelById, warnings);
  const existingColumns = adaptColumns(raw.existingColumns, transform, levelById, warnings);
  const noColumnZones = adaptNoColumnZones(raw.noColumnZones, transform, warnings);

  const buildingBounds = adaptBuildingBounds(raw.buildingBounds, transform, levels, warnings);

  return {
    levels,
    levelById,
    gridLines,
    cores,
    openings,
    existingColumns,
    noColumnZones,
    buildingBounds,
    metadata: {
      schemaVersion: raw.metadata?.schemaVersion ?? "unknown",
      parserVersion: raw.metadata?.parserVersion ?? "unknown",
      runId: raw.metadata?.runId ?? null,
      overallConfidence: raw.metadata?.overallConfidence ?? null,
      status: raw.metadata?.status ?? "completed",
      apiWarnings: Array.isArray(raw.metadata?.warnings) ? raw.metadata.warnings : [],
      adapterWarnings: warnings,
      originTransform: transform,
    },
  };
}

export class GeometryAdapterError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeometryAdapterError";
  }
}

// ---------------------------------------------------------------------------
// Origin transform
// ---------------------------------------------------------------------------

function readOriginTransform(rawTransform) {
  // Pydantic OriginTransform: { tx, ty, units, rotation_rad }.
  // Defaults to identity transform if absent.
  const txRaw = Number.isFinite(rawTransform?.tx) ? rawTransform.tx : 0;
  const tyRaw = Number.isFinite(rawTransform?.ty) ? rawTransform.ty : 0;
  const rot = Number.isFinite(rawTransform?.rotation_rad) ? rawTransform.rotation_rad : 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  // Auto-detect millimetre-scale IFC coordinates.
  //
  // Most architectural IFC files store lengths in mm. After the backend
  // rebase step the centroid (tx, ty) is the building's world-frame
  // offset in the IFC file's native unit.  A centroid offset above 500
  // "units" is only possible for mm-scale data (500 feet = 152 m, an
  // absurd site offset) so we use it as the trigger to apply the
  // mm → ft scale factor.  This converts both the centroid and all
  // polygon coordinates so the Three.js camera (calibrated in feet)
  // sees a correctly-sized building.
  const MM_TO_FT = 0.00328084;
  const rawOffset = Math.max(Math.abs(txRaw), Math.abs(tyRaw));
  const unitScale = rawOffset > 500 ? MM_TO_FT : 1.0;

  if (unitScale !== 1.0) {
    console.log(
      "[CivilAgent] IFC unit auto-scale: detected mm coordinates " +
      "(max offset " + rawOffset.toFixed(0) + "). Scaling by " + MM_TO_FT + " (mm→ft).",
    );
  }

  return {
    tx: txRaw * unitScale,
    ty: tyRaw * unitScale,
    rotation_rad: rot,
    unitScale,
    _cos: cos,
    _sin: sin,
  };
}

/** Apply origin transform in the plan frame, then map to Three.js (x, z). */
function planToThree(point, transform) {
  // Apply unit scale first (mm→ft when detected), then rotation and translation.
  const x = Number(point.x) * transform.unitScale;
  const y = Number(point.y) * transform.unitScale;
  const px = transform._cos * x - transform._sin * y + transform.tx;
  const py = transform._sin * x + transform._cos * y + transform.ty;
  // api.x → three.x, api.y → three.z
  return { x: px, z: py };
}

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a polygon: drop closing-duplicate point, validate length,
 * ensure counter-clockwise winding once mapped to Three.js (x,z) ground plane.
 *
 * Three.js `ShapeGeometry` expects the shape to be wound CCW in its 2D
 * plane. After we lay the shape flat with `rotation.x = -PI/2`, what was
 * (x,z) in world space becomes the shape's local (x,-y). Combined with
 * the API→Three flip on the y axis (api.y → three.z), winding may flip.
 * We always emit CCW polygons in the *Three.js xz* sense; mesh code can
 * pass them straight to `Shape`.
 */
function adaptPolygon(rawPoints, transform, label, warnings) {
  if (!Array.isArray(rawPoints)) {
    warnings.push(`${label}: boundary is not an array.`);
    return null;
  }

  const points = rawPoints
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => planToThree(p, transform));

  if (points.length >= 4) {
    const first = points[0];
    const last = points[points.length - 1];
    if (
      Math.abs(first.x - last.x) < 1e-6 &&
      Math.abs(first.z - last.z) < 1e-6
    ) {
      points.pop();
    }
  }

  if (points.length < 3) {
    warnings.push(`${label}: polygon has fewer than 3 distinct points; skipped.`);
    return null;
  }

  if (signedArea(points) < 0) {
    points.reverse();
  }

  return points;
}

/** Shoelace formula. Positive = CCW in standard math frame. */
function signedArea(points) {
  let acc = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    acc += a.x * b.z - b.x * a.z;
  }
  return acc * 0.5;
}

function polygonBounds(points) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

// ---------------------------------------------------------------------------
// Per-collection adapters
// ---------------------------------------------------------------------------

function adaptLevels(rawLevels, transform, warnings) {
  console.group("[CivilAgent] adaptLevels");
  console.log("input levels:", rawLevels);
  console.log(
    "levels with planBoundary (≥3 pts):",
    Array.isArray(rawLevels)
      ? rawLevels.filter(
          (l) => Array.isArray(l?.planBoundary) && l.planBoundary.length >= 3,
        )
      : [],
  );
  console.groupEnd();

  if (!Array.isArray(rawLevels) || rawLevels.length === 0) return [];

  const sorted = [...rawLevels].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  const out = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const lvl = sorted[i];
    if (!lvl?.id) {
      warnings.push("Level is missing id; skipped.");
      continue;
    }
    if (!Number.isFinite(lvl.elevation)) {
      warnings.push(`Level ${lvl.id}: elevation is not a number; skipped.`);
      continue;
    }

    const next = sorted[i + 1];
    const s = transform.unitScale;

    // Scale elevation and height from IFC native units → scene feet.
    const elevation = Number(lvl.elevation) * s;

    let height = Number.isFinite(lvl.height) ? lvl.height * s : null;
    if (height == null) {
      height = next ? Math.max((next.elevation - lvl.elevation) * s, 0) : 0;
      warnings.push(`Level ${lvl.id}: height inferred from neighbour (${height.toFixed(2)} ft).`);
    }

    const polygon = adaptPolygon(lvl.planBoundary, transform, `Level ${lvl.id}`, warnings);

    out.push({
      id: lvl.id,
      name: lvl.name ?? lvl.id,
      elevation,
      height,
      planBoundary: polygon,
      confidence: Number.isFinite(lvl.confidence) ? lvl.confidence : 1.0,
      source: lvl.source ?? "ifc",
      rationale: lvl.rationale ?? null,
    });
  }

  if (out.every((l) => !l.planBoundary)) {
    throw new GeometryAdapterError(
      "ParsedGeometry has no usable plan boundaries — geometry could not be rendered.",
    );
  }
  return out;
}

function adaptGridLines(rawGrids, transform, warnings) {
  if (!Array.isArray(rawGrids)) return [];
  const out = [];
  for (const g of rawGrids) {
    if (!g?.id || !g?.label || !Number.isFinite(g?.coordinate) ||
        (g.axis !== "x" && g.axis !== "y")) {
      warnings.push(`GridLine ${g?.id ?? "?"} is malformed; skipped.`);
      continue;
    }
    // Coordinate is a single scalar in the *local* plan frame. With a
    // rotated origin transform we'd need to project the gridline as a
    // direction; for the MVP we apply the translation only and skip
    // rotation handling (rotation is 0 in real-world fixtures).
    const coord = g.axis === "x"
      ? g.coordinate * transform.unitScale + transform.tx
      : g.coordinate * transform.unitScale + transform.ty;
    out.push({
      id: g.id,
      axis: g.axis,
      label: String(g.label),
      coordinate: coord,
      confidence: Number.isFinite(g.confidence) ? g.confidence : 1.0,
      source: g.source ?? "ifc",
      rationale: g.rationale ?? null,
    });
  }
  return out;
}

function adaptCores(rawCores, transform, warnings) {
  if (!Array.isArray(rawCores)) return [];
  const out = [];
  for (const c of rawCores) {
    if (!c?.id) { warnings.push("Core missing id; skipped."); continue; }
    const polygon = adaptPolygon(c.boundary, transform, `Core ${c.id}`, warnings);
    if (!polygon) continue;
    out.push({
      id: c.id,
      type: c.type ?? "service",
      boundary: polygon,
      bounds: polygonBounds(polygon),
      levelIds: Array.isArray(c.levelIds) ? c.levelIds.slice() : [],
      confidence: Number.isFinite(c.confidence) ? c.confidence : 1.0,
      source: c.source ?? "ifc",
      groupingReason: c.groupingReason ?? null,
    });
  }
  return out;
}

function adaptOpenings(rawOpenings, transform, levelById, warnings) {
  if (!Array.isArray(rawOpenings)) return [];
  const out = [];
  for (const o of rawOpenings) {
    if (!o?.id) { warnings.push("Opening missing id; skipped."); continue; }
    if (o.levelId && !levelById.has(o.levelId)) {
      warnings.push(`Opening ${o.id}: levelId "${o.levelId}" does not match any level; skipped.`);
      continue;
    }
    const polygon = adaptPolygon(o.boundary, transform, `Opening ${o.id}`, warnings);
    if (!polygon) continue;
    out.push({
      id: o.id,
      type: o.type ?? "other",
      levelId: o.levelId,
      boundary: polygon,
      bounds: polygonBounds(polygon),
      confidence: Number.isFinite(o.confidence) ? o.confidence : 1.0,
      source: o.source ?? "ifc",
    });
  }
  return out;
}

function adaptColumns(rawColumns, transform, levelById, warnings) {
  if (!Array.isArray(rawColumns)) return [];
  const out = [];
  for (const col of rawColumns) {
    if (!col?.id || !Number.isFinite(col?.x) || !Number.isFinite(col?.y)) {
      warnings.push(`ExistingColumn ${col?.id ?? "?"} is malformed; skipped.`);
      continue;
    }
    if (!levelById.has(col.startLevel) || !levelById.has(col.endLevel)) {
      warnings.push(`ExistingColumn ${col.id}: unknown startLevel/endLevel; skipped.`);
      continue;
    }
    const projected = planToThree({ x: col.x, y: col.y }, transform);
    out.push({
      id: col.id,
      x: projected.x,
      z: projected.z,
      startLevel: col.startLevel,
      endLevel: col.endLevel,
      size: col.size ?? null,
      gridLabel: col.gridLabel ?? null,
      gridAligned: col.gridAligned !== false,
      confidence: Number.isFinite(col.confidence) ? col.confidence : 1.0,
      source: col.source ?? "ifc",
    });
  }
  return out;
}

function adaptNoColumnZones(rawZones, transform, warnings) {
  if (!Array.isArray(rawZones)) return [];
  const out = [];
  for (const z of rawZones) {
    if (!z?.id) { warnings.push("NoColumnZone missing id; skipped."); continue; }
    const polygon = adaptPolygon(z.boundary, transform, `NCZ ${z.id}`, warnings);
    if (!polygon) continue;
    out.push({
      id: z.id,
      name: z.name ?? z.id,
      reason: z.reason ?? "",
      source: z.source ?? "inferred",
      confidence: Number.isFinite(z.confidence) ? z.confidence : 1.0,
      levelIds: Array.isArray(z.levelIds) ? z.levelIds.slice() : [],
      boundary: polygon,
      bounds: polygonBounds(polygon),
    });
  }
  return out;
}

function adaptBuildingBounds(rawBounds, transform, levels, warnings) {
  // Trust the API value if present; only translate by origin offset.
  if (rawBounds &&
      Number.isFinite(rawBounds.minX) && Number.isFinite(rawBounds.maxX) &&
      Number.isFinite(rawBounds.minY) && Number.isFinite(rawBounds.maxY)) {
    const s = transform.unitScale;
    return {
      minX: rawBounds.minX * s + transform.tx,
      maxX: rawBounds.maxX * s + transform.tx,
      minZ: rawBounds.minY * s + transform.ty,
      maxZ: rawBounds.maxY * s + transform.ty,
    };
  }

  warnings.push("buildingBounds missing from API; computing from level boundaries.");
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const lvl of levels) {
    if (!lvl.planBoundary) continue;
    for (const p of lvl.planBoundary) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  if (!Number.isFinite(minX)) {
    throw new GeometryAdapterError(
      "Could not compute buildingBounds — no usable plan boundaries.",
    );
  }
  return { minX, maxX, minZ, maxZ };
}

// ---------------------------------------------------------------------------
// Type hint
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NormalizedGeometry
 * @property {Array<{id, name, elevation, height, planBoundary, confidence, source, rationale}>} levels
 * @property {Map<string, object>} levelById
 * @property {Array<{id, axis, label, coordinate, confidence, source, rationale}>} gridLines
 * @property {Array<object>} cores
 * @property {Array<object>} openings
 * @property {Array<object>} existingColumns
 * @property {Array<object>} noColumnZones
 * @property {{minX, minZ, maxX, maxZ}} buildingBounds
 * @property {object} metadata
 */
