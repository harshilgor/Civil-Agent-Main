/**
 * SVG canvas — 2D plan view of the structural model.
 *
 * Plan units are feet; we apply a fit-to-bounds transform so the building
 * always renders centered with margin in the host.
 */

import {
  buildingBounds as mockBuildingBounds,
  cores as mockCores,
  noColumnZones as mockNoColumnZones,
  gridLines as mockGridLines,
  slabZones as mockSlabZones,
} from "../data/mock-project.js";
import { columns, beams, shearWalls, braces } from "../data/mock-members.js";
import { state, on } from "../state.js";
import { on as delegate } from "../utils/dom.js";
import {
  getPlanGeometry,
  onGeometryChange,
} from "./parsed-geometry-cache.js";

/**
 * Pull the current plan-frame geometry from the cache, or fall back
 * to bundled mocks. The mock fallback keeps legacy demo projects
 * working without network access; once `loadParsedGeometry` resolves
 * for the active project, the cache wins.
 */
function planSource() {
  const live = getPlanGeometry();
  if (live) return live;
  return {
    levels: [],
    gridLines: mockGridLines,
    cores: mockCores,
    noColumnZones: mockNoColumnZones,
    slabZones: mockSlabZones,
    buildingBounds: mockBuildingBounds,
    overallConfidence: null,
    warnings: [],
  };
}

export class SvgCanvas {
  constructor(host) {
    this.host = host;
    this.host.classList.add("svg-host");
    this.svg = null;
    this.tooltip = null;
    this.hideTooltipTimer = null;
    this._unsubs = [];
    this._onResize = this._onResize.bind(this);
  }

  mount() {
    this.host.innerHTML = `
      <svg viewBox="-15 -15 175 110" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Structural plan view">
        <defs>
          <pattern id="core-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.06)" stroke-width="0.4"/>
          </pattern>
          <pattern id="ncz-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(239,68,68,0.08)" stroke-width="0.4"/>
          </pattern>
          <marker id="arrow-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path class="load-arrow-head" d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        <g class="layer-floor"></g>
        <g class="layer-grids"></g>
        <g class="layer-grid-labels"></g>
        <g class="layer-cores"></g>
        <g class="layer-ncz"></g>
        <g class="layer-slabs"></g>
        <g class="layer-tributary"></g>
        <g class="layer-walls"></g>
        <g class="layer-braces"></g>
        <g class="layer-beams"></g>
        <g class="layer-columns"></g>
        <g class="layer-loads"></g>
        <g class="layer-warnings"></g>
        <g class="layer-labels"></g>
        <g class="layer-overlay"></g>
      </svg>
    `;
    this.svg = this.host.querySelector("svg");
    this.tooltip = document.createElement("div");
    this.tooltip.className = "canvas-tooltip";
    this.tooltip.style.display = "none";
    this.host.appendChild(this.tooltip);

    delegate(this.svg, "click", "[data-select-type]", (_e, target) => {
      state.selectedObject = {
        type: target.dataset.selectType,
        id: target.dataset.selectId,
      };
    });
    delegate(this.svg, "mousemove", "[data-select-type]", (e, target) => {
      this._showTooltip(e, target);
    });
    delegate(this.svg, "mouseleave", "[data-select-type]", () => {
      this._hideTooltip();
    });
    this.svg.addEventListener("click", (e) => {
      if (e.target === this.svg) state.selectedObject = null;
    });

    this._subscribe();
    this.update();
    window.addEventListener("resize", this._onResize);
  }

  unmount() {
    window.removeEventListener("resize", this._onResize);
    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];
    this.host.innerHTML = "";
  }

  _subscribe() {
    this._unsubs.push(on("selectedObject", () => this.update()));
    this._unsubs.push(on("layers", () => this.update()));
    this._unsubs.push(on("activeLevelId", () => this.update()));
    this._unsubs.push(on("page", () => this.update()));
    // Re-render when parsed geometry is fetched, refreshed, or accepted
    // so cores / grids / NCZ / slabs reflect the live API payload.
    this._unsubs.push(onGeometryChange(() => this.update()));
  }

  _onResize() {
    // SVG is responsive via viewBox; nothing required here yet.
  }

  // ─────────────────────────────────────────────
  // Drawing
  // ─────────────────────────────────────────────
  update() {
    if (!this.svg) return;
    const sel = state.selectedObject;
    this.svg.dataset.hasSelection = sel ? "true" : "false";
    this.svg.dataset.page = state.page;

    this._fitViewBoxToBounds();

    const showColumns = ["placement", "loads", "schemes", "sizing", "overview"].includes(state.page);
    const showBeams   = ["placement", "loads", "schemes", "sizing"].includes(state.page);
    const showWalls   = ["placement", "schemes", "sizing"].includes(state.page);
    const showNCZ     = state.page === "placement";

    this._drawFloor();
    this._drawGrids();
    this._drawCores();
    this._drawNCZ(showNCZ);
    this._drawSlabs();
    this._drawLoadHeatmap();           // Loads page only
    this._drawTributary();
    this._drawWalls(showWalls);
    this._drawBraces();
    this._drawBeams(showBeams);
    this._drawColumns(showColumns);
    this._drawLoads();                 // load arrows
    this._drawWarnings();
    this._drawLabels();
    this._drawOverlay();
  }

  _layer(name) {
    return this.svg.querySelector(`.layer-${name}`);
  }

  /**
   * Fit the SVG viewBox to the building bounds with a fixed margin.
   * Called every `update()` so the plan re-centres after geometry
   * swaps (initial load, project change, hot-swap from new-project
   * flow). Uses a 12 ft margin on each side to keep grid labels and
   * the floor-plate inset visible.
   */
  _fitViewBoxToBounds() {
    const { minX, minY, maxX, maxY } = planSource().buildingBounds;
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) ||
        !Number.isFinite(minY) || !Number.isFinite(maxY) ||
        maxX <= minX || maxY <= minY) {
      return; // empty / malformed — keep previous viewBox
    }
    const margin = 12;
    const x = minX - margin;
    const y = minY - margin;
    const w = (maxX - minX) + margin * 2;
    const h = (maxY - minY) + margin * 2;
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  }

  _drawFloor() {
    const layer = this._layer("floor");
    if (!state.layers.floorPlates) return (layer.innerHTML = "");
    const { minX, minY, maxX, maxY } = planSource().buildingBounds;
    layer.innerHTML = `<rect class="floor-plate" x="${minX + 4}" y="${minY + 4}" width="${maxX - minX - 8}" height="${maxY - minY - 8}" rx="0.4" />`;
  }

  _drawGrids() {
    const lineLayer = this._layer("grids");
    const labelLayer = this._layer("grid-labels");
    if (!state.layers.grids) {
      lineLayer.innerHTML = "";
      labelLayer.innerHTML = "";
      return;
    }
    const plan = planSource();
    const { minX, minY, maxX, maxY } = plan.buildingBounds;
    const padX = 6;
    const padY = 6;

    const lines = plan.gridLines
      .map((g) => {
        if (g.axis === "x") {
          return `<line class="grid-line selectable" data-select-type="grid" data-select-id="${g.id}" x1="${g.coordinate}" y1="${minY - padY}" x2="${g.coordinate}" y2="${maxY + padY}" />`;
        }
        return `<line class="grid-line selectable" data-select-type="grid" data-select-id="${g.id}" x1="${minX - padX}" y1="${g.coordinate}" x2="${maxX + padX}" y2="${g.coordinate}" />`;
      })
      .join("");
    lineLayer.innerHTML = lines;

    const labels = plan.gridLines
      .map((g) => {
        const x = g.axis === "x" ? g.coordinate : minX - padX - 2;
        const y = g.axis === "x" ? minY - padY - 2 : g.coordinate;
        return `<g><circle class="grid-label-bubble" cx="${x}" cy="${y}" r="2.4"/><text class="grid-label-text" x="${x}" y="${y}">${g.label}</text></g>`;
      })
      .join("");
    labelLayer.innerHTML = labels;
  }

  _drawCores() {
    const layer = this._layer("cores");
    if (!state.layers.cores) return (layer.innerHTML = "");
    layer.innerHTML = planSource().cores
      .map((c) => {
        const [x, y, w, h] = c.boundary;
        const sel = this._isSelected("core", c.id);
        return `
          <g class="selectable" data-select-type="core" data-select-id="${c.id}" data-selected="${sel}">
            <rect class="core" x="${x}" y="${y}" width="${w}" height="${h}" />
            <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#core-hatch)" pointer-events="none" />
            <text x="${x + w / 2}" y="${y + h / 2}" class="object-label" text-anchor="middle">${c.id}</text>
          </g>
        `;
      })
      .join("");
  }

  _drawNCZ(forceShow = true) {
    const layer = this._layer("ncz");
    if (!state.layers.noColumnZones || !forceShow) return (layer.innerHTML = "");
    layer.innerHTML = planSource().noColumnZones
      .map((z) => {
        const [x, y, w, h] = z.boundary;
        const sel = this._isSelected("noColumnZone", z.id);
        return `
          <g class="selectable" data-select-type="noColumnZone" data-select-id="${z.id}" data-selected="${sel}">
            <rect class="no-column-zone" x="${x}" y="${y}" width="${w}" height="${h}" />
            <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#ncz-hatch)" pointer-events="none" />
            <text x="${x + w / 2}" y="${y + h / 2}" class="object-label" text-anchor="middle" fill="rgba(239,68,68,0.6)">${z.name}</text>
          </g>
        `;
      })
      .join("");
  }

  _drawSlabs() {
    const layer = this._layer("slabs");
    if (state.page !== "loads" && state.page !== "sizing") {
      layer.innerHTML = "";
      return;
    }
    layer.innerHTML = planSource().slabZones
      .map((s) => {
        const [x, y, w, h] = s.boundary;
        return `<rect class="slab-zone" x="${x}" y="${y}" width="${w}" height="${h}" />`;
      })
      .join("");
  }

  _drawTributary() {
    const layer = this._layer("tributary");
    if (!state.layers.tributary) return (layer.innerHTML = "");
    layer.innerHTML = `
      <polygon class="tributary" points="56,18 84,18 84,52 56,52" />
      <polygon class="tributary" points="84,18 112,18 112,52 84,52" />
    `;
  }

  _drawWalls(forceShow = true) {
    const layer = this._layer("walls");
    if (!state.layers.shearWalls || !forceShow) return (layer.innerHTML = "");
    layer.innerHTML = shearWalls
      .map((w) => {
        const [x, y, ww, hh] = w.boundary;
        const isHorizontal = ww > hh;
        const sel = this._isSelected("shearWall", w.id);
        const x1 = isHorizontal ? x : x + ww / 2;
        const x2 = isHorizontal ? x + ww : x + ww / 2;
        const y1 = isHorizontal ? y + hh / 2 : y;
        const y2 = isHorizontal ? y + hh / 2 : y + hh;
        const status = state.page === "sizing" ? this._dcrStatus(w.dcr) : w.status;
        return `<line class="shear-wall selectable" data-select-type="shearWall" data-select-id="${w.id}" data-selected="${sel}" data-status="${status}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
      })
      .join("");
  }

  _drawBraces() {
    const layer = this._layer("braces");
    if (!state.layers.braces) return (layer.innerHTML = "");
    layer.innerHTML = braces
      .map((b) => {
        const sel = this._isSelected("brace", b.id);
        return `<line class="brace selectable" data-select-type="brace" data-select-id="${b.id}" data-selected="${sel}" data-status="${b.status}" x1="${b.start[0]}" y1="${b.start[1]}" x2="${b.end[0]}" y2="${b.end[1]}" />`;
      })
      .join("");
  }

  _drawBeams(forceShow = true) {
    const layer = this._layer("beams");
    if (!state.layers.beams || !forceShow) return (layer.innerHTML = "");
    layer.innerHTML = beams
      .map((b) => {
        const sel = this._isSelected("beam", b.id);
        const status = state.page === "sizing" ? this._dcrStatus(b.dcr) : b.status;
        return `<line class="beam selectable" data-select-type="beam" data-select-id="${b.id}" data-selected="${sel}" data-status="${status}" x1="${b.start[0]}" y1="${b.start[1]}" x2="${b.end[0]}" y2="${b.end[1]}" />`;
      })
      .join("");
  }

  _drawColumns(forceShow = true) {
    const layer = this._layer("columns");
    if (!state.layers.columns || !forceShow) return (layer.innerHTML = "");

    const heatmap = state.page === "loads";
    const dcrMode = state.page === "sizing";

    layer.innerHTML = columns
      .map((c) => {
        const sel = this._isSelected("column", c.id);
        const baseSize = 2.2;
        // Loads page: size circles by axial load
        let extra = "";
        let size = baseSize;
        if (heatmap) {
          const v = parseFloat(c.axialLoad || "0");
          const t = Math.min(v / 750, 1);
          size = 1.6 + t * 2.6;
          // Color halo by intensity
          const fill = this._loadHexCss(t);
          extra = `<circle cx="${c.x}" cy="${c.y}" r="${size}" fill="${fill}" fill-opacity="0.55" stroke="${fill}" stroke-opacity="0.9" stroke-width="0.4" />`;
          return `<g class="selectable" data-select-type="column" data-select-id="${c.id}" data-selected="${sel}">${extra}</g>`;
        }
        const status = dcrMode ? this._dcrStatus(c.dcr) : c.status;
        return `<rect class="column selectable" data-select-type="column" data-select-id="${c.id}" data-selected="${sel}" data-status="${status}" x="${c.x - size / 2}" y="${c.y - size / 2}" width="${size}" height="${size}" rx="0.4" />`;
      })
      .join("");
  }

  _drawLoads() {
    const layer = this._layer("loads");
    if (state.page !== "loads") {
      layer.innerHTML = "";
      return;
    }
    // Down arrows on slab panel centers
    const xs = [14, 42, 70, 98, 126];
    const ys = [13, 39, 65];
    const arrows = [];
    xs.forEach((x) => {
      ys.forEach((y) => {
        arrows.push(`<line class="load-arrow" x1="${x}" y1="${y - 6}" x2="${x}" y2="${y - 1}" marker-end="url(#arrow-head)" />`);
      });
    });
    layer.innerHTML = arrows.join("");
  }

  _drawLoadHeatmap() {
    const layer = this._layer("slabs");
    if (state.page !== "loads") return;
    // Monochrome blue heatmap on slab panels (intensity = mock load)
    const panels = [
      { x: 0,  y: 0,  w: 56, h: 26, intensity: 0.18 },
      { x: 56, y: 0,  w: 56, h: 26, intensity: 0.30 },
      { x: 112, y: 0, w: 36, h: 26, intensity: 0.22 },
      { x: 0,  y: 26, w: 56, h: 26, intensity: 0.28 },
      { x: 56, y: 26, w: 56, h: 26, intensity: 0.42 },
      { x: 112, y: 26, w: 36, h: 26, intensity: 0.32 },
      { x: 0,  y: 52, w: 56, h: 26, intensity: 0.20 },
      { x: 56, y: 52, w: 56, h: 26, intensity: 0.30 },
      { x: 112, y: 52, w: 36, h: 26, intensity: 0.25 },
    ];
    layer.innerHTML = panels
      .map(
        (p) => `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="rgba(59,130,246,${p.intensity})" stroke="rgba(59,130,246,0.4)" stroke-width="0.3" />`,
      )
      .join("");
  }

  _drawWarnings() {
    const layer = this._layer("warnings");
    if (!state.layers.warnings) return (layer.innerHTML = "");
    if (!["geometry", "loads", "sizing", "schemes"].includes(state.page)) {
      layer.innerHTML = "";
      return;
    }
    layer.innerHTML = `
      <g class="warning-marker selectable" data-select-type="beam" data-select-id="B21">
        <circle cx="56" cy="52" r="2.5"/><text x="56" y="52">!</text>
      </g>
      <g class="warning-marker is-fail selectable" data-select-type="shearWall" data-select-id="SW2">
        <circle cx="112" cy="20" r="2.5"/><text x="112" y="20">!</text>
      </g>
    `;
  }

  _drawLabels() {
    const layer = this._layer("labels");
    if (!state.layers.labels) return (layer.innerHTML = "");
    if (!state.selectedObject) {
      layer.innerHTML = "";
      return;
    }
    const sel = state.selectedObject;
    if (sel.type === "beam") {
      const b = beams.find((x) => x.id === sel.id);
      if (!b) return (layer.innerHTML = "");
      const mx = (b.start[0] + b.end[0]) / 2;
      const my = (b.start[1] + b.end[1]) / 2;
      layer.innerHTML = `<text class="object-label" x="${mx}" y="${my - 1.5}" text-anchor="middle">${b.id}</text>`;
    } else if (sel.type === "column") {
      const c = columns.find((x) => x.id === sel.id);
      if (!c) return (layer.innerHTML = "");
      layer.innerHTML = `<text class="object-label" x="${c.x + 2}" y="${c.y - 2}">${c.id}</text>`;
    } else {
      layer.innerHTML = "";
    }
  }

  _drawOverlay() {
    const layer = this._layer("overlay");
    if (!state.selectedObject) return (layer.innerHTML = "");
    const { type, id } = state.selectedObject;
    if (type === "column") {
      const c = columns.find((x) => x.id === id);
      if (!c) return (layer.innerHTML = "");
      layer.innerHTML = `<rect class="selection-ring" x="${c.x - 2}" y="${c.y - 2}" width="4" height="4" rx="0.5" />`;
    } else {
      layer.innerHTML = "";
    }
  }

  _isSelected(type, id) {
    const sel = state.selectedObject;
    return sel && sel.type === type && sel.id === id ? "true" : "false";
  }

  _dcrStatus(dcr) {
    if (!dcr) return "unsized";
    if (dcr <= 0.85) return "pass";
    if (dcr <= 0.95) return "warn";
    return "fail";
  }

  _loadHexCss(t) {
    // 0 = blue, 0.4 = green, 0.75 = yellow, 1 = red
    if (t < 0.4) return this._lerpHex("#3b82f6", "#22c55e", t / 0.4);
    if (t < 0.75) return this._lerpHex("#22c55e", "#eab308", (t - 0.4) / 0.35);
    return this._lerpHex("#eab308", "#ef4444", (t - 0.75) / 0.25);
  }

  _lerpHex(a, b, t) {
    const ax = parseInt(a.slice(1, 3), 16);
    const ay = parseInt(a.slice(3, 5), 16);
    const az = parseInt(a.slice(5, 7), 16);
    const bx = parseInt(b.slice(1, 3), 16);
    const by = parseInt(b.slice(3, 5), 16);
    const bz = parseInt(b.slice(5, 7), 16);
    const r = Math.round(ax + (bx - ax) * t);
    const g = Math.round(ay + (by - ay) * t);
    const bl = Math.round(az + (bz - az) * t);
    return `rgb(${r},${g},${bl})`;
  }

  _showTooltip(e, target) {
    if (this.hideTooltipTimer) clearTimeout(this.hideTooltipTimer);
    const type = target.dataset.selectType;
    const id = target.dataset.selectId;
    const obj = this._lookup(type, id);
    if (!obj) return;
    const detail = obj.dcr ? `D/C: ${Number(obj.dcr).toFixed(2)}` : obj.size || "";
    this.tooltip.innerHTML = `<strong>${obj.id || obj.label}</strong>${detail ? `<span>${detail}</span>` : ""}`;
    const rect = this.host.getBoundingClientRect();
    this.tooltip.style.left = `${e.clientX - rect.left}px`;
    this.tooltip.style.top = `${e.clientY - rect.top}px`;
    this.tooltip.style.display = "grid";
  }

  _hideTooltip() {
    this.hideTooltipTimer = setTimeout(() => {
      if (this.tooltip) this.tooltip.style.display = "none";
    }, 60);
  }

  _lookup(type, id) {
    const sources = {
      column: columns,
      beam: beams,
      shearWall: shearWalls,
      brace: braces,
      core: cores,
      noColumnZone: noColumnZones,
      grid: gridLines,
    };
    return (sources[type] || []).find((o) => o.id === id);
  }
}
