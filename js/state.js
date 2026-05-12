/**
 * Reactive state store — Proxy-based.
 * Subscribers register with `on(key, fn)` and are notified when the
 * top-level key (or a deep path that uses `set()`) changes.
 *
 * This is intentionally tiny: most consumers care about whole-key changes
 * (`page`, `selectedObject`, `viewMode`, ...). For nested fields like
 * `newProject.step` we expose a `set()` helper that emits both the full
 * key (`newProject`) and the path (`newProject.step`).
 */

const handlers = new Map();

function defaultPlacementState() {
  return {
    activeStrategyId: "balanced-grid",
    activeTool: null,           // null | 'add-column' | 'add-shear-wall' | 'add-beam' | 'delete'
    selectedElementId: null,
    pendingPoint: null,         // first click while in 2-click tools (add-shear-wall, add-beam)
    isOptimizing: false,
    optimizationProgress: { current: 0, total: 847, label: "Idle" },
    constraints: {
      baySizeMinFt: 25,
      baySizeMaxFt: 30,
      maxSpanFt: 32,
      maxBeamDepthIn: 24,
      lateralPreference: "Core walls",
      noColumnZones: [],        // populated lazily from engine output
      lockedElements: [],       // mirror of manual ids for quick lookup
    },
    strategies: [],             // generated lazily on placement page entry
    manualOverrides: {
      columns: [],
      shearWalls: [],
      beams: [],
    },
    compareWith: null,          // strategy id for active comparison view, or null
  };
}

const initial = {
  // App-level routing
  mode: "projects",        // 'projects' | 'new-project' | 'processing' | 'workspace'
  page: "overview",        // workspace page id when mode === 'workspace'

  // Active workspace project
  projectId: null,

  // Selection & canvas
  selectedObject: null,    // { type, id }
  hoveredObject: null,
  // UUID of the active scheme (set after `loadSchemes()` resolves).
  // `null` when no scheme has been generated for the current project.
  // Legacy mock-era code used "A" / "B" / "C" — those are now display
  // labels only; the source of truth for the active scheme is the
  // UUID returned by the API.
  activeSchemeId: null,
  assumptionSetId: "Set v3",
  activeLevelId: "L6",
  viewMode: "2d",          // '2d' | '3d' | 'section' | 'split'
  layers: {
    // ── Source model (That Open IFC) ────────────────────────────────────
    sourceModel: true,
    // ── Civil Agent structural interpretation ───────────────────────────
    structuralInterpretation: true,
    floorPlates: true,
    grids: true,
    cores: true,
    noColumnZones: true,
    // ── Generated structural scheme ─────────────────────────────────────
    generatedScheme: true,
    columns: true,
    beams: true,
    shearWalls: true,
    braces: true,
    // ── Overlays ─────────────────────────────────────────────────────────
    loads: false,
    tributary: false,
    warnings: true,
    labels: true,
  },

  // Status of the That Open IFC source-model load.
  // 'idle' | 'loading' | 'loaded' | 'error'
  sourceModelStatus: "idle",

  // Panels
  inspectorOpen: true,
  trayOpen: true,
  showLayers: false,
  assistantOpen: false,
  cmdkOpen: false,

  // New project wizard
  newProject: {
    step: 0,
    name: "",
    location: "",
    client: "",
    buildingType: "",
    projectPhase: "",
    units: "",
    storiesAbove: "",
    storiesBelow: "",
    floorToFloor: "",
    groundHeight: "",
    footprint: "",
    codeYear: "IBC 2021",
    seismic: "ASCE 7-22",
    riskCategory: "II",
    materialSystem: "",
    files: [],
    seedDescription: "",

    // Set after the create-project flow talks to the API. `projectId`
    // and `geometryId` drive the processing screen's WS subscription.
    // `processingMode` is "live" when we're streaming real progress
    // events and "mock" when we're falling back to the simulated
    // pipeline (offline / no parser-eligible files).
    projectId: null,
    geometryId: null,
    parsedGeometry: null,
    processingStatus: "idle",   // 'idle' | 'uploading' | 'parsing' | 'ready' | 'error'
    processingMode: "mock",     // 'mock' | 'live'
    processingError: null,
  },

  // Processing screen progress (when transitioning from new-project to workspace)
  processing: {
    steps: [],
    activeIndex: -1,
  },

  // UI sub-state
  vaultTab: "documents",
  selectedAssumptionId: "A5",
  selectedDocumentId: "D1",
  compareMode: false,

  // Chrome
  recalculating: false,
  toasts: [],

  // CSS theme tokens are global; nothing here.

  // Intake chat system state (initialized by initIntakeStore)
  intake: null,

  // ── Loads page domain ────────────────────────────────────────────────
  // Initialized lazily on first entry to the Loads page (by load-runner
  // or the inspector/tray mount). Until then it is null so the rest of
  // the app doesn't pay the initialization cost.
  loads: null,

  // ── Placement page domain ────────────────────────────────────────────
  // Owns the placement page's working state — strategies, active tool,
  // manual overrides, regeneration progress. Driven by the placement
  // engine + binding (js/placement/*).
  placement: defaultPlacementState(),
};

export const state = new Proxy(initial, {
  set(target, prop, value) {
    const old = target[prop];
    target[prop] = value;
    if (!Object.is(old, value)) emit(prop, value, old);
    return true;
  },
});

/**
 * Set a nested field by path string, e.g. set('newProject.step', 1)
 * Emits change events for both the leaf path and the top-level key.
 */
export function set(path, value) {
  const segments = path.split(".");
  if (segments.length === 1) {
    state[segments[0]] = value;
    return;
  }
  const top = segments[0];
  const ref = state[top];
  let cursor = ref;
  for (let i = 1; i < segments.length - 1; i += 1) {
    cursor = cursor[segments[i]];
  }
  const leaf = segments[segments.length - 1];
  const old = cursor[leaf];
  cursor[leaf] = value;
  if (!Object.is(old, value)) {
    emit(path, value, old);
    emit(top, ref, ref); // fire top-level subscribers as well
  }
}

export function update(path, mutator) {
  const segments = path.split(".");
  let cursor = state;
  for (let i = 0; i < segments.length; i += 1) cursor = cursor[segments[i]];
  mutator(cursor);
  emit(path, cursor, cursor);
  emit(segments[0], state[segments[0]], state[segments[0]]);
}

export function on(prop, fn) {
  if (!handlers.has(prop)) handlers.set(prop, new Set());
  handlers.get(prop).add(fn);
  return () => handlers.get(prop).delete(fn);
}

export function emit(prop, value, old) {
  const direct = handlers.get(prop);
  if (direct) direct.forEach((fn) => fn(value, old));
  const wildcard = handlers.get("*");
  if (wildcard) wildcard.forEach((fn) => fn(prop, value, old));
}

export function setMany(patch) {
  Object.entries(patch).forEach(([k, v]) => {
    state[k] = v;
  });
}

/**
 * Defensive guard for placement domain consumers.
 * Some navigation paths and older session snapshots can leave
 * `state.placement` undefined; this restores a safe default shape.
 */
export function ensurePlacementState() {
  if (!state.placement || typeof state.placement !== "object") {
    state.placement = defaultPlacementState();
    return state.placement;
  }
  const p = state.placement;
  if (!p.constraints) p.constraints = defaultPlacementState().constraints;
  if (!p.manualOverrides) p.manualOverrides = defaultPlacementState().manualOverrides;
  if (!Array.isArray(p.strategies)) p.strategies = [];
  if (!p.optimizationProgress) p.optimizationProgress = { current: 0, total: 847, label: "Idle" };
  return p;
}
