/**
 * Deterministic placement engine.
 *
 * Generates 4 placement strategies from a building grid + constraints,
 * with realistic relationships between column count, beam spans, beam
 * depths, steel weight, cost, and carbon. The frontend uses this until
 * a backend optimizer is wired in.
 *
 * Coordinates: plan-frame feet. X increases east, Y increases north,
 * Z is the building height direction (also feet).
 *
 * Public API:
 *   buildDefaultGrid()                              → Grid
 *   gridFromGeometry(parsedGeom)                    → Grid | null
 *   generateAllStrategies(grid, constraints, manualOverrides) → Strategy[]
 *   regenerateStrategy(strategy, grid, constraints, manualOverrides) → Strategy
 *   computeMetrics(strategy)                        → Metrics
 *   computeWarnings(strategy, constraints)          → string[]
 */

import { getPlanGeometry } from "../canvas/parsed-geometry-cache.js";

// ────────────────────────────────────────────────────────────────────
// Grid construction
// ────────────────────────────────────────────────────────────────────

const X_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const LEVEL_HEIGHT_FT = 13;
const TOTAL_LEVELS = 6;
const BUILDING_HEIGHT_FT = LEVEL_HEIGHT_FT * TOTAL_LEVELS; // 78 ft

/**
 * Synthetic grid used when no parsed geometry is available. Six bays
 * by five bays at ~28 ft spacing — gives a 140×112 footprint, which
 * fits comfortably in the existing canvas viewBox.
 */
export function buildDefaultGrid() {
  const xCount = 6; // A..F
  const yCount = 5; // 1..5
  const xSpacing = 28;
  const ySpacing = 28;
  const xLines = Array.from({ length: xCount }, (_, i) => ({
    label: X_LABELS[i] || String.fromCharCode(65 + i),
    coordinate: i * xSpacing,
    axis: "x",
  }));
  const yLines = Array.from({ length: yCount }, (_, i) => ({
    label: String(i + 1),
    coordinate: i * ySpacing,
    axis: "y",
  }));

  const minX = -4, maxX = (xCount - 1) * xSpacing + 4;
  const minY = -4, maxY = (yCount - 1) * ySpacing + 4;

  return {
    xLines,
    yLines,
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, depth: maxY - minY },
    levels: Array.from({ length: TOTAL_LEVELS }, (_, i) => ({
      id: `L${i + 1}`,
      index: i,
      elevation: i * LEVEL_HEIGHT_FT,
      height: LEVEL_HEIGHT_FT,
    })),
    levelHeight: LEVEL_HEIGHT_FT,
    totalHeight: BUILDING_HEIGHT_FT,
    coreZone: {
      // Core sits roughly center, slightly to the right.
      minX: 2 * xSpacing - 6,
      maxX: 3 * xSpacing + 6,
      minY: 1 * ySpacing - 4,
      maxY: 2 * ySpacing + 4,
    },
    noColumnZones: [
      // One lobby clear-span zone at the SW corner.
      {
        id: "ncz-lobby",
        name: "Lobby",
        minX: 0,
        maxX: xSpacing,
        minY: 0,
        maxY: ySpacing * 0.8,
      },
    ],
    source: "default",
  };
}

/**
 * Try to derive a placement-friendly grid from the parsed-geometry
 * cache. Falls back to `buildDefaultGrid()` when the project hasn't
 * been parsed yet (typical mock-project case). The point of looking
 * at parsed geometry is to inherit the user's actual building bounds
 * and core/NCZ locations so our strategies feel project-specific.
 */
export function gridFromGeometry(parsed) {
  parsed = parsed || getPlanGeometry();
  if (!parsed?.gridLines?.length) return buildDefaultGrid();

  const xLines = parsed.gridLines
    .filter((g) => g.axis === "x")
    .map((g) => ({ label: g.label, coordinate: g.coordinate, axis: "x" }))
    .sort((a, b) => a.coordinate - b.coordinate);
  const yLines = parsed.gridLines
    .filter((g) => g.axis === "y")
    .map((g) => ({ label: g.label, coordinate: g.coordinate, axis: "y" }))
    .sort((a, b) => a.coordinate - b.coordinate);

  if (xLines.length < 2 || yLines.length < 2) return buildDefaultGrid();

  const bb = parsed.buildingBounds || {
    minX: xLines[0].coordinate,
    maxX: xLines[xLines.length - 1].coordinate,
    minY: yLines[0].coordinate,
    maxY: yLines[yLines.length - 1].coordinate,
  };

  const cores = parsed.cores || [];
  const coreZone = cores.length
    ? (() => {
        const [x, y, w, h] = cores[0].boundary;
        return { minX: x, maxX: x + w, minY: y, maxY: y + h };
      })()
    : null;

  const noColumnZones = (parsed.noColumnZones || []).map((z) => {
    const [x, y, w, h] = z.boundary;
    return { id: z.id, name: z.name, minX: x, maxX: x + w, minY: y, maxY: y + h };
  });

  const levels = parsed.levels?.length
    ? parsed.levels.map((l, i) => ({
        id: l.id,
        index: i,
        elevation: l.elevation ?? i * LEVEL_HEIGHT_FT,
        height: l.height ?? LEVEL_HEIGHT_FT,
      }))
    : Array.from({ length: TOTAL_LEVELS }, (_, i) => ({
        id: `L${i + 1}`,
        index: i,
        elevation: i * LEVEL_HEIGHT_FT,
        height: LEVEL_HEIGHT_FT,
      }));

  return {
    xLines,
    yLines,
    bounds: {
      minX: bb.minX,
      maxX: bb.maxX,
      minY: bb.minY,
      maxY: bb.maxY,
      width: bb.maxX - bb.minX,
      depth: bb.maxY - bb.minY,
    },
    levels,
    levelHeight: levels[0]?.height || LEVEL_HEIGHT_FT,
    totalHeight: levels.reduce((sum, l) => sum + (l.height || LEVEL_HEIGHT_FT), 0) || BUILDING_HEIGHT_FT,
    coreZone,
    noColumnZones,
    source: "parsed",
  };
}

// ────────────────────────────────────────────────────────────────────
// Strategy specs
// ────────────────────────────────────────────────────────────────────

export const STRATEGY_SPECS = [
  {
    id: "balanced-grid",
    name: "Balanced grid",
    status: "Active strategy",
    description: "Regular bay spacing with balanced gravity and lateral layout.",
    columnPolicy: "all",
    extraInteriorColumns: 0,
    coreWallEmphasis: 1.0,
  },
  {
    id: "fewer-columns",
    name: "Fewer columns",
    status: "Alternate strategy",
    description: "Drop interior columns for longer spans and more open space.",
    columnPolicy: "skip-alternate-interior",
    extraInteriorColumns: 0,
    coreWallEmphasis: 1.1,
  },
  {
    id: "shallow-beams",
    name: "Shallow beams",
    status: "Alternate strategy",
    description: "Tighter column grid keeps spans short and beams shallow.",
    columnPolicy: "all-plus-intermediate",
    extraInteriorColumns: 8,
    coreWallEmphasis: 0.85,
  },
  {
    id: "core-wall-dominant",
    name: "Core-wall dominant",
    status: "Alternate strategy",
    description: "Core walls carry the majority of lateral demand.",
    columnPolicy: "all",
    extraInteriorColumns: 0,
    coreWallEmphasis: 1.6,
  },
];

// ────────────────────────────────────────────────────────────────────
// Public top-level
// ────────────────────────────────────────────────────────────────────

export function generateAllStrategies(grid, constraints, manualOverrides) {
  const out = STRATEGY_SPECS.map((spec) =>
    buildStrategy(spec, grid, constraints, manualOverrides),
  );
  // The first strategy is the "active" one by default in our engine —
  // callers respect state.placement.activeStrategyId and can swap.
  return out;
}

export function regenerateStrategy(strategy, grid, constraints, manualOverrides) {
  const spec = STRATEGY_SPECS.find((s) => s.id === strategy.id) || STRATEGY_SPECS[0];
  return buildStrategy(spec, grid, constraints, manualOverrides);
}

// ────────────────────────────────────────────────────────────────────
// Per-strategy build pipeline
// ────────────────────────────────────────────────────────────────────

function buildStrategy(spec, grid, constraints, manualOverrides) {
  const generatedColumns = generateColumns(spec, grid, constraints);
  const generatedShearWalls = generateShearWalls(spec, grid, constraints);
  const allColumns = [
    ...generatedColumns,
    ...((manualOverrides?.columns) || []),
  ];
  const allShearWalls = [
    ...generatedShearWalls,
    ...((manualOverrides?.shearWalls) || []),
  ];

  // Beams are fully derived from the column set so manual columns
  // automatically participate in beam generation along their grid line.
  const generatedBeams = generateBeams(allColumns, grid, constraints);
  const allBeams = [
    ...generatedBeams,
    ...((manualOverrides?.beams) || []),
  ];

  const elements = {
    columns: allColumns,
    beams: allBeams,
    shearWalls: allShearWalls,
  };

  const metrics = computeMetrics({ elements }, grid, constraints, spec);
  const warnings = computeWarnings({ elements, ...metrics }, constraints, spec);

  return {
    id: spec.id,
    name: spec.name,
    status: spec.status,
    description: spec.description,
    elements,
    columns: metrics.columnCount,
    beams: metrics.beamCount,
    shearWalls: metrics.shearWallCount,
    maxSpanFt: metrics.maxSpanFt,
    avgBayFt: metrics.avgBayFt,
    maxBeamDepthIn: metrics.maxBeamDepthIn,
    steelWeightTons: metrics.steelWeightTons,
    estimatedCostM: metrics.estimatedCostM,
    carbonTCO2: metrics.carbonTCO2,
    score: metrics.score,
    warnings,
  };
}

// ────────────────────────────────────────────────────────────────────
// Columns
// ────────────────────────────────────────────────────────────────────

export function generateColumns(spec, grid, _constraints) {
  const out = [];
  const { xLines, yLines } = grid;
  const policy = spec.columnPolicy;

  // Helper: classify a grid intersection
  const isPerimeter = (xi, yi) =>
    xi === 0 || xi === xLines.length - 1 || yi === 0 || yi === yLines.length - 1;
  const isCorner = (xi, yi) =>
    (xi === 0 || xi === xLines.length - 1) &&
    (yi === 0 || yi === yLines.length - 1);
  const isCoreAdjacent = (x, y) => {
    if (!grid.coreZone) return false;
    const c = grid.coreZone;
    return (
      x >= c.minX - 8 && x <= c.maxX + 8 &&
      y >= c.minY - 8 && y <= c.maxY + 8
    );
  };
  const isInsideNoColumnZone = (x, y) =>
    (grid.noColumnZones || []).some(
      (z) => x >= z.minX && x <= z.maxX && y >= z.minY && y <= z.maxY,
    );

  for (let yi = 0; yi < yLines.length; yi++) {
    for (let xi = 0; xi < xLines.length; xi++) {
      const xL = xLines[xi];
      const yL = yLines[yi];
      const x = xL.coordinate;
      const y = yL.coordinate;

      if (isInsideNoColumnZone(x, y)) continue;

      let include = true;
      if (policy === "skip-alternate-interior") {
        if (!isPerimeter(xi, yi) && !isCoreAdjacent(x, y)) {
          include = (xi + yi) % 2 === 0; // checkerboard interior
        }
      }

      if (!include) continue;

      out.push({
        id: `col-${xL.label}${yL.label}`,
        type: "column",
        label: `${xL.label}${yL.label}`,
        gridX: xL.label,
        gridY: yL.label,
        x, y, z: 0,
        width: 0.35, depth: 0.35, height: grid.totalHeight || BUILDING_HEIGHT_FT,
        levelStart: 0, levelEnd: grid.levels.length,
        locked: isCorner(xi, yi) || isCoreAdjacent(x, y),
        source: "generated",
        kind: isPerimeter(xi, yi) ? "perimeter" : isCoreAdjacent(x, y) ? "core-adjacent" : "interior",
      });
    }
  }

  // Shallow-beams: add intermediate columns on long bays.
  if (policy === "all-plus-intermediate" && (spec.extraInteriorColumns || 0) > 0) {
    const intermediates = generateIntermediateColumns(grid, spec.extraInteriorColumns, isInsideNoColumnZone);
    out.push(...intermediates);
  }
  return out;
}

function generateIntermediateColumns(grid, count, isInsideNoColumnZone) {
  const out = [];
  const { xLines, yLines } = grid;
  // Place intermediate columns at midpoints between pairs of neighbouring
  // grid intersections, walking through bays in row-major order until we
  // have `count` of them.
  let placed = 0;
  outer:
  for (let yi = 0; yi < yLines.length - 1; yi++) {
    const yMid = (yLines[yi].coordinate + yLines[yi + 1].coordinate) / 2;
    for (let xi = 0; xi < xLines.length - 1; xi++) {
      const xMid = (xLines[xi].coordinate + xLines[xi + 1].coordinate) / 2;
      if (isInsideNoColumnZone(xMid, yMid)) continue;
      out.push({
        id: `col-int-${xi}-${yi}`,
        type: "column",
        label: `${xi + 1}.5/${yi + 1}.5`,
        gridX: `${xLines[xi].label}½`,
        gridY: `${yLines[yi].label}½`,
        x: xMid, y: yMid, z: 0,
        width: 0.35, depth: 0.35, height: grid.totalHeight || BUILDING_HEIGHT_FT,
        levelStart: 0, levelEnd: grid.levels.length,
        locked: false,
        source: "generated",
        kind: "intermediate",
      });
      placed += 1;
      if (placed >= count) break outer;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Beams
// ────────────────────────────────────────────────────────────────────

export function generateBeams(columns, grid, _constraints) {
  // Use the topmost level (typical workspace view) for beam centerline z.
  const beamLevel = grid.levels[Math.min(5, grid.levels.length - 1)];
  const z = beamLevel.elevation;

  // Group columns by gridY (along X-direction) and gridX (along Y-direction).
  const byY = new Map();
  const byX = new Map();
  for (const c of columns) {
    if (!byY.has(c.gridY)) byY.set(c.gridY, []);
    byY.get(c.gridY).push(c);
    if (!byX.has(c.gridX)) byX.set(c.gridX, []);
    byX.get(c.gridX).push(c);
  }

  const out = [];
  // X-direction beams (along constant gridY)
  byY.forEach((cols, gridY) => {
    cols.sort((a, b) => a.x - b.x);
    for (let i = 0; i < cols.length - 1; i++) {
      const a = cols[i], b = cols[i + 1];
      const span = Math.abs(b.x - a.x);
      if (span < 4) continue;
      out.push(makeBeam(a, b, z, beamLevel.id, span));
    }
  });
  // Y-direction beams (along constant gridX)
  byX.forEach((cols, gridX) => {
    cols.sort((a, b) => a.y - b.y);
    for (let i = 0; i < cols.length - 1; i++) {
      const a = cols[i], b = cols[i + 1];
      const span = Math.abs(b.y - a.y);
      if (span < 4) continue;
      out.push(makeBeam(a, b, z, beamLevel.id, span));
    }
  });
  return out;
}

function makeBeam(a, b, z, levelId, spanFt) {
  const depthIn = clamp(spanFt / 1.6, 12, 36);
  const depthFt = depthIn / 12;
  return {
    id: `beam-${a.id}-${b.id}`,
    type: "beam",
    startColumnId: a.id,
    endColumnId: b.id,
    x1: a.x, y1: a.y, z1: z,
    x2: b.x, y2: b.y, z2: z,
    spanFt,
    depthIn,
    depth: depthFt,
    width: 0.25,
    level: levelId,
    locked: false,
    source: "generated",
  };
}

// ────────────────────────────────────────────────────────────────────
// Shear walls
// ────────────────────────────────────────────────────────────────────

export function generateShearWalls(spec, grid, _constraints) {
  if (!grid.coreZone) return [];
  const c = grid.coreZone;
  const out = [];

  // Four perimeter walls around the core zone.
  out.push(makeWall("wall-core-N", "Core wall N", c.minX, c.minY, c.maxX, c.minY, grid));
  out.push(makeWall("wall-core-S", "Core wall S", c.minX, c.maxY, c.maxX, c.maxY, grid));
  out.push(makeWall("wall-core-W", "Core wall W", c.minX, c.minY, c.minX, c.maxY, grid));
  out.push(makeWall("wall-core-E", "Core wall E", c.maxX, c.minY, c.maxX, c.maxY, grid));

  // Core-wall dominant strategy: add two more interior shear walls
  // running parallel to the core's longest axis.
  if (spec.coreWallEmphasis >= 1.4) {
    const midY = (c.minY + c.maxY) / 2;
    out.push(makeWall("wall-aux-1", "Aux wall 1",
      grid.bounds.minX + grid.bounds.width * 0.18, midY,
      grid.bounds.minX + grid.bounds.width * 0.32, midY, grid));
    out.push(makeWall("wall-aux-2", "Aux wall 2",
      grid.bounds.minX + grid.bounds.width * 0.68, midY,
      grid.bounds.minX + grid.bounds.width * 0.82, midY, grid));
  }
  return out;
}

function makeWall(id, label, x1, y1, x2, y2, grid) {
  return {
    id, type: "shearWall", label,
    x1, y1, x2, y2, z: 0,
    height: grid.totalHeight || BUILDING_HEIGHT_FT,
    thickness: 0.35,
    levelStart: 0, levelEnd: grid.levels.length,
    locked: true,
    source: "generated",
  };
}

// ────────────────────────────────────────────────────────────────────
// Metrics + warnings
// ────────────────────────────────────────────────────────────────────

export function computeMetrics(strategy, grid, constraints, spec) {
  const cols = strategy.elements.columns;
  const beams = strategy.elements.beams;
  const walls = strategy.elements.shearWalls;

  const maxSpanFt = beams.reduce((m, b) => Math.max(m, b.spanFt || 0), 0);
  const avgBayFt = beams.length
    ? beams.reduce((s, b) => s + (b.spanFt || 0), 0) / beams.length
    : 0;
  const maxBeamDepthIn = beams.reduce((m, b) => Math.max(m, b.depthIn || 0), 0);

  const steelWeightTons =
    cols.length * 1.2 +
    beams.reduce((s, b) => s + (b.spanFt || 0) * 0.18, 0) +
    walls.length * 3.5;

  const complexityFactor = (spec?.coreWallEmphasis || 1) * 0.04;
  const estimatedCostM = +(steelWeightTons * 0.012 + complexityFactor).toFixed(2);
  const concreteWallFactor = walls.length * 8.5;
  const carbonTCO2 = Math.round(steelWeightTons * 2.4 + concreteWallFactor);

  // Score: lower spans + lower carbon = higher score, with a baseline.
  const spanPenalty = Math.max(0, maxSpanFt - (constraints?.maxSpanFt ?? 32)) * 1.5;
  const beamDepthPenalty = Math.max(0, maxBeamDepthIn - (constraints?.maxBeamDepthIn ?? 24)) * 1.0;
  const carbonPenalty = Math.max(0, carbonTCO2 - 360) * 0.05;
  const score = Math.round(
    Math.max(40, 96 - spanPenalty - beamDepthPenalty - carbonPenalty),
  );

  return {
    columnCount: cols.length,
    beamCount: beams.length,
    shearWallCount: walls.length,
    maxSpanFt: +maxSpanFt.toFixed(1),
    avgBayFt: +avgBayFt.toFixed(1),
    maxBeamDepthIn: Math.round(maxBeamDepthIn),
    steelWeightTons: Math.round(steelWeightTons),
    estimatedCostM,
    carbonTCO2,
    score,
  };
}

export function computeWarnings(strategy, constraints, spec) {
  const out = [];
  const { columns, beams, shearWalls } = strategy.elements;
  const c = constraints || {};

  if (strategy.maxSpanFt > (c.maxSpanFt ?? 32)) {
    out.push("Max span exceeds preferred target.");
  }
  if (strategy.maxBeamDepthIn > (c.maxBeamDepthIn ?? 24)) {
    out.push("Beam depth exceeds target.");
  }
  if (columns.length < 38) {
    out.push("Reduced column count may increase member sizes.");
  }
  const manualCount = columns.filter((x) => x.source === "manual").length
                   + beams.filter((x) => x.source === "manual").length
                   + shearWalls.filter((x) => x.source === "manual").length;
  if (manualCount > 0) {
    out.push(`Manual locked elements (${manualCount}) may limit optimization.`);
  }
  if (strategy.carbonTCO2 > 360) {
    out.push("Carbon estimate above target.");
  }
  if (shearWalls.length < 4) {
    out.push("Lateral system may need additional wall capacity.");
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Snap helpers (used by interactions)
// ────────────────────────────────────────────────────────────────────

export function snapToNearestGridIntersection(grid, point) {
  const x = nearestCoord(grid.xLines, point.x);
  const y = nearestCoord(grid.yLines, point.y);
  return { x, y };
}

export function snapToNearestGridLine(grid, point) {
  const xCand = nearestCoord(grid.xLines, point.x);
  const yCand = nearestCoord(grid.yLines, point.y);
  // Snap to whichever axis line is closer (in absolute distance).
  const dx = Math.abs(xCand - point.x);
  const dy = Math.abs(yCand - point.y);
  if (dx < dy) return { x: xCand, y: point.y };
  return { x: point.x, y: yCand };
}

export function findNearestColumn(columns, point, threshold = 6) {
  let best = null;
  let bestDist = Infinity;
  for (const c of columns) {
    const dx = c.x - point.x;
    const dy = c.y - point.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= threshold ? best : null;
}

export function isInsideNoColumnZone(grid, point) {
  return (grid.noColumnZones || []).some(
    (z) => point.x >= z.minX && point.x <= z.maxX && point.y >= z.minY && point.y <= z.maxY,
  );
}

// ────────────────────────────────────────────────────────────────────
// Internal utilities
// ────────────────────────────────────────────────────────────────────

function nearestCoord(lines, value) {
  let best = lines[0]?.coordinate ?? value;
  let bestDist = Math.abs(value - best);
  for (let i = 1; i < lines.length; i++) {
    const d = Math.abs(lines[i].coordinate - value);
    if (d < bestDist) { bestDist = d; best = lines[i].coordinate; }
  }
  return best;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
