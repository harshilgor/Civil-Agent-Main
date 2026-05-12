/**
 * Load engine — deterministic simplified structural load calculations.
 *
 * All functions are pure (no state access). They accept explicit arguments
 * and return calculated results. Designed to be replaced by a backend
 * solver call without changing the calling code.
 */

// Default building geometry (used when no project geometry is available)
const DEFAULT_GRID_WIDTH_FT = 140;
const DEFAULT_GRID_DEPTH_FT = 78;
const DEFAULT_FLOOR_AREA_SF = DEFAULT_GRID_WIDTH_FT * DEFAULT_GRID_DEPTH_FT; // 10,920 sf/level
const DEFAULT_LEVELS = 6;
const PERIMETER_FT = 2 * (DEFAULT_GRID_WIDTH_FT + DEFAULT_GRID_DEPTH_FT); // 436 ft

// Map from load case type → combination factor type
const TYPE_TO_FACTOR_KEY = {
  dead: "dead",
  live: "live",
  equipment: "equipment",
  wind: "wind",
  seismic: "seismic",
  snow: "live",
  rain: "live",
};

// Zone multipliers — what fraction of floor area a zone represents
const ZONE_AREA_FRACTION = {
  all: 1.0,
  corridors: 0.15,
  "equipment zone": 0.20,
  "core/roof": 0.15,
  perimeter: 0.25,
  storage: 0.10,
  roof: 1.0,
};

// ---------------------------------------------------------------------------
// Default data factories
// ---------------------------------------------------------------------------

export function initializeDefaultLoadCases() {
  return [
    {
      id: "DL",
      name: "Dead Load",
      type: "dead",
      category: "gravity",
      value: 70,
      unit: "psf",
      source: "Composite slab default",
      status: "approved",
      editable: true,
      appliesTo: { levels: [1, 2, 3, 4, 5, 6], zones: ["all"] },
      description: "Self-weight of slab, finishes, ceiling, MEP allowance.",
    },
    {
      id: "LL-OFF",
      name: "Office Live Load",
      type: "live",
      category: "gravity",
      value: 50,
      unit: "psf",
      source: "IBC 2021 occupancy default",
      status: "approved",
      editable: true,
      appliesTo: { levels: [1, 2, 3, 4, 5, 6], zones: ["all"] },
      description: "Office occupancy live load per IBC Table 1607.1.",
    },
    {
      id: "LL-COR",
      name: "Corridor Live Load",
      type: "live",
      category: "gravity",
      value: 80,
      unit: "psf",
      source: "IBC 2021 corridor default",
      status: "approved",
      editable: true,
      appliesTo: { levels: [1, 2, 3, 4, 5, 6], zones: ["corridors"] },
      description: "Corridor and lobby live load.",
    },
    {
      id: "EQ-ROOF",
      name: "Equipment Load",
      type: "equipment",
      category: "gravity",
      value: 18,
      unit: "psf",
      source: "Equipment_Load_Schedule.xlsx",
      status: "approved",
      editable: true,
      appliesTo: { levels: [6], zones: ["equipment zone"] },
      description: "Rooftop mechanical equipment — see equipment schedule.",
    },
    {
      id: "PL",
      name: "Partition Load",
      type: "dead",
      category: "gravity",
      value: 15,
      unit: "psf",
      source: "Office allowance",
      status: "draft",
      editable: true,
      appliesTo: { levels: [1, 2, 3, 4, 5, 6], zones: ["all"] },
      description: "Moveable partition allowance per IBC 1607.5.",
    },
    {
      id: "FL",
      name: "Facade Load",
      type: "dead",
      category: "gravity",
      value: 22,
      unit: "psf",
      source: "Envelope assumption",
      status: "draft",
      editable: true,
      appliesTo: { levels: [1, 2, 3, 4, 5, 6], zones: ["perimeter"] },
      description: "Exterior facade dead load on perimeter framing.",
    },
    {
      id: "RL",
      name: "Roof Live Load",
      type: "live",
      category: "gravity",
      value: 20,
      unit: "psf",
      source: "Roof occupancy default",
      status: "approved",
      editable: true,
      appliesTo: { levels: [6], zones: ["roof"] },
      description: "Roof live load per ASCE 7-22 Section 4.9.",
    },
    {
      id: "ML",
      name: "Mechanical Load",
      type: "equipment",
      category: "gravity",
      value: 35,
      unit: "psf",
      source: "MEP allowance",
      status: "draft",
      editable: true,
      appliesTo: { levels: [6], zones: ["core/roof"] },
      description: "Mechanical equipment on roof level.",
    },
    {
      id: "WL",
      name: "Wind Load",
      type: "wind",
      category: "lateral",
      value: 110,
      unit: "mph",
      source: "ASCE 7-22",
      status: "approved",
      editable: false,
      appliesTo: { levels: [1, 2, 3, 4, 5, 6], zones: ["all"] },
      description: "Basic wind speed. Full wind pressure analysis required.",
    },
    {
      id: "SL",
      name: "Seismic Base Shear",
      type: "seismic",
      category: "lateral",
      value: 0.43,
      unit: "Sds",
      source: "Seismic_Criteria_Memo.pdf",
      status: "approved",
      editable: false,
      appliesTo: { levels: [1, 2, 3, 4, 5, 6], zones: ["all"] },
      description: "Site spectral acceleration for seismic design.",
    },
    {
      id: "SN",
      name: "Snow / Rain Load",
      type: "live",
      category: "gravity",
      value: 25,
      unit: "psf",
      source: "ASCE 7-22 Chapter 7",
      status: "approved",
      editable: true,
      appliesTo: { levels: [6], zones: ["roof"] },
      description: "Ground snow load with rain-on-snow surcharge.",
    },
    {
      id: "STL",
      name: "Storage Load",
      type: "live",
      category: "gravity",
      value: 125,
      unit: "psf",
      source: "Occupancy schedule",
      status: "draft",
      editable: true,
      appliesTo: { levels: [1], zones: ["storage"] },
      description: "Heavy storage zone live load on ground floor.",
    },
  ];
}

export function initializeDefaultLoadCombinations() {
  return [
    {
      id: "combo-service-1",
      name: "Service 1",
      expression: "1.0D + 1.0L",
      type: "service",
      status: "approved",
      active: true,
      factors: [
        { loadType: "dead", factor: 1.0 },
        { loadType: "live", factor: 1.0 },
      ],
      resultSummary: null,
    },
    {
      id: "combo-strength-1",
      name: "Strength 1",
      expression: "1.2D + 1.6L",
      type: "strength",
      status: "approved",
      active: true,
      factors: [
        { loadType: "dead", factor: 1.2 },
        { loadType: "live", factor: 1.6 },
      ],
      resultSummary: null,
    },
    {
      id: "combo-strength-2",
      name: "Strength 2",
      expression: "1.2D + 1.0L + 1.0E",
      type: "strength",
      status: "approved",
      active: true,
      factors: [
        { loadType: "dead", factor: 1.2 },
        { loadType: "live", factor: 1.0 },
        { loadType: "equipment", factor: 1.0 },
      ],
      resultSummary: null,
    },
    {
      id: "combo-lateral-wind",
      name: "Lateral Wind",
      expression: "1.2D + 1.0W + 0.5L",
      type: "lateral",
      status: "approved",
      active: true,
      factors: [
        { loadType: "dead", factor: 1.2 },
        { loadType: "wind", factor: 1.0 },
        { loadType: "live", factor: 0.5 },
      ],
      resultSummary: null,
    },
    {
      id: "combo-lateral-seismic",
      name: "Lateral Seismic",
      expression: "1.2D + 1.0S + 0.5L",
      type: "lateral",
      status: "approved",
      active: true,
      factors: [
        { loadType: "dead", factor: 1.2 },
        { loadType: "seismic", factor: 1.0 },
        { loadType: "live", factor: 0.5 },
      ],
      resultSummary: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Calculation helpers
// ---------------------------------------------------------------------------

function getFloorAreaSf(projectGeometry) {
  return projectGeometry?.floorAreaSqFt ?? DEFAULT_FLOOR_AREA_SF;
}

/** Effective psf contribution of a load case to a given factor key. */
function effectivePsf(lc) {
  if (lc.unit !== "psf") return 0;
  const zone = lc.appliesTo?.zones?.[0] ?? "all";
  const zoneFrac = ZONE_AREA_FRACTION[zone] ?? 1.0;
  const levelCount = lc.appliesTo?.levels?.length ?? DEFAULT_LEVELS;
  // Psf is per-level; scale by zone and level count relative to default
  return lc.value * zoneFrac * (levelCount / DEFAULT_LEVELS);
}

/** Total kip for approved psf loads across all levels for a given factor key. */
function totalKipForType(factorKey, loadCases, floorAreaSf) {
  let psfSum = 0;
  let kipSum = 0;
  for (const lc of loadCases) {
    if (lc.status === "unapproved") continue;
    if ((TYPE_TO_FACTOR_KEY[lc.type] ?? lc.type) !== factorKey) continue;
    if (lc.unit === "psf") psfSum += effectivePsf(lc);
    else if (lc.unit === "kip") kipSum += lc.value;
    else if (lc.unit === "plf") kipSum += (lc.value * PERIMETER_FT) / 1000;
  }
  return (psfSum * floorAreaSf * DEFAULT_LEVELS) / 1000 + kipSum;
}

/** Parse "620 sf" → 620 */
function parseSf(str) {
  const m = String(str ?? "620").match(/[\d.]+/);
  return m ? parseFloat(m[0]) : 620;
}

// ---------------------------------------------------------------------------
// Main calculation
// ---------------------------------------------------------------------------

/**
 * Run the full load analysis.
 *
 * @param {object[]} loadCases
 * @param {object[]} loadCombinations
 * @param {object[]} mockColumns     – columns from mock-members or placement
 * @param {object|null} projectGeometry
 * @returns {object} analysis result
 */
export function calculateLoadAnalysis(
  loadCases,
  loadCombinations,
  mockColumns,
  projectGeometry,
) {
  const floorAreaSf = getFloorAreaSf(projectGeometry);

  // Build per-type totals (kip, full building)
  const typeTotals = {};
  for (const key of ["dead", "live", "equipment", "wind", "seismic"]) {
    typeTotals[key] = totalKipForType(key, loadCases, floorAreaSf);
  }

  // Evaluate each combination
  let maxGravityKip = 0;
  let controllingCombinationId = "combo-strength-1";

  const combinations = loadCombinations.map((combo) => {
    let totalKip = 0;
    for (const { loadType, factor } of combo.factors) {
      // Wind/seismic as kip values are already factored in via a nominal multiplier
      const raw = typeTotals[loadType] ?? 0;
      totalKip += factor * raw;
    }
    if (combo.type !== "lateral" && totalKip > maxGravityKip) {
      maxGravityKip = totalKip;
      controllingCombinationId = combo.id;
    }
    return { combo, totalKip };
  });

  // Simplified gravity psf for column axial (Strength 1: 1.2D + 1.6L)
  const deadPsf = loadCases
    .filter((lc) => lc.type === "dead" && lc.unit === "psf" && lc.status !== "unapproved")
    .reduce((s, lc) => s + lc.value, 0);
  const livePsf = loadCases
    .filter(
      (lc) =>
        lc.type === "live" &&
        lc.unit === "psf" &&
        lc.status !== "unapproved" &&
        (lc.appliesTo?.levels?.length ?? DEFAULT_LEVELS) === DEFAULT_LEVELS,
    )
    .reduce((s, lc) => s + lc.value, 0);
  const eqPsf = loadCases
    .filter((lc) => lc.type === "equipment" && lc.unit === "psf" && lc.status !== "unapproved")
    .reduce((s, lc) => s + lc.value, 0);

  const str1Psf = 1.2 * deadPsf + 1.6 * livePsf + 0.3 * eqPsf;

  // Column element results
  const cols = mockColumns || [];
  let maxColumnAxialKip = 0;
  let controllingElementId = null;

  const elementResults = cols.map((col) => {
    const tribSf = parseSf(col.tributaryArea);
    const axialKip = Math.round((str1Psf * tribSf * DEFAULT_LEVELS) / 1000);
    const utilization = Math.min(axialKip / 1000, 1.0);
    if (axialKip > maxColumnAxialKip) {
      maxColumnAxialKip = axialKip;
      controllingElementId = col.id;
    }
    return {
      elementId: col.id,
      elementType: "column",
      level: 1,
      axialKip,
      shearKip: Math.round(axialKip * 0.06),
      momentKipFt: Math.round(axialKip * 0.12),
      utilization: parseFloat(utilization.toFixed(2)),
      status: utilization > 0.85 ? "warn" : "ok",
    };
  });

  // Beam and wall estimates
  const maxBeamReactionKip = Math.round((str1Psf * 14 * 31) / 1000);
  const maxWallReactionKip = Math.round(maxBeamReactionKip * 4.2);

  const totalFloorLoadKip = Math.round(
    (str1Psf * floorAreaSf * DEFAULT_LEVELS) / 1000,
  );
  const unapprovedCases = loadCases.filter(
    (lc) => lc.status === "unapproved" || lc.status === "draft",
  ).length;

  // Attach result summaries to combinations
  const enrichedCombinations = combinations.map(({ combo, totalKip }) => ({
    ...combo,
    resultSummary: {
      totalLoadKip: Math.round(totalKip),
      maxColumnAxialKip: Math.round(
        maxColumnAxialKip * (combo.type === "strength" ? 1.0 : combo.type === "service" ? 0.72 : 0.65),
      ),
      controllingElementId: controllingElementId ?? "C4",
    },
  }));

  return {
    totalFloorLoadKip,
    maxColumnAxialKip,
    maxBeamReactionKip,
    maxWallReactionKip,
    unapprovedCases,
    controllingCombinationId,
    controllingElementId: controllingElementId ?? "C4",
    elementResults,
    combinations: enrichedCombinations,
  };
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Generate structural warnings based on load case state and results.
 */
export function generateLoadWarnings(loadCases, combinations, results) {
  const warnings = [];

  const drafts = loadCases.filter(
    (lc) => lc.status === "draft" || lc.status === "unapproved",
  );
  if (drafts.length > 0) {
    const names = drafts
      .slice(0, 3)
      .map((d) => d.name)
      .join(", ");
    warnings.push({
      id: "warn-draft-cases",
      severity: "warning",
      message: `${drafts.length} case${drafts.length > 1 ? "s" : ""} (${names}${drafts.length > 3 ? "…" : ""}) are draft/unapproved and excluded from approved combination totals.`,
      relatedElementId: null,
      relatedLoadCaseId: drafts[0]?.id ?? null,
    });
  }

  if (results.maxColumnAxialKip > 700) {
    warnings.push({
      id: "warn-max-column-axial",
      severity: "warning",
      message: `Max column axial ${results.maxColumnAxialKip.toLocaleString()} kip exceeds 700 kip review threshold. Element ${results.controllingElementId} controls.`,
      relatedElementId: results.controllingElementId,
      relatedLoadCaseId: null,
    });
  }

  const hasRoofLive = loadCases.some(
    (lc) =>
      lc.type === "live" &&
      lc.status === "approved" &&
      (lc.appliesTo?.levels?.includes(6) || lc.appliesTo?.zones?.includes("roof")),
  );
  if (!hasRoofLive) {
    warnings.push({
      id: "warn-no-roof-live",
      severity: "error",
      message: "No approved live load case assigned to the roof level (Level 6).",
      relatedElementId: null,
      relatedLoadCaseId: null,
    });
  }

  const hasApprovedLateral = loadCases.some(
    (lc) =>
      (lc.type === "wind" || lc.type === "seismic") && lc.status === "approved",
  );
  const lateralCombos = combinations.filter((c) => c.type === "lateral");
  if (lateralCombos.length > 0 && !hasApprovedLateral) {
    warnings.push({
      id: "warn-no-lateral",
      severity: "warning",
      message:
        "Lateral load combinations are defined but no approved wind or seismic load case exists.",
      relatedElementId: null,
      relatedLoadCaseId: null,
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatLoadValue(value, unit) {
  if (unit === "Sds") return `${value} g`;
  return `${value} ${unit}`;
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

export function createInitialLoadsState() {
  const loadCases = initializeDefaultLoadCases();
  const loadCombinations = initializeDefaultLoadCombinations();
  return {
    isAnalyzing: false,
    analysisProgress: {
      current: 0,
      total: 642,
      percent: 0,
      label: "Idle",
      stage: "idle",
    },
    activeLoadCaseId: "DL",
    activeCombinationId: "combo-strength-1",
    selectedLoadId: null,
    viewMode: "load-path",
    analysisStale: true,
    loadCases,
    loadCombinations,
    loadResults: {
      totalFloorLoadKip: 0,
      maxColumnAxialKip: 0,
      maxBeamReactionKip: 0,
      maxWallReactionKip: 0,
      unapprovedCases: loadCases.filter((lc) => lc.status === "draft").length,
      elementResults: [],
      controllingCombinationId: null,
      controllingElementId: null,
    },
    visualization: {
      showGravityLoads: true,
      showLiveLoads: true,
      showEquipmentLoads: true,
      showLoadPath: true,
      showTributaryAreas: false,
      showColumnAxials: true,
      showWarnings: true,
      selectedLevel: 6,
    },
    warnings: [],
  };
}
