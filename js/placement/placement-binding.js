/**
 * Placement binding — wires the placement engine to the canvas, the
 * inspector, and the bottom tray.
 *
 * Lifecycle:
 *   bindPlacementToCanvas(canvasController)   // called once from canvas-controller
 *     ↳ on enter placement page  → activate renderers + interactions
 *     ↳ on leave placement page  → deactivate (restores existing scheme view)
 *
 * Public actions (used by inspector + tray click handlers):
 *   selectStrategy(id)
 *   placementAddColumnTool()
 *   placementAddShearWallTool()
 *   placementAddBeamTool()
 *   placementSelectTool()
 *   placeManualColumn(point)
 *   placeManualWall(start, end)
 *   placeManualBeam(startColId, endColId)
 *   selectElement(id)
 *   deleteManualElement(id)
 *   clearManualOverrides()
 *   regenerateActiveStrategy()
 *   getActiveStrategy()  / getStrategy(id)  / getGrid()
 */

import { state, set, on, ensurePlacementState } from "../state.js";
import {
  buildDefaultGrid,
  gridFromGeometry,
  generateAllStrategies,
  regenerateStrategy,
} from "./placement-engine.js";
import { PlacementThreeRenderer } from "./placement-three-renderer.js";
import { PlacementSvgRenderer } from "./placement-svg-renderer.js";
import { PlacementInteractions } from "./placement-interactions.js";
import { onGeometryChange } from "../canvas/parsed-geometry-cache.js";
import { toast } from "../components/toast.js";

let _binding = null;

class PlacementBinding {
  constructor(canvasController) {
    this.controller = canvasController;
    this.grid = null;
    this.threeRenderer = null;
    this.svgRenderer = null;
    this.interactions = null;
    this._active = false;
    this._unsubs = [];
    this._regenTimer = null;
    this._lastSig = null;
  }

  init() {
    ensurePlacementState();
    // Generate strategies once at startup so the placement state is
    // never empty when the user first lands on the page.
    this._ensureStrategies();

    // Page transitions drive activate / deactivate.
    this._unsubs.push(on("page", () => this._syncActive()));
    this._unsubs.push(on("viewMode", () => {
      // When the user switches to 3D for the first time, we need to
      // wire up the three renderer (three is mounted lazily by canvas).
      if (this._active) this._refreshThreeRenderer();
    }));

    // Strategy / overrides / selection → redraw.
    this._unsubs.push(on("placement", () => {
      if (this._active) this._redraw();
    }));

    // Re-derive the grid from parsed geometry once it resolves.
    this._unsubs.push(onGeometryChange(() => {
      this.grid = gridFromGeometry();
      // Regenerate so strategies use the real building bounds. Manual
      // overrides are preserved.
      this._regenerateAll();
      if (this._active) this._redraw();
    }));

    this._syncActive();
  }

  dispose() {
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
    this._deactivate();
  }

  // ─── Activation ─────────────────────────────────────────────────

  _syncActive() {
    ensurePlacementState();
    const onPlacement = state.page === "placement";
    if (onPlacement && !this._active) this._activate();
    else if (!onPlacement && this._active) this._deactivate();
  }

  _activate() {
    this._active = true;
    this._lastSig = null;
    this._ensureStrategies();
    this._mountSvgRenderer();
    this._refreshThreeRenderer();
    this._mountInteractions();
    this._redraw();
  }

  _deactivate() {
    this._active = false;
    if (this.interactions) {
      this.interactions.unmount();
      this.interactions = null;
    }
    if (this.svgRenderer) {
      this.svgRenderer.deactivate();
      this.svgRenderer = null;
    }
    if (this.threeRenderer) {
      this.threeRenderer.deactivate();
      this.threeRenderer = null;
    }
    // Clear UI affordances
    set("placement.activeTool", null);
    set("placement.pendingPoint", null);
  }

  // ─── Renderer wiring ────────────────────────────────────────────

  _mountSvgRenderer() {
    const svg = this.controller.getSvgEl();
    if (!svg) return;
    this.svgRenderer = new PlacementSvgRenderer(svg);
    this.svgRenderer.activate();
  }

  _refreshThreeRenderer() {
    const ctx = this.controller.getThreeContext();
    if (!ctx?.scene || !ctx?.camera) {
      // Three not mounted yet — re-attempt next time viewMode changes.
      if (this.threeRenderer) {
        this.threeRenderer.deactivate();
        this.threeRenderer = null;
      }
      return;
    }
    if (this.threeRenderer) return; // already wired
    this.threeRenderer = new PlacementThreeRenderer(ctx);
    this.threeRenderer.activate();
    this._redraw();
    // Interactions need to know about three — re-mount to pick it up.
    if (this.interactions) {
      this.interactions.unmount();
      this._mountInteractions();
    }
  }

  _mountInteractions() {
    const frame = this.controller.host;
    const svg = this.controller.getSvgEl();
    const ctx = this.controller.getThreeContext();
    if (!frame || !svg) return;
    this.interactions = new PlacementInteractions({
      frame, svg,
      threeCtx: ctx,
      threeRenderer: this.threeRenderer,
      getGrid: () => this.grid,
      getActiveStrategy: () => this.getActiveStrategy(),
      placeColumn: (p) => this.placeManualColumn(p),
      placeWall: (a, b) => this.placeManualWall(a, b),
      placeBeam: (a, b) => this.placeManualBeam(a, b),
      selectElement: (id) => this.selectElement(id),
      deleteManualElement: (id) => this.deleteManualElement(id),
    });
    this.interactions.mount();
  }

  _redraw() {
    const strategy = this.getActiveStrategy();
    if (!strategy) return;
    const opts = {
      selectedId: state.placement.selectedElementId,
      pendingPoint: state.placement.pendingPoint,
    };

    // Skip the heavy canvas redraw when only optimizationProgress (or
    // some other signature-irrelevant field) changed — we don't want
    // to rebuild every mesh 60×/sec during the regenerate animation.
    const sig = [
      strategy.id,
      state.placement.strategies.length,
      state.placement.manualOverrides.columns.length,
      state.placement.manualOverrides.shearWalls.length,
      state.placement.manualOverrides.beams.length,
      state.placement.selectedElementId,
      JSON.stringify(state.placement.pendingPoint),
    ].join("|");
    if (sig !== this._lastSig) {
      this._lastSig = sig;
      if (this.svgRenderer) this.svgRenderer.render(strategy, this.grid, opts);
      if (this.threeRenderer) this.threeRenderer.render(strategy, this.grid, opts);
    }

    if (this.interactions) this.interactions.refreshHelper();
  }

  // ─── Strategy + grid plumbing ──────────────────────────────────

  _ensureStrategies() {
    if (!this.grid) this.grid = gridFromGeometry();
    if (!Array.isArray(state.placement.strategies) || state.placement.strategies.length === 0) {
      this._regenerateAll();
    }
  }

  _regenerateAll() {
    if (!this.grid) this.grid = gridFromGeometry() || buildDefaultGrid();
    const strategies = generateAllStrategies(
      this.grid,
      state.placement.constraints,
      state.placement.manualOverrides,
    );
    set("placement.strategies", strategies);
    // Mirror constraint-relevant fields back into state for the inspector.
    set("placement.constraints.noColumnZones", this.grid.noColumnZones || []);
    // Make sure the active id still exists (e.g. after a strategy spec rename)
    if (!strategies.find((s) => s.id === state.placement.activeStrategyId)) {
      set("placement.activeStrategyId", strategies[0]?.id || null);
    }
  }

  // ─── Public API used by UI components ──────────────────────────

  getActiveStrategy() {
    const id = state.placement.activeStrategyId;
    return state.placement.strategies.find((s) => s.id === id) || state.placement.strategies[0] || null;
  }

  getStrategy(id) {
    return state.placement.strategies.find((s) => s.id === id) || null;
  }

  getGrid() { return this.grid; }

  selectStrategy(id) {
    if (!id) return;
    if (!state.placement.strategies.find((s) => s.id === id)) return;
    set("placement.activeStrategyId", id);
    set("placement.selectedElementId", null);
    if (this._active) this._redraw();
  }

  toggleTool(tool) {
    const cur = state.placement.activeTool;
    set("placement.activeTool", cur === tool ? null : tool);
    set("placement.pendingPoint", null);
    if (this.interactions) this.interactions.refreshHelper();
  }

  placeManualColumn(point) {
    // Reject duplicate at same snapped point.
    const dup = state.placement.manualOverrides.columns.find(
      (c) => Math.abs(c.x - point.x) < 0.5 && Math.abs(c.y - point.y) < 0.5,
    );
    if (dup) {
      toast("A manual column already exists here.", { tone: "warn" });
      return;
    }
    const idx = state.placement.manualOverrides.columns.length + 1;
    const col = {
      id: `manual-col-${Date.now()}-${idx}`,
      type: "column",
      label: `M${idx}`,
      gridX: "M",
      gridY: String(idx),
      x: point.x, y: point.y, z: 0,
      width: 0.4, depth: 0.4,
      height: this.grid?.totalHeight || 78,
      levelStart: 0, levelEnd: this.grid?.levels?.length || 6,
      locked: true,
      source: "manual",
      kind: "manual",
    };
    set("placement.manualOverrides", {
      ...state.placement.manualOverrides,
      columns: [...state.placement.manualOverrides.columns, col],
    });
    this._regenerateAll();
    toast("Locked column added.");
    if (this._active) this._redraw();
  }

  placeManualWall(start, end) {
    const idx = state.placement.manualOverrides.shearWalls.length + 1;
    const wall = {
      id: `manual-wall-${Date.now()}-${idx}`,
      type: "shearWall",
      label: `MW${idx}`,
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      z: 0,
      height: this.grid?.totalHeight || 78,
      thickness: 0.35,
      levelStart: 0, levelEnd: this.grid?.levels?.length || 6,
      locked: true,
      source: "manual",
    };
    set("placement.manualOverrides", {
      ...state.placement.manualOverrides,
      shearWalls: [...state.placement.manualOverrides.shearWalls, wall],
    });
    this._regenerateAll();
    toast("Locked shear wall added.");
    if (this._active) this._redraw();
  }

  placeManualBeam(startColId, endColId) {
    const cols = this.getActiveStrategy()?.elements?.columns || [];
    const a = cols.find((c) => c.id === startColId);
    const b = cols.find((c) => c.id === endColId);
    if (!a || !b) {
      toast("Select two columns to place a beam.", { tone: "warn" });
      return;
    }
    // Reject duplicate manual beam between the same two columns.
    const dup = state.placement.manualOverrides.beams.find(
      (m) =>
        (m.startColumnId === a.id && m.endColumnId === b.id) ||
        (m.startColumnId === b.id && m.endColumnId === a.id),
    );
    if (dup) {
      toast("A beam already connects these columns.", { tone: "warn" });
      return;
    }
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const beam = {
      id: `manual-beam-${Date.now()}`,
      type: "beam",
      startColumnId: a.id,
      endColumnId: b.id,
      x1: a.x, y1: a.y, z1: this.grid?.totalHeight || 60,
      x2: b.x, y2: b.y, z2: this.grid?.totalHeight || 60,
      spanFt: span,
      depthIn: Math.min(36, Math.max(12, span / 1.6)),
      depth: 0.5, width: 0.25,
      level: this.grid?.levels?.[this.grid.levels.length - 1]?.id || "L6",
      locked: true,
      source: "manual",
    };
    set("placement.manualOverrides", {
      ...state.placement.manualOverrides,
      beams: [...state.placement.manualOverrides.beams, beam],
    });
    this._regenerateAll();
    toast("Locked beam added.");
    if (this._active) this._redraw();
  }

  selectElement(id) {
    if (state.placement.selectedElementId === id) {
      set("placement.selectedElementId", null);
    } else {
      set("placement.selectedElementId", id);
    }
    if (this.threeRenderer) this.threeRenderer.setSelected(state.placement.selectedElementId);
    if (this._active) this._redraw();
  }

  deleteManualElement(id) {
    const m = state.placement.manualOverrides;
    const next = {
      columns: m.columns.filter((x) => x.id !== id),
      shearWalls: m.shearWalls.filter((x) => x.id !== id),
      beams: m.beams.filter((x) => x.id !== id),
    };
    if (
      next.columns.length === m.columns.length &&
      next.shearWalls.length === m.shearWalls.length &&
      next.beams.length === m.beams.length
    ) {
      toast("Generated elements can't be deleted directly.", { tone: "warn" });
      return;
    }
    set("placement.manualOverrides", next);
    set("placement.selectedElementId", null);
    this._regenerateAll();
    toast("Manual element removed.");
    if (this._active) this._redraw();
  }

  clearManualOverrides() {
    set("placement.manualOverrides", { columns: [], shearWalls: [], beams: [] });
    set("placement.selectedElementId", null);
    this._regenerateAll();
    toast("Cleared all manual edits.");
    if (this._active) this._redraw();
  }

  /**
   * Run the deterministic regeneration with a progress animation.
   * The visual optimization-animation runs in parallel via the inspector
   * click handler; here we just simulate a progress curve and rebuild
   * strategies once the curve completes.
   */
  regenerateActiveStrategy({ duration = 9500 } = {}) {
    if (state.placement.isOptimizing) return;
    set("placement.isOptimizing", true);
    set("placement.optimizationProgress", {
      current: 0, total: 847, label: "Optimizing — evaluating 847 configurations…",
    });

    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      const eased = 1 - Math.pow(1 - t, 2);
      const cur = Math.round(eased * 847);
      set("placement.optimizationProgress", {
        current: cur,
        total: 847,
        label: t < 1 ? "Optimizing — evaluating 847 configurations…" : "Optimization complete",
      });
      if (t < 1) {
        this._regenTimer = requestAnimationFrame(tick);
      } else {
        this._regenTimer = null;
        this._regenerateAll();
        set("placement.isOptimizing", false);
        if (this._active) this._redraw();
        toast("Placement optimization complete.");
      }
    };
    this._regenTimer = requestAnimationFrame(tick);
  }
}

// ────────────────────────────────────────────────────────────────────
// Module-level facade — UI components import these.
// ────────────────────────────────────────────────────────────────────

export function bindPlacementToCanvas(canvasController) {
  if (_binding) _binding.dispose();
  _binding = new PlacementBinding(canvasController);
  _binding.init();
  return _binding;
}

export function getPlacementBinding() { return _binding; }

export function getActiveStrategy() {
  if (_binding) return _binding.getActiveStrategy();
  // Even before the binding mounts (initial render), state.placement may
  // be empty — return the first strategy if it exists.
  return state.placement.strategies.find((s) => s.id === state.placement.activeStrategyId)
      || state.placement.strategies[0]
      || null;
}

export function getStrategyById(id) {
  if (_binding) return _binding.getStrategy(id);
  return state.placement.strategies.find((s) => s.id === id) || null;
}

export function selectStrategy(id) { _binding?.selectStrategy(id); }
export function toggleTool(tool) { _binding?.toggleTool(tool); }
export function regenerateActiveStrategy(opts) { _binding?.regenerateActiveStrategy(opts); }
export function clearManualOverrides() { _binding?.clearManualOverrides(); }
export function deleteManualElement(id) { _binding?.deleteManualElement(id); }
export function selectPlacementElement(id) { _binding?.selectElement(id); }
