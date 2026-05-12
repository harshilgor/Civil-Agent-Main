/**
 * InteractionController — owns mouse → scene interaction.
 *
 *   * Hover: raycast on `pointermove`, throttle to every other frame.
 *     Slightly boosts the hovered mesh's opacity, emits a tooltip event.
 *   * Click: select the picked element. Updates the global state's
 *     `selectedObject` (the inspector panel reads it directly) and
 *     emits a `civilagent:element-selected` DOM event for future
 *     listeners. Also draws a blue wireframe outline in the dedicated
 *     `selectionLayer` group.
 *   * Empty click: clears selection (state + outline).
 *   * Double-click on a mesh: zoom-to-fit that mesh.
 *   * Double-click on empty space: zoom-to-fit the whole model.
 */

import * as THREE from "three";
import { state } from "../state.js";
import { BASE_MATERIALS } from "./material-registry.js";

const HOVER_OPACITY_BOOST = 0.15;

export class InteractionController {
  /**
   * @param {HTMLElement} domElement       canvas element to listen on
   * @param {THREE.Camera} camera          active camera (mutable per frame)
   * @param {SceneObjectRegistry} registry
   * @param {THREE.Group} selectionLayer   group to host outline clones
   * @param {object} hooks
   * @param {(elementId:string|null)=>void} [hooks.onZoomTo]
   * @param {(elementId:string|null)=>void} [hooks.onSelectionChange]
   *   Called whenever selection visuals need to be redrawn (e.g. so the
   *   page-mode controller can dim non-selected meshes). Receives the
   *   selected element id, or null.
   * @param {(payload:{mesh:THREE.Object3D, event:PointerEvent}|null)=>void} [hooks.onHoverChange]
   * @param {() => void} [hooks.onChange]    redraw signal
   */
  constructor(domElement, camera, registry, selectionLayer, hooks = {}) {
    this.domElement = domElement;
    this.camera = camera;
    this.registry = registry;
    this.selectionLayer = selectionLayer;
    this.hooks = hooks;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._hoverMesh = null;
    this._hoverPrevOpacity = null;
    this._selectedId = null;
    this._outline = null;

    this._frameTick = 0;
    this._pendingMove = null;

    this._onMove = this._onMove.bind(this);
    this._onLeave = this._onLeave.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onDblClick = this._onDblClick.bind(this);

    domElement.addEventListener("pointermove", this._onMove);
    domElement.addEventListener("pointerleave", this._onLeave);
    domElement.addEventListener("click", this._onClick);
    domElement.addEventListener("dblclick", this._onDblClick);
  }

  setCamera(camera) {
    this.camera = camera;
  }

  // -------------------------------------------------------------------------
  // External selection (driven by sidebar/inspector clicks too)
  // -------------------------------------------------------------------------

  selectElement(elementId) {
    this._clearOutline();
    this._selectedId = elementId ?? null;

    const mesh = elementId ? this.registry.getById(elementId) : null;
    if (mesh) this._drawOutline(mesh);

    // Tell the page-mode controller (or whoever wired the hook) that
    // selection changed; that's the single owner of dim-others opacity.
    this.hooks.onSelectionChange?.(this._selectedId);
    this.hooks.onChange?.();
  }

  clearSelection() {
    this.selectElement(null);
  }

  // -------------------------------------------------------------------------
  // Pointer pipeline
  // -------------------------------------------------------------------------

  _onMove(event) {
    // Throttle to every other frame to keep raycasting cheap.
    this._pendingMove = event;
    this._frameTick += 1;
    if (this._frameTick % 2 !== 0) return;
    this._processHover(event);
  }

  _processHover(event) {
    const hit = this._pickFromEvent(event);

    if (hit !== this._hoverMesh) {
      this._restoreHover();
      if (hit) {
        this._hoverMesh = hit;
        this._hoverPrevOpacity = hit.material?.opacity ?? null;
        if (hit.material) {
          hit.material.opacity = clamp01((this._hoverPrevOpacity ?? 1) + HOVER_OPACITY_BOOST);
        }
        this.domElement.style.cursor = "pointer";
      } else {
        this.domElement.style.cursor = "default";
      }
      this.hooks.onChange?.();
    }
    this.hooks.onHoverChange?.(hit ? { mesh: hit, event } : null);
  }

  _onLeave() {
    this._restoreHover();
    this.domElement.style.cursor = "default";
    this.hooks.onHoverChange?.(null);
    this.hooks.onChange?.();
  }

  _onClick(event) {
    const hit = this._pickFromEvent(event);
    if (hit) {
      const { type, id, data } = hit.userData;
      // PRIMARY integration: inspector panel reads state.selectedObject.
      // The viewport's own state subscription will call selectElement(id)
      // in response, so we don't need to call it directly here.
      state.selectedObject = { type, id };
      this.domElement.dispatchEvent(
        new CustomEvent("civilagent:element-selected", {
          bubbles: true,
          detail: { type, id, data },
        }),
      );
    } else {
      state.selectedObject = null;
      this.domElement.dispatchEvent(
        new CustomEvent("civilagent:element-deselected", { bubbles: true }),
      );
    }
  }

  _onDblClick(event) {
    const hit = this._pickFromEvent(event);
    this.hooks.onZoomTo?.(hit?.userData?.id ?? null);
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  _pickFromEvent(event) {
    if (!this.camera) return null;
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const targets = this.registry.selectables();
    if (!targets.length) return null;
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const obj = h.object;
      if (!obj.userData?.id || !obj.userData?.type) continue;
      if (!obj.visible) continue;
      const op = obj.material?.opacity ?? 1;
      if (op < 0.05) continue;
      return obj;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Hover/selection visuals
  // -------------------------------------------------------------------------

  _restoreHover() {
    if (this._hoverMesh && this._hoverPrevOpacity != null && this._hoverMesh.material) {
      this._hoverMesh.material.opacity = this._hoverPrevOpacity;
    }
    this._hoverMesh = null;
    this._hoverPrevOpacity = null;
  }

  _drawOutline(mesh) {
    // Edges-based outline scaled slightly above the mesh. Works for any
    // BufferGeometry (Box, Extrude, Shape) without per-shape branching.
    const edgesGeo = new THREE.EdgesGeometry(mesh.geometry);
    const outline = new THREE.LineSegments(edgesGeo, BASE_MATERIALS.selectionOutline());

    outline.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
    outline.quaternion.copy(mesh.getWorldQuaternion(new THREE.Quaternion()));
    outline.scale.copy(mesh.scale).multiplyScalar(1.03);
    outline.userData = { layerType: "selection-outline", baseOpacity: 0.95 };
    this.selectionLayer.add(outline);

    // Soft fill clone for a glow effect.
    const fillMat = BASE_MATERIALS.selectionFill();
    const fill = new THREE.Mesh(mesh.geometry, fillMat);
    fill.position.copy(outline.position);
    fill.quaternion.copy(outline.quaternion);
    fill.scale.copy(outline.scale);
    fill.userData = { layerType: "selection-outline", baseOpacity: 0.18 };
    this.selectionLayer.add(fill);

    this._outline = { outline, fill, geometry: edgesGeo, materials: [outline.material, fill.material] };
  }

  _clearOutline() {
    if (!this._outline) return;
    const { outline, fill, geometry, materials } = this._outline;
    this.selectionLayer.remove(outline);
    this.selectionLayer.remove(fill);
    geometry.dispose();
    materials.forEach((m) => m.dispose());
    this._outline = null;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  dispose() {
    this.domElement.removeEventListener("pointermove", this._onMove);
    this.domElement.removeEventListener("pointerleave", this._onLeave);
    this.domElement.removeEventListener("click", this._onClick);
    this.domElement.removeEventListener("dblclick", this._onDblClick);
    this._clearOutline();
    this._restoreHover();
  }
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
