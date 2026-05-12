/**
 * Placement interaction layer.
 *
 * Handles:
 *   - Tool mode click capture on the canvas frame (above SVG / Three).
 *   - Screen → world point mapping for both 2D and 3D.
 *   - Grid snapping.
 *   - Adding manual columns / shear walls / beams.
 *   - Selecting placement elements (column / beam / shear wall).
 *   - Cancelling tools (Escape).
 *
 * The class subscribes to placement state changes and shows a transient
 * helper ribbon at the top of the canvas frame describing what the
 * user should do next.
 */

import * as THREE from "three";
import { state, set } from "../state.js";
import {
  snapToNearestGridIntersection,
  snapToNearestGridLine,
  findNearestColumn,
  isInsideNoColumnZone,
} from "./placement-engine.js";
import { toast } from "../components/toast.js";

const HELPER_TEXT = {
  "add-column": "Click a grid point to place a locked column.",
  "add-shear-wall": "Click first point, then second point to place a locked shear wall.",
  "add-beam": "Click two existing columns to place a locked beam.",
  delete: "Click a manual element to remove it.",
};

const MIN_WALL_LENGTH_FT = 6;

export class PlacementInteractions {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.frame   .canvas-frame container
   * @param {SVGSVGElement} deps.svg
   * @param {object} deps.threeCtx     { scene, camera, requestRender }
   * @param {object} deps.threeRenderer instance of PlacementThreeRenderer
   * @param {() => object} deps.getGrid getter for the active grid
   * @param {() => object} deps.getActiveStrategy getter for active strategy snapshot
   * @param {(point: {x:number,y:number}) => void} deps.placeColumn
   * @param {(start, end) => void} deps.placeWall
   * @param {(startId, endId) => void} deps.placeBeam
   * @param {(elementId) => void} deps.selectElement
   * @param {(elementId) => void} deps.deleteManualElement
   */
  constructor(deps) {
    this.deps = deps;
    this.frame = deps.frame;
    this.svg = deps.svg;
    this.threeCtx = deps.threeCtx;
    this.threeRenderer = deps.threeRenderer;
    this._listeners = [];
    this._helper = null;
    this._cleanup = null;
    this._mounted = false;
  }

  mount() {
    if (this._mounted) return;
    this._mounted = true;
    this._buildHelper();
    this._wireSvg();
    this._wireThree();
    this._wireKeyboard();
  }

  unmount() {
    if (!this._mounted) return;
    this._mounted = false;
    this._removeHelper();
    for (const off of this._listeners) {
      try { off(); } catch { /* ignore */ }
    }
    this._listeners = [];
  }

  // ─── Helper banner at the top of the canvas frame ────────────────

  _buildHelper() {
    const el = document.createElement("div");
    el.className = "placement-helper";
    el.hidden = true;
    el.innerHTML = `
      <span class="placement-helper-dot"></span>
      <span class="placement-helper-text"></span>
      <button class="placement-helper-cancel" type="button">Cancel</button>
    `;
    this.frame.appendChild(el);
    this._helper = el;
    el.querySelector(".placement-helper-cancel").addEventListener("click", () => {
      this._cancelTool();
    });
    this.refreshHelper();
  }

  _removeHelper() {
    if (this._helper && this._helper.parentNode) {
      this._helper.parentNode.removeChild(this._helper);
    }
    this._helper = null;
  }

  refreshHelper() {
    if (!this._helper) return;
    const tool = state.placement.activeTool;
    const text = HELPER_TEXT[tool];
    if (!text) {
      this._helper.hidden = true;
      this.frame.classList.remove("placement-tool-active");
      return;
    }
    this._helper.hidden = false;
    this.frame.classList.add("placement-tool-active");
    this._helper.querySelector(".placement-helper-text").textContent =
      tool === "add-shear-wall" && state.placement.pendingPoint
        ? "Click second point to finish wall (Esc to cancel)."
        : text;
  }

  _cancelTool() {
    set("placement.activeTool", null);
    set("placement.pendingPoint", null);
  }

  // ─── SVG (2D) handling ────────────────────────────────────────────

  _wireSvg() {
    if (!this.svg) return;

    const onClick = (e) => {
      const tool = state.placement.activeTool;
      // Element selection (idle mode)
      if (!tool) {
        const target = e.target.closest(
          "[data-placement-type]",
        );
        if (target) {
          this.deps.selectElement(target.dataset.placementId);
          e.stopPropagation();
        }
        return;
      }

      const point = this._svgEventToWorld(e);
      if (!point) return;

      this._handleToolClick(point, e);
      e.stopPropagation();
    };

    this.svg.addEventListener("click", onClick, true);
    this._listeners.push(() => this.svg.removeEventListener("click", onClick, true));
  }

  _svgEventToWorld(event) {
    const pt = this.svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return null;
    const inv = ctm.inverse();
    const out = pt.matrixTransform(inv);
    return { x: out.x, y: out.y };
  }

  // ─── Three.js (3D) handling ──────────────────────────────────────

  _wireThree() {
    if (!this.threeCtx?.camera) return;
    const dom = this.threeCtx.scene && this._findThreeCanvas();
    if (!dom) return;

    const onClick = (e) => {
      const tool = state.placement.activeTool;
      if (!tool) {
        // Element selection via raycast
        const ndc = this._eventToNdc(e, dom);
        const hit = this.threeRenderer?.raycast(ndc, this.threeCtx.camera);
        if (hit) {
          this.deps.selectElement(hit.id);
          e.stopPropagation();
        }
        return;
      }

      const point = this._threeEventToWorld(e, dom);
      if (!point) return;

      // For the add-beam tool we want the column under the cursor first.
      if (tool === "add-beam" || tool === "delete") {
        const ndc = this._eventToNdc(e, dom);
        const hit = this.threeRenderer?.raycast(ndc, this.threeCtx.camera);
        this._handleToolClick(point, e, hit);
        e.stopPropagation();
        return;
      }

      this._handleToolClick(point, e);
      e.stopPropagation();
    };

    dom.addEventListener("click", onClick, true);
    this._listeners.push(() => dom.removeEventListener("click", onClick, true));
  }

  _findThreeCanvas() {
    return this.frame.querySelector(".three-host canvas");
  }

  _eventToNdc(event, dom) {
    const rect = dom.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Project click onto the y=0 ground plane and return plan-frame (x, y). */
  _threeEventToWorld(event, dom) {
    const ndc = this._eventToNdc(event, dom);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.threeCtx.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, y: hit.z }; // world Z → plan-frame Y
  }

  // ─── Tool dispatch ───────────────────────────────────────────────

  _handleToolClick(rawPoint, event, raycastHit) {
    const tool = state.placement.activeTool;
    const grid = this.deps.getGrid();
    if (!grid) return;

    if (tool === "add-column") {
      const snapped = snapToNearestGridIntersection(grid, rawPoint);
      if (isInsideNoColumnZone(grid, snapped)) {
        toast("That point is inside a no-column zone.", { tone: "warn" });
        return;
      }
      this.deps.placeColumn(snapped);
      // Stay in tool mode for rapid placement; Esc/Cancel exits.
      return;
    }

    if (tool === "add-shear-wall") {
      const snapped = snapToNearestGridLine(grid, rawPoint);
      const pending = state.placement.pendingPoint;
      if (!pending) {
        set("placement.pendingPoint", snapped);
        this.refreshHelper();
        return;
      }
      const length = Math.hypot(snapped.x - pending.x, snapped.y - pending.y);
      if (length < MIN_WALL_LENGTH_FT) {
        toast("Shear wall is too short.", { tone: "warn" });
        return;
      }
      this.deps.placeWall(pending, snapped);
      set("placement.pendingPoint", null);
      this.refreshHelper();
      return;
    }

    if (tool === "add-beam") {
      const cols = this.deps.getActiveStrategy()?.elements?.columns || [];
      // Prefer raycast hit (3D), fall back to nearest-column lookup (2D).
      let col = null;
      if (raycastHit?.type === "column") {
        col = cols.find((c) => c.id === raycastHit.id) || null;
      }
      if (!col) col = findNearestColumn(cols, rawPoint, 8);
      if (!col) {
        toast("Select two columns to place a beam.", { tone: "warn" });
        return;
      }
      const pending = state.placement.pendingPoint;
      if (!pending || !pending.id) {
        set("placement.pendingPoint", { id: col.id, x: col.x, y: col.y });
        this.refreshHelper();
        return;
      }
      if (pending.id === col.id) return;
      this.deps.placeBeam(pending.id, col.id);
      set("placement.pendingPoint", null);
      this.refreshHelper();
      return;
    }

    if (tool === "delete") {
      // Find the nearest manual element of any type
      const manuals = [
        ...state.placement.manualOverrides.columns,
        ...state.placement.manualOverrides.shearWalls,
        ...state.placement.manualOverrides.beams,
      ];
      let bestId = null;
      let bestDist = Infinity;
      const px = rawPoint.x, py = rawPoint.y;
      for (const m of manuals) {
        let mx = 0, my = 0;
        if (m.type === "column") { mx = m.x; my = m.y; }
        else if (m.type === "shearWall") { mx = (m.x1 + m.x2) / 2; my = (m.y1 + m.y2) / 2; }
        else if (m.type === "beam") { mx = (m.x1 + m.x2) / 2; my = (m.y1 + m.y2) / 2; }
        const d = Math.hypot(px - mx, py - my);
        if (d < bestDist) { bestDist = d; bestId = m.id; }
      }
      if (!bestId || bestDist > 12) {
        toast("Click closer to a manual element to delete it.", { tone: "warn" });
        return;
      }
      this.deps.deleteManualElement(bestId);
      return;
    }
  }

  _wireKeyboard() {
    const onKey = (e) => {
      if (e.key === "Escape" && state.placement.activeTool) {
        e.preventDefault();
        this._cancelTool();
      }
    };
    document.addEventListener("keydown", onKey);
    this._listeners.push(() => document.removeEventListener("keydown", onKey));
  }
}
