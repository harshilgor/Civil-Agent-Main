/**
 * Grid-label manager — projects 3D world points to screen space and
 * positions HTML chips inside an overlay div above the WebGL canvas.
 *
 * Why HTML overlay (not CSS2DRenderer): the existing canvas already has
 * a working overlay div for tooltips and `data-canvas-overlay--*` chrome.
 * Adding another renderer doubles the resize/animation-loop bookkeeping
 * for negligible visual benefit at the zoom levels engineers actually
 * use. Section 16 explicitly marks CSS2DRenderer as stretch.
 */

import * as THREE from "three";

const LABEL_OFFSET_FT = 12;

export class LabelManager {
  constructor(host) {
    this.host = host;
    this.overlay = document.createElement("div");
    this.overlay.className = "three-grid-overlay";
    this.overlay.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;";
    this.host.appendChild(this.overlay);

    this._gridLines = [];
    this._bounds = null;
    this._tmp = new THREE.Vector3();
  }

  /** Update the source data; clears existing DOM and rebuilds chip pool. */
  setSource(gridLines, bounds) {
    this._gridLines = Array.isArray(gridLines) ? gridLines : [];
    this._bounds = bounds || null;
    this.overlay.innerHTML = "";
    this._chips = this._gridLines.flatMap((g) => [
      { g, end: "min" },
      { g, end: "max" },
    ]).map(({ g, end }) => {
      const el = document.createElement("div");
      el.className = "three-grid-label";
      el.dataset.axis = g.axis;
      el.dataset.end = end;
      el.textContent = g.label;
      this.overlay.appendChild(el);
      return { el, g, end };
    });
  }

  /** Re-project chip positions to screen space. */
  update(camera) {
    if (!camera || !this._bounds || !this._chips?.length) return;
    const rect = this.host.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (!w || !h) return;

    const { minX, maxX, minZ, maxZ } = this._bounds;

    for (const chip of this._chips) {
      const { el, g, end } = chip;
      if (g.axis === "x") {
        this._tmp.set(
          g.coordinate,
          0,
          end === "min" ? minZ - LABEL_OFFSET_FT : maxZ + LABEL_OFFSET_FT,
        );
      } else {
        this._tmp.set(
          end === "min" ? minX - LABEL_OFFSET_FT : maxX + LABEL_OFFSET_FT,
          0,
          g.coordinate,
        );
      }

      const projected = this._tmp.clone().project(camera);
      const onScreen = projected.z > -1 && projected.z < 1;
      if (!onScreen) {
        el.style.display = "none";
        continue;
      }
      const x = ((projected.x + 1) / 2) * w;
      const y = ((1 - projected.y) / 2) * h;
      el.style.display = "";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }

  setVisible(visible) {
    this.overlay.style.visibility = visible ? "" : "hidden";
  }

  dispose() {
    try { this.host.removeChild(this.overlay); } catch (_) {}
    this._chips = [];
    this._gridLines = [];
    this._bounds = null;
  }
}
