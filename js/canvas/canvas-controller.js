/**
 * Canvas controller — keeps a persistent SVG canvas + Three.js viewport
 * around and shows whichever ones the active view mode requires.
 *
 * Used by both the workspace (geometry/placement/loads/schemes/sizing) and
 * the overview model preview (which embeds a small auto-rotating Three view).
 */

import { state, on } from "../state.js";
import { SvgCanvas } from "./svg-canvas.js";
import { ThreeCanvas } from "./three-canvas.js";
import { icon } from "../utils/icons.js";
import { iconBtn } from "../utils/helpers.js";
import { on as delegate } from "../utils/dom.js";
import { levels as mockLevels } from "../data/mock-project.js";
import { listCachedSchemes } from "./scheme-adapter.js";
import {
  getPlanGeometry,
  onGeometryChange,
} from "./parsed-geometry-cache.js";
import { onGenerationStateChange } from "../components/scheme-generator.js";
import { toast } from "../components/toast.js";
import { bindPlacementToCanvas } from "../placement/placement-binding.js";

const VIEW_MODES = ["2d", "3d", "section", "split"];

// Singleton handle to the most-recently-mounted canvas controller. Lets the
// optimization animation orchestrator (and other cross-cutting features that
// need direct access to the SVG / Three scene) reach the live canvas without
// threading a reference through five layers of components.
let _activeController = null;

/**
 * Return the most-recently-mounted CanvasController, or null when no
 * canvas is currently mounted.
 */
export function getActiveCanvasController() {
  return _activeController;
}

/**
 * Levels for the "active level" dropdown. Sourced from the parsed
 * geometry cache when available, falling back to the bundled mock
 * level set so the dropdown is never empty in offline / fixture mode.
 */
function _activeLevels() {
  const plan = getPlanGeometry();
  if (plan && Array.isArray(plan.levels) && plan.levels.length > 0) {
    return plan.levels.map((l) => ({ id: l.id, name: l.name || l.id }));
  }
  return mockLevels;
}

function _levelOptions() {
  const levels = _activeLevels();
  return levels
    .map(
      (l) =>
        `<option value="${l.id}" ${state.activeLevelId === l.id ? "selected" : ""}>${l.name}</option>`,
    )
    .join("");
}

/**
 * Build `<option>` elements from the live scheme cache.
 * Falls back to a placeholder when no schemes have been generated yet.
 */
function _schemeOptions() {
  const cached = listCachedSchemes();
  if (cached.length === 0) {
    return `<option value="" disabled selected>No schemes yet</option>`;
  }
  return cached
    .map(
      (s) =>
        `<option value="${s.id}" ${state.activeSchemeId === s.id ? "selected" : ""}>Scheme ${s.displayLabel || ""} — ${s.name || s.strategy || ""}</option>`,
    )
    .join("");
}

export class CanvasController {
  constructor(host) {
    this.host = host;
    this.svg = null;
    this.three = null;
    this.threeReady = false;
    this._unsubs = [];
  }

  mount() {
    this.host.classList.add("canvas-frame");
    _activeController = this;
    this._renderShell();
    this._mountSvg();
    // Three is mounted lazily the first time the user enters 3D
    delegate(this.host, "click", "[data-view-mode]", (_e, target) => {
      state.viewMode = target.dataset.viewMode;
    });
    delegate(this.host, "click", "[data-action='toggle-layers']", () => {
      state.showLayers = !state.showLayers;
    });
    delegate(this.host, "click", "[data-layer-toggle]", (_e, target) => {
      const key = target.dataset.layerToggle;
      state.layers = { ...state.layers, [key]: !state.layers[key] };
    });
    delegate(this.host, "change", "[data-canvas-level]", (e) => {
      state.activeLevelId = e.target.value;
    });
    delegate(this.host, "change", "[data-canvas-scheme]", (e) => {
      state.activeSchemeId = e.target.value;
    });
    delegate(this.host, "click", "[data-canvas-tool]", (_e, target) => {
      const tool = target.dataset.canvasTool;
      if (tool === "fit") {
        if (this.three) this.three.preset.apply("fit-all");
        toast("Fit to view");
      } else if (tool === "reset") {
        if (this.three) this.three.preset.apply("iso-3d");
        toast("View reset");
      } else if (tool === "screenshot") {
        toast("Screenshot copied");
      }
    });

    this._unsubs.push(on("viewMode", () => this._applyMode()));
    this._unsubs.push(on("page", () => {
      this._applyMode();
      this._refreshTopLeft();
    }));
    this._unsubs.push(on("sourceModelStatus", () => this._refreshSourceBadge()));
    this._unsubs.push(on("showLayers", () => this._renderLayerPopover()));
    this._unsubs.push(on("layers", () => this._renderLayerPopover()));
    this._unsubs.push(on("activeLevelId", () => this._syncToolbarSelections()));
    this._unsubs.push(on("activeSchemeId", () => this._syncToolbarSelections()));
    // Rebuild scheme dropdown when generation completes and cache is populated.
    this._unsubs.push(onGenerationStateChange(() => this._syncToolbarSelections()));
    // Rebuild level dropdown when parsed geometry resolves so the
    // labels match the building the user actually uploaded.
    this._unsubs.push(onGeometryChange(() => this._syncToolbarSelections()));

    this._applyMode();
    this._renderLayerPopover();

    // Initialize the placement domain once the canvas is mounted.
    // The binding subscribes to page changes itself, so it activates
    // automatically when the user navigates onto the placement page.
    this._placementBinding = bindPlacementToCanvas(this);
  }

  _syncToolbarSelections() {
    // Rebuild level options (parsed-geometry cache may have changed)
    const lvl = this.host.querySelector("[data-canvas-level]");
    if (lvl) {
      const desired = state.activeLevelId;
      lvl.innerHTML = _levelOptions();
      // If the previously-selected level isn't in the new list, fall
      // back to the topmost level so dependent UI doesn't stall on a
      // dangling activeLevelId.
      const available = _activeLevels();
      if (desired && !available.some((l) => l.id === desired)) {
        const fallback = available[available.length - 1]?.id;
        if (fallback) state.activeLevelId = fallback;
      } else if (desired) {
        lvl.value = desired;
      }
    }
    // Rebuild scheme options (cache may have changed after generation)
    const sch = this.host.querySelector("[data-canvas-scheme]");
    if (sch) {
      sch.innerHTML = _schemeOptions();
      if (state.activeSchemeId) sch.value = state.activeSchemeId;
    }
  }

  // ─────────────────────────────────────────────
  // Initial DOM
  // ─────────────────────────────────────────────
  _renderShell() {
    this.host.innerHTML = `
      <div class="canvas-pane" data-pane="primary">
        <div class="svg-host"></div>
        <div class="three-host"></div>
        <div class="canvas-overlay canvas-overlay--top-left">
          <span class="canvas-context-tag"><strong></strong> · <span class="ctx-mode"></span></span>
          <span class="source-model-badge" data-source-badge hidden></span>
        </div>
        <div class="canvas-overlay canvas-overlay--top-right">
          <div class="canvas-toolbar">
            ${iconBtn("select", { label: "Select", active: true })}
            ${iconBtn("measure", { label: "Measure" })}
            ${iconBtn("model", { label: "Isolate" })}
            <span class="toolbar-divider"></span>
            ${iconBtn("reset", { label: "Reset view", data: { "canvas-tool": "reset" } })}
            ${iconBtn("export", { label: "Screenshot", data: { "canvas-tool": "screenshot" } })}
            ${iconBtn("layers", { label: "Layers", data: { action: "toggle-layers" } })}
          </div>
        </div>
        <div class="canvas-overlay canvas-overlay--bottom-left">
          <div class="canvas-toolbar">
            <div class="segmented" role="tablist" aria-label="View mode">
              ${VIEW_MODES.map(
                (m) => `<button class="${state.viewMode === m ? "is-active" : ""}" data-view-mode="${m}">${m === "2d" ? "2D" : m === "3d" ? "3D" : m[0].toUpperCase() + m.slice(1)}</button>`,
              ).join("")}
            </div>
            <span class="toolbar-divider"></span>
            <select data-canvas-level aria-label="Active level">
              ${_levelOptions()}
            </select>
            <button class="toolbar-btn ${state.layers.grids ? "is-active" : ""}" data-layer-toggle="grids">Grid</button>
            <select data-canvas-scheme aria-label="Active scheme">
              ${_schemeOptions()}
            </select>
            <button class="toolbar-btn" data-canvas-tool="fit">${icon("model", 14)}<span>Fit</span></button>
          </div>
        </div>
      </div>
    `;
    this.primaryPane = this.host.querySelector('[data-pane="primary"]');
    this.svgHost = this.primaryPane.querySelector(".svg-host");
    this.threeHost = this.primaryPane.querySelector(".three-host");
    this.modeContextEl = this.primaryPane.querySelector(".ctx-mode");
    this.titleContextEl = this.primaryPane.querySelector(".canvas-context-tag strong");
    this._refreshTopLeft();
  }

  _refreshTopLeft() {
    if (this.titleContextEl) this.titleContextEl.textContent = state.page.toUpperCase();
    if (this.modeContextEl) this.modeContextEl.textContent = state.viewMode.toUpperCase();
  }

  _refreshSourceBadge() {
    const badge = this.host?.querySelector("[data-source-badge]");
    if (!badge) return;
    const status = state.sourceModelStatus;
    const labels = {
      idle: "",
      loading: "Source model loading…",
      loaded: "Source model loaded",
      error: "Source model failed",
    };
    badge.textContent = labels[status] || "";
    badge.dataset.status = status;
    badge.hidden = status === "idle" || status === "loaded";
  }

  // ─────────────────────────────────────────────
  // 2D / 3D management
  // ─────────────────────────────────────────────
  _mountSvg() {
    this.svg = new SvgCanvas(this.svgHost);
    this.svg.mount();
  }

  _ensureThree() {
    if (this.threeReady) return;
    this.three = new ThreeCanvas(this.threeHost);
    this.three.mount();
    this.threeReady = true;
  }

  _applyMode() {
    this._refreshTopLeft();
    const segs = this.host.querySelectorAll("[data-view-mode]");
    segs.forEach((b) => b.classList.toggle("is-active", b.dataset.viewMode === state.viewMode));

    const mode = state.viewMode;
    this.host.dataset.mode = mode;

    const showSvg = mode === "2d";
    const showThree = mode === "3d" || mode === "section" || mode === "split";

    this.svgHost.style.display = showSvg || mode === "split" ? "" : "none";
    this.threeHost.style.display = showThree ? "" : "none";

    if (showThree) {
      this._ensureThree();
      this.three.resume();
      if (mode === "section") {
        this.three.preset.apply("section");
      } else {
        // Let the page mode pick the appropriate preset (iso-3d, top-down, iso-tilted)
        this.three.setPageMode(state.page);
      }
    } else if (this.three) {
      this.three.pause();
    }
  }

  // ─────────────────────────────────────────────
  // Layer popover
  // ─────────────────────────────────────────────
  _renderLayerPopover() {
    const existing = this.host.querySelector(".layer-popover");
    if (!state.showLayers) {
      if (existing) existing.remove();
      return;
    }
    const layers = [
      // Source model
      ["sourceModel", "Source Model (IFC)"],
      null, // separator
      // Civil Agent structural interpretation
      ["structuralInterpretation", "Structural Interpretation"],
      ["floorPlates", "  Floor plates"],
      ["grids", "  Grids"],
      ["cores", "  Cores"],
      ["noColumnZones", "  No-column zones"],
      null, // separator
      // Generated scheme
      ["generatedScheme", "Generated Scheme"],
      ["columns", "  Columns"],
      ["beams", "  Beams"],
      ["shearWalls", "  Shear walls"],
      ["braces", "  Braces"],
      null, // separator
      // Overlays
      ["loads", "Loads"],
      ["tributary", "Tributary areas"],
      ["warnings", "Warnings"],
      ["labels", "Labels"],
    ];
    const html = `<div class="layer-popover" role="menu">
      ${layers
        .map((item) => {
          if (!item) return `<hr class="layer-sep">`;
          const [k, label] = item;
          return `<button data-layer-toggle="${k}" aria-pressed="${!!state.layers[k]}"><span>${label}</span></button>`;
        })
        .join("")}
    </div>`;
    if (existing) {
      existing.outerHTML = html;
    } else {
      this.host.insertAdjacentHTML("beforeend", html);
    }
  }

  unmount() {
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
    if (this._placementBinding) {
      this._placementBinding.dispose();
      this._placementBinding = null;
    }
    if (this.three) this.three.unmount();
    if (this.svg) this.svg.unmount();
    this.host.innerHTML = "";
    if (_activeController === this) _activeController = null;
  }

  // ─────────────────────────────────────────────
  // Accessors used by the optimization-animation orchestrator
  // ─────────────────────────────────────────────

  getSvgEl() {
    return this.svgHost?.querySelector("svg") || null;
  }

  getSvgOverlayLayer() {
    return this.svgHost?.querySelector("svg .layer-overlay") || null;
  }

  getThreeContext() {
    if (!this.three) return null;
    return {
      scene: this.three.scene,
      camera: this.three.activeCamera,
      registry: this.three.builder?.registry || null,
      structuralGroup: this.three.structuralGroup || null,
      pageMode: this.three.pageMode || null,
      requestRender: () => this.three.requestRender(),
    };
  }

  /**
   * Mode of the canvas that is currently visible. The orchestrator uses
   * this to decide whether to drive the SVG or Three.js path.
   */
  getActiveSurface() {
    const m = state.viewMode;
    if (m === "2d") return "svg";
    return "three"; // 3d / section / split → Three is visible
  }
}
