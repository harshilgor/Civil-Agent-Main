/**
 * Three.js mesh factories for structural elements.
 *
 * Two API styles live side-by-side:
 *
 *   1. Legacy `[x, y, w, h]` rectangle builders (used by the old mock-driven
 *      paths and a couple of pre-existing call sites). Kept stable for
 *      compatibility while StructuralModelBuilder migrates.
 *
 *   2. Polygon builders (`buildFloorPlatePolygon`, `buildCorePolygon`,
 *      `buildNoColumnZonePolygon`, `buildOpeningPolygon`) that consume
 *      the normalized shape produced by parsed-geometry-adapter.js.
 *
 * All meshes:
 *   * tag `userData` with `{ type, id, layerType, baseOpacity }`,
 *   * use per-instance materials (cloning shared factories from
 *     material-registry.js) so opacity tweens don't bleed between meshes,
 *   * never enable `castShadow` / `receiveShadow` — shadows are off in
 *     the engineering review surface.
 *
 * All units are feet (1 scene unit = 1 ft).
 */

import * as THREE from "three";
import { BASE_MATERIALS, PALETTE, dcrToColor } from "./material-registry.js";

// ─────────────────────────────────────────────────────────────
// Status colors (legacy callers; new code should import dcrToColor)
// ─────────────────────────────────────────────────────────────

const COLORS = {
  pass: 0x22c55e,
  warn: 0xeab308,
  fail: 0xef4444,
  unsized: 0x555555,
};

function statusColor(status) {
  return COLORS[status] ?? COLORS.unsized;
}

// ─────────────────────────────────────────────────────────────
// Polygon helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build a flat Three.js Shape from an array of {x, z} points in world
 * space. The returned shape is in *local* XY (with local-Y mapped to
 * world Z), ready to be rotated `-PI/2` around X.
 *
 * Center is the polygon centroid in world XZ; emitted shape coords are
 * relative to that centroid so the resulting mesh can be positioned
 * via mesh.position rather than offsetting every vertex.
 */
function polygonToShape(points) {
  if (!points || points.length < 3) return null;
  const center = polygonCentroid(points);
  const shape = new THREE.Shape();
  shape.moveTo(points[0].x - center.x, points[0].z - center.z);
  for (let i = 1; i < points.length; i += 1) {
    shape.lineTo(points[i].x - center.x, points[i].z - center.z);
  }
  shape.closePath();
  return { shape, center };
}

function polygonCentroid(points) {
  // Geometric centroid (signed-area formulation) — accurate even for
  // non-convex polygons. Falls back to bounding-box center if degenerate.
  let cx = 0, cz = 0, area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.z - b.x * a.z;
    area += cross;
    cx += (a.x + b.x) * cross;
    cz += (a.z + b.z) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-6) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
  }
  return { x: cx / (6 * area), z: cz / (6 * area) };
}

function polygonToWorldLine(points, y) {
  const verts = points.map((p) => new THREE.Vector3(p.x, y, p.z));
  verts.push(verts[0].clone());
  return new THREE.BufferGeometry().setFromPoints(verts);
}

// ─────────────────────────────────────────────────────────────
// Polygon-based builders (consume normalized geometry)
// ─────────────────────────────────────────────────────────────

/**
 * Floor plate from a plan polygon.
 *   level: { id, elevation, planBoundary }
 *   planBoundary: array of { x, z } in Three.js world coords (CCW).
 */
export function buildFloorPlatePolygon(level) {
  const polyData = polygonToShape(level.planBoundary);
  if (!polyData) return null;

  const geo = new THREE.ShapeGeometry(polyData.shape);
  const mat = BASE_MATERIALS.floorPlate();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(polyData.center.x, level.elevation, polyData.center.z);
  mesh.userData = {
    type: "slab",
    id: level.id,
    layerType: "slab",
    baseOpacity: 0.35,
    levelId: level.id,
    selectable: true,
    data: { levelId: level.id, elevation: level.elevation },
  };

  // Edge outline in world space — keeps the slab boundary readable even
  // when slab opacity drops to ~0.1 on the Sizing page.
  const edgeGeo = polygonToWorldLine(level.planBoundary, level.elevation + 0.02);
  const edgeMat = BASE_MATERIALS.floorPlateEdge();
  const edgeLine = new THREE.LineLoop(edgeGeo, edgeMat);
  // LineLoop is rendered as world-space siblings of the slab; attaching
  // it to the slab as a child would inherit the rotation.
  edgeLine.userData = {
    type: "slab",
    id: `${level.id}-edge`,
    layerType: "slab-edge",
    baseOpacity: 0.6,
    levelId: level.id,
    selectable: false,
  };
  mesh.userData.edgeRef = edgeLine;
  return { mesh, edge: edgeLine };
}

/** Core volume extruded between the lowest and highest level it spans. */
export function buildCorePolygon(core, levels) {
  if (!core.boundary || core.boundary.length < 3) return null;

  const polyData = polygonToShape(core.boundary);
  if (!polyData) return null;

  const span = coreVerticalSpan(core, levels);
  if (span.height <= 0) return null;

  const geo = new THREE.ExtrudeGeometry(polyData.shape, {
    depth: span.height,
    bevelEnabled: false,
  });
  const mat = BASE_MATERIALS.core();
  const mesh = new THREE.Mesh(geo, mat);
  // ExtrudeGeometry extrudes along +Z in local space. Rotate so the
  // extrusion axis becomes world Y.
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(polyData.center.x, span.bottom, polyData.center.z);
  mesh.userData = {
    type: "core",
    id: core.id,
    layerType: "core",
    baseOpacity: 0.45,
    levelId: null,
    selectable: true,
    data: core,
  };

  // Edge outline: one polygon at top, one at bottom.
  const bottomEdge = new THREE.LineLoop(
    polygonToWorldLine(core.boundary, span.bottom + 0.02),
    BASE_MATERIALS.coreEdge(),
  );
  bottomEdge.userData = { type: "core", id: `${core.id}-edge-b`, layerType: "core-edge", baseOpacity: 0.55, selectable: false };

  const topEdge = new THREE.LineLoop(
    polygonToWorldLine(core.boundary, span.bottom + span.height - 0.02),
    BASE_MATERIALS.coreEdge(),
  );
  topEdge.userData = { type: "core", id: `${core.id}-edge-t`, layerType: "core-edge", baseOpacity: 0.55, selectable: false };

  return { mesh, edges: [bottomEdge, topEdge] };
}

function coreVerticalSpan(core, levels) {
  if (!levels.length) return { bottom: 0, height: 0 };
  const ids = new Set(core.levelIds && core.levelIds.length ? core.levelIds : levels.map((l) => l.id));
  let bottom = Infinity;
  let top = -Infinity;
  for (const lvl of levels) {
    if (!ids.has(lvl.id)) continue;
    if (lvl.elevation < bottom) bottom = lvl.elevation;
    const ceiling = lvl.elevation + (lvl.height || 0);
    if (ceiling > top) top = ceiling;
  }
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) {
    bottom = levels[0].elevation;
    top = levels[levels.length - 1].elevation + (levels[levels.length - 1].height || 0);
  }
  return { bottom, height: Math.max(top - bottom, 0) };
}

/** No-column zone — flat polygon at level top with a dashed outline. */
export function buildNoColumnZonePolygon(zone, level) {
  if (!zone.boundary || zone.boundary.length < 3) return null;
  const polyData = polygonToShape(zone.boundary);
  if (!polyData) return null;

  const geo = new THREE.ShapeGeometry(polyData.shape);
  const mat = BASE_MATERIALS.noColumnZoneFill();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(polyData.center.x, level.elevation + 0.18, polyData.center.z);
  mesh.userData = {
    type: "noColumnZone",
    id: `${zone.id}@${level.id}`,
    layerType: "noColumnZone",
    baseOpacity: 0.10,
    levelId: level.id,
    selectable: true,
    data: { ...zone, levelId: level.id },
  };

  const lineGeo = polygonToWorldLine(zone.boundary, level.elevation + 0.20);
  const lineMat = BASE_MATERIALS.noColumnZoneOutline();
  const line = new THREE.LineLoop(lineGeo, lineMat);
  line.computeLineDistances();
  line.userData = {
    type: "noColumnZone",
    id: `${zone.id}@${level.id}-outline`,
    layerType: "noColumnZone",
    baseOpacity: 0.55,
    levelId: level.id,
    selectable: false,
  };

  return { mesh, outline: line };
}

/** Floor opening (shaft / atrium / stair well) — outlined polygon. */
export function buildOpeningPolygon(opening, level) {
  if (!opening.boundary || opening.boundary.length < 3) return null;
  const polyData = polygonToShape(opening.boundary);
  if (!polyData) return null;

  const geo = new THREE.ShapeGeometry(polyData.shape);
  const mat = BASE_MATERIALS.openingFill();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(polyData.center.x, level.elevation + 0.05, polyData.center.z);
  mesh.userData = {
    type: "opening",
    id: opening.id,
    layerType: "opening",
    baseOpacity: 0.10,
    levelId: opening.levelId,
    selectable: true,
    data: opening,
  };

  const lineGeo = polygonToWorldLine(opening.boundary, level.elevation + 0.08);
  const line = new THREE.LineLoop(lineGeo, BASE_MATERIALS.openingOutline());
  line.userData = {
    type: "opening",
    id: `${opening.id}-outline`,
    layerType: "opening",
    baseOpacity: 0.6,
    levelId: opening.levelId,
    selectable: false,
  };
  return { mesh, outline: line };
}

/**
 * Existing column from ParsedGeometry — extruded prism between
 * startLevel and endLevel.
 *   col: { id, x, z, startLevel, endLevel, size, ... }
 *   levelById: Map<levelId, Level>
 */
export function buildExistingColumn(col, levelById) {
  const start = levelById.get(col.startLevel);
  const end = levelById.get(col.endLevel);
  if (!start || !end) return null;

  const bottom = Math.min(start.elevation, end.elevation);
  const topElev = Math.max(start.elevation + (start.height || 0),
                           end.elevation + (end.height || 0));
  const height = Math.max(topElev - bottom, 1);
  const w = 2.0;

  const geo = new THREE.BoxGeometry(w, height, w);
  const mat = BASE_MATERIALS.column();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(col.x, bottom + height / 2, col.z);
  mesh.userData = {
    type: "existingColumn",
    id: col.id,
    layerType: "column",
    baseOpacity: 0.8,
    levelId: null,
    selectable: true,
    data: col,
  };
  return mesh;
}

// ─────────────────────────────────────────────────────────────
// Member builders (consumed by the scheme adapter pathway)
// ─────────────────────────────────────────────────────────────

export function buildSchemeColumn(col, levelById) {
  const start = levelById.get(col.startLevel);
  const end = levelById.get(col.endLevel);
  if (!start || !end) return null;

  const bottom = Math.min(start.elevation, end.elevation);
  const topElev = Math.max(start.elevation + (start.height || 0),
                           end.elevation + (end.height || 0));
  const height = Math.max(topElev - bottom, 1);
  const w = parseColumnSize(col.size) / 12; // inches → ft

  const geo = new THREE.BoxGeometry(w, height, w);
  const mat = BASE_MATERIALS.column();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(col.x, bottom + height / 2, col.z);
  mesh.userData = {
    type: "column",
    id: col.id,
    layerType: "column",
    baseOpacity: 0.8,
    levelId: null,
    selectable: true,
    data: col,
  };
  return mesh;
}

export function buildSchemeBeam(beam, levelById) {
  const lvl = levelById.get(beam.levelId);
  if (!lvl) return null;
  const yTop = lvl.elevation + (lvl.height || 0);

  const start = new THREE.Vector3(beam.start.x, yTop, beam.start.z);
  const end = new THREE.Vector3(beam.end.x, yTop, beam.end.z);
  const length = start.distanceTo(end);
  if (length < 0.5) return null;

  const depth = parseBeamDepth(beam.size) / 12;
  const width = 0.6;

  const geo = new THREE.BoxGeometry(length, depth, width);
  const mat = BASE_MATERIALS.beam();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(start).lerp(end, 0.5);
  mesh.position.y -= depth / 2;
  const dir = new THREE.Vector3().subVectors(end, start).normalize();
  mesh.rotation.y = -Math.atan2(dir.z, dir.x);
  mesh.userData = {
    type: "beam",
    id: beam.id,
    layerType: "beam",
    baseOpacity: 0.75,
    levelId: beam.levelId,
    selectable: true,
    data: beam,
  };
  return mesh;
}

/** Polygon shear wall — plan polygon extruded over the building height. */
export function buildSchemeShearWall(wall, levels) {
  if (!wall.boundary || wall.boundary.length < 3) return null;
  const polyData = polygonToShape(wall.boundary);
  if (!polyData) return null;

  const bottom = levels[0].elevation;
  const top = levels[levels.length - 1].elevation + (levels[levels.length - 1].height || 0);
  const height = Math.max(top - bottom, 1);

  const geo = new THREE.ExtrudeGeometry(polyData.shape, {
    depth: height,
    bevelEnabled: false,
  });
  const mat = BASE_MATERIALS.shearWall();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(polyData.center.x, bottom, polyData.center.z);
  mesh.userData = {
    type: "shearWall",
    id: wall.id,
    layerType: "wall",
    baseOpacity: 0.65,
    levelId: null,
    selectable: true,
    data: wall,
  };

  const edgeGeo = new THREE.EdgesGeometry(geo);
  const edgeMat = BASE_MATERIALS.shearWallEdge();
  const edges = new THREE.LineSegments(edgeGeo, edgeMat);
  edges.rotation.copy(mesh.rotation);
  edges.position.copy(mesh.position);
  edges.userData = {
    type: "shearWall",
    id: `${wall.id}-edge`,
    layerType: "wall-edge",
    baseOpacity: 0.55,
    selectable: false,
  };
  return { mesh, edges };
}

// ─────────────────────────────────────────────────────────────
// Grid lines (polyline + simple HTML labels handled elsewhere)
// ─────────────────────────────────────────────────────────────

export function buildGridLinesPolygon(gridLines, bounds, opts = {}) {
  const group = new THREE.Group();
  group.userData = { type: "grids" };
  const padX = opts.padX ?? 4;
  const padZ = opts.padZ ?? 4;

  for (const g of gridLines) {
    const pts = [];
    if (g.axis === "x") {
      pts.push(new THREE.Vector3(g.coordinate, 0.05, bounds.minZ - padZ));
      pts.push(new THREE.Vector3(g.coordinate, 0.05, bounds.maxZ + padZ));
    } else {
      pts.push(new THREE.Vector3(bounds.minX - padX, 0.05, g.coordinate));
      pts.push(new THREE.Vector3(bounds.maxX + padX, 0.05, g.coordinate));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, BASE_MATERIALS.gridLine());
    line.userData = {
      type: "grid",
      id: g.id,
      layerType: "grid",
      baseOpacity: 0.55,
      selectable: false,
      data: g,
    };
    group.add(line);
  }
  return group;
}

// ─────────────────────────────────────────────────────────────
// Loads + tributary
// ─────────────────────────────────────────────────────────────

export function buildLoadArrow(x, z, level, magnitude) {
  const length = Math.min(Math.max(magnitude / 25, 3), 6);
  const dir = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3(x, level.elevation + (level.height || 0) + length, z);
  const arrow = new THREE.ArrowHelper(dir, origin, length, PALETTE.loadArrow, 1.0, 0.45);
  arrow.userData = {
    type: "load",
    id: `load@${x.toFixed(1)},${z.toFixed(1)},${level.id}`,
    layerType: "load",
    baseOpacity: 0.55,
    levelId: level.id,
    selectable: false,
  };
  if (arrow.line?.material) {
    arrow.line.material.transparent = true;
    arrow.line.material.opacity = 0.55;
  }
  if (arrow.cone?.material) {
    arrow.cone.material.transparent = true;
    arrow.cone.material.opacity = 0.55;
  }
  return arrow;
}

export function buildTributaryPolygon(points, level, color) {
  // points: [[x, z], ...] in world space
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape);
  const mat = BASE_MATERIALS.tributaryArea();
  if (color != null) mat.color.setHex(color);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = level.elevation + 0.22;
  mesh.userData = {
    type: "tributary",
    id: `tributary@${points[0][0]},${points[0][1]},${level.id}`,
    layerType: "tributary",
    baseOpacity: 0.10,
    levelId: level.id,
    selectable: false,
  };
  return mesh;
}

// ─────────────────────────────────────────────────────────────
// Color helpers (kept for legacy callers that import dcrColor)
// ─────────────────────────────────────────────────────────────

export function dcrColor(dcr) {
  return dcrToColor(dcr);
}

export function loadHeatmapColor(value, max) {
  const t = Math.min(Math.max(value / max, 0), 1);
  if (t < 0.4) {
    return new THREE.Color(0x3b82f6).lerp(new THREE.Color(0x22c55e), t / 0.4).getHex();
  }
  if (t < 0.75) {
    return new THREE.Color(0x22c55e).lerp(new THREE.Color(0xeab308), (t - 0.4) / 0.35).getHex();
  }
  return new THREE.Color(0xeab308).lerp(new THREE.Color(0xef4444), (t - 0.75) / 0.25).getHex();
}

// ─────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────

export function parseBeamDepth(size) {
  if (!size) return 18;
  const match = size.match(/W(\d+)/i);
  return match ? Number(match[1]) : 18;
}

export function parseColumnSize(size) {
  if (!size) return 14;
  const match = size.match(/W(\d+)/i);
  return match ? Number(match[1]) : 14;
}

// ─────────────────────────────────────────────────────────────
// Legacy [x, y, w, h] builders — preserved for back-compat callers
// (svg-canvas mocks et al.). Delete once nothing imports them.
// ─────────────────────────────────────────────────────────────

export function buildFloorPlate(level, bounds, opacity = 0.35) {
  const minX = bounds.minX ?? 0;
  const minY = bounds.minZ ?? bounds.minY ?? 0;
  const maxX = bounds.maxX ?? 0;
  const maxY = bounds.maxZ ?? bounds.maxY ?? 0;
  const w = maxX - minX;
  const d = maxY - minY;
  const geo = new THREE.PlaneGeometry(w, d);
  const mat = new THREE.MeshLambertMaterial({
    color: PALETTE.floorPlate, transparent: true, opacity,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(minX + w / 2, level.elevation, minY + d / 2);
  mesh.userData = {
    type: "slab", id: level.id, layerType: "slab",
    baseOpacity: opacity, levelId: level.id, selectable: true,
    data: level,
  };

  const edges = new THREE.EdgesGeometry(geo);
  const edgeLines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: PALETTE.floorEdge, transparent: true, opacity: 0.6 }),
  );
  edgeLines.userData = { layerType: "slab-edge", baseOpacity: 0.6 };
  mesh.add(edgeLines);
  return mesh;
}

export function buildColumn(column, level) {
  const w = 1.5;
  const h = level.height || 13;
  const geo = new THREE.BoxGeometry(w, h, w);
  const mat = new THREE.MeshLambertMaterial({
    color: PALETTE.column, transparent: true, opacity: 0.8,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(column.x, level.elevation + h / 2, column.y);
  mesh.userData = {
    type: "column", id: column.id, layerType: "column",
    status: column.status, baseOpacity: 0.8, baseColor: PALETTE.column,
    levelId: level.id, selectable: true, data: column,
  };
  return mesh;
}

export function buildColumnsForLevel(columnList, level) {
  const group = new THREE.Group();
  group.userData = { layerType: "column-group", level: level.id };
  columnList.forEach((c) => group.add(buildColumn(c, level)));
  return group;
}

export function buildBeam(beam, level) {
  const start = new THREE.Vector3(beam.start[0], level.elevation + level.height, beam.start[1]);
  const end = new THREE.Vector3(beam.end[0], level.elevation + level.height, beam.end[1]);
  const length = start.distanceTo(end);
  const depth = parseBeamDepth(beam.size) / 12;
  const width = 0.6;
  const geo = new THREE.BoxGeometry(length, depth, width);
  const mat = new THREE.MeshLambertMaterial({
    color: PALETTE.beam, transparent: true, opacity: 0.75,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(start.clone().lerp(end, 0.5));
  mesh.position.y -= depth / 2;
  const dir = new THREE.Vector3().subVectors(end, start).normalize();
  mesh.rotation.y = -Math.atan2(dir.z, dir.x);
  mesh.userData = {
    type: "beam", id: beam.id, layerType: "beam",
    status: beam.status, baseOpacity: 0.75, baseColor: PALETTE.beam,
    levelId: level.id, selectable: true, data: beam,
  };
  return mesh;
}

export function buildShearWall(wall, levels) {
  const [x, y, w, h] = wall.boundary;
  const totalHeight = levels.reduce((a, l) => a + l.height, 0);
  const isHorizontal = w > h;
  const length = isHorizontal ? w : h;
  const thickness = isHorizontal ? Math.max(h, 1.5) : Math.max(w, 1.5);
  const geo = new THREE.BoxGeometry(length, totalHeight, thickness);
  const mat = new THREE.MeshLambertMaterial({
    color: PALETTE.shearWall, transparent: true, opacity: 0.65,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x + w / 2, totalHeight / 2, y + h / 2);
  mesh.userData = {
    type: "shearWall", id: wall.id, layerType: "wall",
    status: wall.status, baseOpacity: 0.65, baseColor: PALETTE.shearWall,
    selectable: true, data: wall,
  };
  const edges = new THREE.EdgesGeometry(geo);
  const edgeLines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: PALETTE.shearWallEdge, transparent: true, opacity: 0.55 }),
  );
  edgeLines.userData = { layerType: "wall-edge", baseOpacity: 0.55 };
  mesh.add(edgeLines);
  return mesh;
}

export function buildCore(core, levels) {
  const [x, y, w, h] = core.boundary;
  const totalHeight = levels.reduce((a, l) => a + l.height, 0);
  const geo = new THREE.BoxGeometry(w, totalHeight, h);
  const mat = new THREE.MeshLambertMaterial({
    color: PALETTE.core, transparent: true, opacity: 0.45,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x + w / 2, totalHeight / 2, y + h / 2);
  mesh.userData = {
    type: "core", id: core.id, layerType: "core",
    baseOpacity: 0.45, baseColor: PALETTE.core,
    selectable: true, data: core,
  };
  const edges = new THREE.EdgesGeometry(geo);
  const edgeLines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: PALETTE.coreEdge, transparent: true, opacity: 0.55 }),
  );
  edgeLines.userData = { layerType: "core-edge", baseOpacity: 0.55 };
  mesh.add(edgeLines);
  return mesh;
}

export function buildNoColumnZone(zone, level) {
  const [x, y, w, h] = zone.boundary;
  const geo = new THREE.PlaneGeometry(w, h);
  const mat = new THREE.MeshBasicMaterial({
    color: PALETTE.noColumnZone, transparent: true, opacity: 0.10,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x + w / 2, level.elevation + 0.18, y + h / 2);
  mesh.userData = {
    type: "noColumnZone", id: zone.id, layerType: "noColumnZone",
    baseOpacity: 0.10, levelId: level.id, selectable: true, data: zone,
  };
  const points = [
    new THREE.Vector3(-w / 2, -h / 2, 0.02),
    new THREE.Vector3( w / 2, -h / 2, 0.02),
    new THREE.Vector3( w / 2,  h / 2, 0.02),
    new THREE.Vector3(-w / 2,  h / 2, 0.02),
    new THREE.Vector3(-w / 2, -h / 2, 0.02),
  ];
  const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
  const lineMat = new THREE.LineDashedMaterial({
    color: PALETTE.noColumnZone, transparent: true, opacity: 0.55,
    dashSize: 1.4, gapSize: 0.8,
  });
  const line = new THREE.Line(lineGeo, lineMat);
  line.computeLineDistances();
  line.userData = { layerType: "noColumnZone", baseOpacity: 0.55, selectable: false };
  mesh.add(line);
  return mesh;
}

export function buildGridLines(gridLines, bounds) {
  const xzBounds = {
    minX: bounds.minX, maxX: bounds.maxX,
    minZ: bounds.minZ ?? bounds.minY,
    maxZ: bounds.maxZ ?? bounds.maxY,
  };
  return buildGridLinesPolygon(gridLines, xzBounds);
}
