/**
 * Hand-written ParsedGeometry fixture.
 *
 * Shape mirrors `packages/engine/geometry_parser/models.py::ParsedGeometry`
 * (the Pydantic source of truth) so the parsed-geometry-adapter can
 * exercise its real validation paths against this fixture before any
 * actual API output arrives.
 *
 * Field-name notes (matching Pydantic verbatim):
 *   * OriginTransform uses `tx`, `ty`, `units`, `rotation_rad`.
 *   * ParseMetadata uses camelCase: `schemaVersion`, `parserVersion`,
 *     `overallConfidence`, `parsedAt`, etc.
 *   * Opening.levelId is *singular* (a single string).
 *   * BuildingBounds uses `minX/minY/maxX/maxY` (api plan frame).
 *   * Coordinates are in feet, local frame.
 */

const square = (x0, y0, x1, y1) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
  { x: x0, y: y0 },
];

const FOOTPRINT = square(0, 0, 140, 78);

export const PARSED_GEOMETRY_FIXTURE = {
  levels: [
    { id: "L1", name: "Level 1", elevation: 0,  height: 18, confidence: 1.00, source: "ifc",       planBoundary: FOOTPRINT },
    { id: "L2", name: "Level 2", elevation: 18, height: 13, confidence: 1.00, source: "ifc",       planBoundary: FOOTPRINT },
    { id: "L3", name: "Level 3", elevation: 31, height: 13, confidence: 0.98, source: "ifc",       planBoundary: FOOTPRINT },
    { id: "L4", name: "Level 4", elevation: 44, height: 13, confidence: 0.98, source: "ifc",       planBoundary: FOOTPRINT },
    { id: "L5", name: "Level 5", elevation: 57, height: 13, confidence: 0.96, source: "ifc",       planBoundary: FOOTPRINT },
    { id: "L6", name: "Level 6", elevation: 70, height: 13, confidence: 0.96, source: "ifc",       planBoundary: FOOTPRINT },
    { id: "L7", name: "Level 7", elevation: 83, height: 13, confidence: 0.94, source: "ifc",       planBoundary: FOOTPRINT },
    { id: "L8", name: "Roof",    elevation: 96, height: 0,  confidence: 0.92, source: "inferred",
      rationale: "Roof level inferred from elevation step.",                                         planBoundary: FOOTPRINT },
  ],

  gridLines: [
    { id: "G1", axis: "x", label: "1", coordinate: 0,   confidence: 1.00, source: "ifc" },
    { id: "G2", axis: "x", label: "2", coordinate: 28,  confidence: 0.98, source: "ifc" },
    { id: "G3", axis: "x", label: "3", coordinate: 56,  confidence: 0.96, source: "ifc" },
    { id: "G4", axis: "x", label: "4", coordinate: 84,  confidence: 0.92, source: "ifc" },
    { id: "G5", axis: "x", label: "5", coordinate: 112, confidence: 0.84, source: "inferred",
      rationale: "Spacing inferred from neighbours." },
    { id: "G6", axis: "x", label: "6", coordinate: 140, confidence: 0.96, source: "ifc" },
    { id: "GA", axis: "y", label: "A", coordinate: 0,   confidence: 1.00, source: "ifc" },
    { id: "GB", axis: "y", label: "B", coordinate: 26,  confidence: 0.96, source: "ifc" },
    { id: "GC", axis: "y", label: "C", coordinate: 52,  confidence: 0.93, source: "ifc" },
    { id: "GD", axis: "y", label: "D", coordinate: 78,  confidence: 0.89, source: "inferred" },
  ],

  cores: [
    {
      id: "CORE-1", type: "mixed", confidence: 0.95, source: "ifc",
      levelIds: ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"],
      boundary: square(38, 22, 56, 50),
      groupingReason: "Elevator + stair grouped by 12 ft proximity.",
    },
    {
      id: "CORE-2", type: "service", confidence: 0.88, source: "ifc",
      levelIds: ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"],
      boundary: square(104, 18, 120, 44),
    },
  ],

  openings: [
    {
      id: "OPEN-1", type: "stair_well", levelId: "L6", confidence: 0.9, source: "ifc",
      boundary: square(40, 22, 54, 36),
    },
  ],

  existingColumns: [
    { id: "C1", x: 0,   y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x82", gridLabel: "A-1", gridAligned: true,  confidence: 1.00, source: "ifc" },
    { id: "C2", x: 28,  y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", gridLabel: "A-2", gridAligned: true,  confidence: 1.00, source: "ifc" },
    { id: "C3", x: 56,  y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", gridLabel: "A-3", gridAligned: true,  confidence: 1.00, source: "ifc" },
    { id: "C4", x: 84,  y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", gridLabel: "A-4", gridAligned: true,  confidence: 1.00, source: "ifc" },
    { id: "C5", x: 112, y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", gridLabel: "A-5", gridAligned: true,  confidence: 0.95, source: "ifc" },
    { id: "C6", x: 140, y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x82", gridLabel: "A-6", gridAligned: true,  confidence: 1.00, source: "ifc" },
  ],

  noColumnZones: [
    {
      id: "NCZ-1", name: "L1 Lobby", reason: "Architectural clear-span lobby",
      source: "inferred", confidence: 0.8, levelIds: ["L1"],
      boundary: square(4, 50, 30, 72),
    },
    {
      id: "NCZ-2", name: "Atrium", reason: "Long-span atrium void",
      source: "ifc", confidence: 0.92, levelIds: ["L2", "L3", "L4", "L5"],
      boundary: square(88, 56, 118, 74),
    },
  ],

  floorPlates: [],

  buildingBounds: { minX: -8, minY: -8, maxX: 148, maxY: 86 },

  metadata: {
    schemaVersion: "parsed_geometry@1.0.0",
    parserVersion: "1.0.0",
    runId: "fixture-8th-street-001",
    fileFormat: "ifc",
    fileHash: "sha256:fixture",
    overallConfidence: 0.92,
    status: "completed",
    completedSteps: [
      "download", "init", "levels", "grids", "cores", "openings",
      "floor_plates", "existing_elements", "no_column_zones", "validation", "complete",
    ],
    warnings: ["Grid spacing irregular between gridlines 4 and 5."],
    originTransform: { tx: 0, ty: 0, units: "ft", rotation_rad: 0.0 },
    parsedAt: "2026-04-30T20:00:00+00:00",
    durationMs: 4200,
  },
};

export default PARSED_GEOMETRY_FIXTURE;
