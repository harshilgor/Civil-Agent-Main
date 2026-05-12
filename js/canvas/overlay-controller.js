/**
 * Overlay controller — engineering data overlays drawn on top of the
 * structural model.
 *
 *   * applySizingColors(memberChecks)  — recolors columns/beams/walls
 *     by their demand/capacity ratio (`dcr`). Stores the original color
 *     in registry.originalStyles so `clearSizingColors()` is exact.
 *
 *   * applyLoadVisualization(loadData, tributary) — renders downward
 *     load arrows + translucent tributary polygons in `overlayLayer`.
 *     `clearLoadVisualization()` disposes them. Page-mode controller
 *     is responsible for fading these in/out via the `load` /
 *     `tributary` layer types.
 */

import * as THREE from "three";
import { dcrToColor } from "./material-registry.js";
import { buildLoadArrow, buildTributaryPolygon } from "./structural-objects.js";

export class OverlayController {
  /**
   * @param {SceneObjectRegistry} registry
   * @param {THREE.Group} overlayLayer
   * @param {() => void} onChange
   */
  constructor(registry, overlayLayer, onChange = () => {}) {
    this.registry = registry;
    this.overlayLayer = overlayLayer;
    this.onChange = onChange;
    this._sizingActive = false;
    this._loadObjects = [];
  }

  // -------------------------------------------------------------------------
  // Sizing (D/C)
  // -------------------------------------------------------------------------

  /**
   * Recolor structural members based on their D/C ratio.
   * @param {Array<{id:string, dcr:number}>} memberChecks
   */
  applySizingColors(memberChecks = []) {
    if (!Array.isArray(memberChecks)) return;

    this._sizingActive = true;
    for (const check of memberChecks) {
      const mesh = this.registry.getById(check.id);
      if (!mesh?.material?.color) continue;
      const original = this.registry.originalStyleFor(check.id);
      if (!original) {
        // First touch — record the current color/opacity so we can restore.
        this.registry.recordOriginalStyle(
          check.id,
          mesh.material.color.getHex(),
          mesh.material.opacity ?? 1,
        );
      }
      mesh.material.color.setHex(dcrToColor(check.dcr));
    }
    this.onChange();
  }

  clearSizingColors() {
    if (!this._sizingActive) return;
    this._sizingActive = false;

    this.registry.originalStyles.forEach((style, id) => {
      const mesh = this.registry.getById(id);
      if (!mesh?.material?.color) return;
      mesh.material.color.setHex(style.color);
    });
    this.onChange();
  }

  // -------------------------------------------------------------------------
  // Loads
  // -------------------------------------------------------------------------

  /**
   * Build load arrows + tributary polygons. Replaces any existing overlay.
   *
   * @param {object} payload
   * @param {Array<{x:number, z:number, levelId:string, magnitude:number}>} payload.arrows
   * @param {Array<{points:Array<[number, number]>, levelId:string, color:number}>} payload.tributary
   * @param {Map<string, object>} levelById
   */
  applyLoadVisualization(payload, levelById) {
    this.clearLoadVisualization();
    if (!payload || !levelById) return;

    for (const arrowData of payload.arrows ?? []) {
      const lvl = levelById.get(arrowData.levelId);
      if (!lvl) continue;
      const arrow = buildLoadArrow(arrowData.x, arrowData.z, lvl, arrowData.magnitude ?? 60);
      this.overlayLayer.add(arrow);
      this.registry.register(arrow);
      this._loadObjects.push(arrow);
    }

    for (const trib of payload.tributary ?? []) {
      const lvl = levelById.get(trib.levelId);
      if (!lvl) continue;
      const mesh = buildTributaryPolygon(trib.points, lvl, trib.color);
      this.overlayLayer.add(mesh);
      this.registry.register(mesh);
      this._loadObjects.push(mesh);
    }
    this.onChange();
  }

  clearLoadVisualization() {
    for (const obj of this._loadObjects) {
      this.overlayLayer.remove(obj);
      disposeObject(obj);
    }
    this._loadObjects = [];
    this.onChange();
  }

  dispose() {
    this.clearLoadVisualization();
  }
}

function disposeObject(obj) {
  obj.traverse?.((node) => {
    if (node.geometry) node.geometry.dispose();
    if (node.material) {
      if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
      else node.material.dispose();
    }
  });
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) obj.material.dispose();
}
