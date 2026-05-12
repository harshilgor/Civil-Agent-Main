/**
 * Page-mode controller — animates per-layer opacity to match the active
 * page's visual profile.
 *
 * The 5+ workspace pages (overview, geometry, placement, loads, schemes,
 * sizing, reports) each emphasise different structural information.
 * Rather than rebuild geometry per page, we keep one scene and adjust
 * opacities on the fly.
 *
 * Profile keys are *granular* layer types — they mirror the existing
 * `userData.layerType` values used throughout the codebase:
 *   slab, slab-edge, column, beam, wall, wall-edge, core, core-edge,
 *   noColumnZone, opening, grid, load, tributary, ground.
 *
 * Animation is a single rAF loop. Switching pages mid-animation cancels
 * the previous frame request — no opacity drift, no double-tween.
 */

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const Z = 0;

/** Page → factor table. Final opacity = factor * userData.baseOpacity. */
const PAGE_PROFILES = {
  overview: {
    slab: 0.9, "slab-edge": 1.0, column: 0.9, beam: 0.7, wall: 0.9, "wall-edge": 0.9,
    core: 1.0, "core-edge": 1.0, noColumnZone: Z, opening: 0.6, grid: 0.7,
    load: Z, tributary: Z, ground: 1.0,
  },
  geometry: {
    slab: 1.0, "slab-edge": 1.0, column: 0.20, beam: 0.05, wall: 0.05, "wall-edge": 0.10,
    core: 1.0, "core-edge": 1.0, noColumnZone: 0.30, opening: 0.9, grid: 1.0,
    load: Z, tributary: Z, ground: 1.0,
  },
  placement: {
    slab: 0.55, "slab-edge": 0.85, column: 1.0, beam: 0.7, wall: 1.0, "wall-edge": 1.0,
    core: 0.7, "core-edge": 0.9, noColumnZone: 1.0, opening: 0.7, grid: 1.0,
    load: Z, tributary: Z, ground: 1.0,
  },
  loads: {
    slab: 0.4, "slab-edge": 0.6, column: 1.0, beam: 0.6, wall: 0.55, "wall-edge": 0.6,
    core: 0.4, "core-edge": 0.5, noColumnZone: Z, opening: 0.4, grid: 0.7,
    load: 1.0, tributary: 1.0, ground: 0.8,
  },
  schemes: {
    slab: 0.45, "slab-edge": 0.7, column: 1.0, beam: 1.0, wall: 1.0, "wall-edge": 1.0,
    core: 0.6, "core-edge": 0.8, noColumnZone: Z, opening: 0.5, grid: 0.85,
    load: Z, tributary: Z, ground: 1.0,
  },
  sizing: {
    slab: 0.30, "slab-edge": 0.55, column: 1.0, beam: 1.0, wall: 1.0, "wall-edge": 1.0,
    core: 0.30, "core-edge": 0.50, noColumnZone: Z, opening: 0.4, grid: 0.55,
    load: Z, tributary: Z, ground: 0.8,
  },
  reports: {
    slab: 0.45, "slab-edge": 0.7, column: 0.7, beam: 0.6, wall: 0.7, "wall-edge": 0.7,
    core: 0.5, "core-edge": 0.6, noColumnZone: Z, opening: 0.5, grid: 0.6,
    load: Z, tributary: Z, ground: 1.0,
  },
};

const TRANSITION_MS = 200;
const SELECTION_DIM_FACTOR = 0.40;
/** Below this threshold the selection becomes meaningless on a page. */
const SELECTION_VISIBILITY_THRESHOLD = 0.20;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class PageModeController {
  /**
   * @param {SceneObjectRegistry} registry
   * @param {() => void} onChange  invoked whenever opacity is mutated, so
   *   the host viewport can mark itself for a render frame.
   */
  constructor(registry, onChange = () => {}) {
    this.registry = registry;
    this.onChange = onChange;
    this.currentPage = null;
    /** @type {number|null} */
    this._raf = null;
    /** @type {Map<THREE.Object3D, {from:number, to:number}>} */
    this._tweens = new Map();
    this._startTime = 0;
    /** Per-page overrides driven by the layer-popover toggles. */
    this._layerOverrides = {};
    /** Currently selected element id (drives the dim-others factor). */
    this._selectedId = null;
  }

  // ---------------------------------------------------------------------------
  // Source-of-truth opacity computation. Every channel that affects opacity
  // is *multiplicative* and resolved here, so there is no order dependency
  // between page mode tweens, level filtering, and selection dimming.
  //
  //   final = baseOpacity × profileFactor × levelFactor × selectionFactor
  //
  // Color overlays (D/C sizing) are independent: they touch material.color,
  // never material.opacity, and snapshot/restore via the registry's
  // originalStyles map. So they don't interact with this pipeline at all.
  // ---------------------------------------------------------------------------

  _targetOpacity(mesh, profile) {
    const baseOpacity = mesh.userData?.baseOpacity ?? 1;
    const layerType = mesh.userData?.layerType;
    const profileFactor = this._effectiveFactor(layerType, profile);
    const levelFactor = mesh.userData?.__levelFactor ?? 1;
    const selectionFactor = this._selectionFactor(mesh);
    return clamp01(baseOpacity * profileFactor * levelFactor * selectionFactor);
  }

  _selectionFactor(mesh) {
    if (this._selectedId == null) return 1.0;
    if (mesh.userData?.id === this._selectedId) return 1.0;
    return SELECTION_DIM_FACTOR;
  }

  /**
   * What would the target opacity be for this mesh on `pageName`,
   * accounting for current selection / level / layer overrides.
   *
   * Used by ThreeCanvas to decide whether selection should be cleared
   * before a page transition (a wireframe sitting on a near-invisible
   * mesh is worse than no wireframe at all).
   */
  willBeVisibleOnPage(mesh, pageName, threshold = SELECTION_VISIBILITY_THRESHOLD) {
    const profile = PAGE_PROFILES[pageName] || PAGE_PROFILES.geometry;
    return this._targetOpacity(mesh, profile) >= threshold;
  }

  /**
   * Switch to a new page profile. Cancels any in-flight transition.
   *
   * @param {string} pageName
   * @param {{instant?: boolean}} [opts] - if instant, snap without animating.
   */
  applyPageMode(pageName, opts = {}) {
    this.currentPage = pageName;
    this._cancel();

    const profile = PAGE_PROFILES[pageName] || PAGE_PROFILES.geometry;
    const tweens = new Map();

    this.registry.objectsByLayer.forEach((meshes) => {
      meshes.forEach((mesh) => {
        const target = this._targetOpacity(mesh, profile);
        const current = readOpacity(mesh);
        if (Math.abs(current - target) < 0.005) {
          writeOpacity(mesh, target);
          mesh.visible = target > 0.005;
          return;
        }
        tweens.set(mesh, { from: current, to: target });
      });
    });

    if (opts.instant || tweens.size === 0) {
      tweens.forEach(({ to }, mesh) => {
        writeOpacity(mesh, to);
        mesh.visible = to > 0.005;
      });
      this.onChange();
      return;
    }

    this._tweens = tweens;
    this._startTime = performance.now();
    this._tick();
  }

  /**
   * Override layer enable/disable flags from the layers popover. Each
   * call replaces the override map; pass empty `{}` to clear.
   * Keys mirror the popover keys (floorPlates, grids, ...).
   */
  setLayerOverrides(overrides) {
    this._layerOverrides = overrides || {};
    if (this.currentPage) this.applyPageMode(this.currentPage, { instant: true });
  }

  /**
   * Update the active selection. Non-selected meshes get dimmed to
   * `SELECTION_DIM_FACTOR` of their current page-mode target; the
   * selected mesh stays at full target. Pass `null` to clear.
   *
   * Selection is just another multiplicative factor in `_targetOpacity`,
   * so calling this method with the current page mode active produces
   * a clean transition whether we're tweening or snapping.
   */
  setSelection(meshId) {
    if (this._selectedId === meshId) return;
    this._selectedId = meshId;
    // Animated, not instant — clicking a column should fade the rest
    // out smoothly rather than snap. The same tween path takes care of
    // cancelling any in-flight page-mode transition correctly.
    if (this.currentPage) this.applyPageMode(this.currentPage);
  }

  /** Re-apply current page mode (call after rebuildScheme or geometry rebuild). */
  refresh() {
    if (this.currentPage) this.applyPageMode(this.currentPage, { instant: true });
  }

  // ─────────────────────────────────────────────────────────
  // Layer override mapping
  // ─────────────────────────────────────────────────────────

  _effectiveFactor(layerType, profile) {
    const popoverKey = LAYER_TO_POPOVER[layerType];
    const baseFactor = profile[layerType] ?? 0.0;
    if (!popoverKey) return baseFactor;
    const flag = this._layerOverrides[popoverKey];
    if (flag === false) return 0.0;
    return baseFactor;
  }

  // ─────────────────────────────────────────────────────────
  // rAF lifecycle
  // ─────────────────────────────────────────────────────────

  _tick = () => {
    const now = performance.now();
    const t = Math.min((now - this._startTime) / TRANSITION_MS, 1);
    const eased = 1 - Math.pow(1 - t, 3);

    let stillRunning = false;
    this._tweens.forEach(({ from, to }, mesh) => {
      const v = from + (to - from) * eased;
      writeOpacity(mesh, v);
      mesh.visible = v > 0.005;
      if (t < 1) stillRunning = true;
    });
    this.onChange();

    if (stillRunning) {
      this._raf = requestAnimationFrame(this._tick);
    } else {
      this._raf = null;
      this._tweens.clear();
    }
  };

  _cancel() {
    if (this._raf != null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    this._tweens.clear();
  }

  dispose() { this._cancel(); }
}

// ---------------------------------------------------------------------------
// Profile-key → granular layerType mapping for layer-popover overrides.
// (Section 4 of the agent spec.)
// ---------------------------------------------------------------------------

const LAYER_TO_POPOVER = {
  "slab":         "floorPlates",
  "slab-edge":    "floorPlates",
  "grid":         "grids",
  "core":         "cores",
  "core-edge":    "cores",
  "noColumnZone": "noColumnZones",
  "column":       "columns",
  "beam":         "beams",
  "wall":         "shearWalls",
  "wall-edge":    "shearWalls",
  "load":         "loads",
  "tributary":    "tributary",
};

// ---------------------------------------------------------------------------
// Opacity I/O helpers. Target computation lives on the controller (see
// `_targetOpacity`) because it needs access to selection + override state.
// ---------------------------------------------------------------------------

function readOpacity(mesh) {
  if (mesh.material?.opacity != null) return mesh.material.opacity;
  // ArrowHelper / composite — read line/cone if available
  if (mesh.line?.material?.opacity != null) return mesh.line.material.opacity;
  if (mesh.children?.[0]?.material?.opacity != null) return mesh.children[0].material.opacity;
  return 1;
}

function writeOpacity(mesh, value) {
  if (mesh.material) {
    mesh.material.transparent = true;
    mesh.material.opacity = value;
  }
  // ArrowHelper line + cone
  if (mesh.line?.material) {
    mesh.line.material.transparent = true;
    mesh.line.material.opacity = value;
  }
  if (mesh.cone?.material) {
    mesh.cone.material.transparent = true;
    mesh.cone.material.opacity = value;
  }
  // Children edges
  mesh.children?.forEach((child) => {
    if (child.material) {
      child.material.transparent = true;
      child.material.opacity = value;
    }
  });
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
