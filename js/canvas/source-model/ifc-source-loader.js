/**
 * IfcSourceLoader — That Open IfcLoader + FragmentsManager integration.
 *
 * Responsibilities:
 *   • Initialise OBC.Components with IfcLoader + FragmentsManager.
 *   • Accept an IFC ArrayBuffer, convert it to Fragments, and add the
 *     resulting Three.js model.object to the caller-supplied
 *     `sourceModelGroup`.
 *   • Apply the ParsedGeometry originTransform so the source model
 *     lines up with Civil Agent's structural overlay (which is already
 *     in the rebased local coordinate frame).
 *   • Report progress and status back via callbacks.
 *   • Dispose cleanly on unmount.
 *
 * Architecture notes:
 *   • We do NOT create a separate That Open World/renderer/camera.
 *     Instead we plug the converted Fragment model.object straight into
 *     the existing ThreeCanvas scene (inside sourceModelGroup) and let
 *     ThreeCanvas's own renderer, camera, and OrbitControls drive it.
 *   • That Open's FragmentsManager only needs `model.useCamera(camera)`
 *     and periodic `fragments.core.update()` calls, which we wire into
 *     ThreeCanvas's existing OrbitControls "change" event.
 *
 * Coordinate alignment:
 *   IFC world frame  →  Civil Agent local frame
 *     local.x = world.x - originTransform.tx
 *     local.z = world.y - originTransform.ty   (api.y maps to Three.z)
 *
 *   The That Open model comes in the IFC world frame, so we shift the
 *   sourceModelGroup by (-tx, 0, -ty) to align with the structural layer.
 *   A unit-scale note: IfcOpenShell typically returns metres for metric
 *   IFC files; Civil Agent's ParsedGeometry is labelled "ft" but the raw
 *   placement values from IfcOpenShell are whatever unit the IFC file uses.
 *   If you see a scale mismatch in the console alignment log, set
 *   sourceModelGroup.scale.setScalar(3.28084) (m→ft) or vice-versa.
 *
 * WASM / worker sourcing:
 *   The web-ifc JS wrapper is loaded via the import map (see index.html)
 *   and the matching .wasm files are fetched from the same version on
 *   jsdelivr at runtime.  Both halves MUST be the same version — if they
 *   drift, the JS wrapper's runtime assertion fails with the message
 *   "not compiled for this environment".
 *
 *   A future optimisation is to save the converted .frag and load that
 *   instead of reconverting on every session.
 */

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Must match the web-ifc version pinned in index.html's importmap.  jsdelivr
// is preferred over unpkg here because it returns immutable cache headers
// and has consistent application/wasm Content-Type for .wasm files.
const WEB_IFC_VERSION = "0.0.77";
const WASM_PATH = `https://cdn.jsdelivr.net/npm/web-ifc@${WEB_IFC_VERSION}/`;

// ---------------------------------------------------------------------------
// IfcSourceLoader
// ---------------------------------------------------------------------------

export class IfcSourceLoader {
  /**
   * @param {object} opts
   * @param {THREE.Scene}            opts.scene
   * @param {THREE.Camera}           opts.camera
   * @param {import("three/addons/controls/OrbitControls.js").OrbitControls} opts.controls
   * @param {THREE.Group}            opts.sourceModelGroup  - where model.object is added
   * @param {(progress:number)=>void} [opts.onProgress]     - 0..1
   * @param {(info:object)=>void}    [opts.onLoaded]
   * @param {(err:Error)=>void}      [opts.onError]
   * @param {(status:string)=>void}  [opts.onStatus]        - 'idle'|'loading'|'loaded'|'error'
   */
  constructor({ scene, camera, controls, sourceModelGroup, onProgress, onLoaded, onError, onStatus }) {
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.sourceModelGroup = sourceModelGroup;
    this.onProgress = onProgress;
    this.onLoaded = onLoaded;
    this.onError = onError;
    this.onStatus = onStatus;

    this._components = null;
    this._ifcLoader = null;
    this._fragments = null;
    this._controlsListener = null;
    this._ready = false;
    this._disposed = false;
    this._currentModelId = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Initialise OBC components, IfcLoader, and FragmentsManager.
   * Must be called once before `loadFromArrayBuffer`.
   */
  async init() {
    if (this._ready || this._disposed) return;
    this._setStatus("loading");

    // Dynamic import keeps a failing BIM library from blocking app startup.
    // We *do* propagate the failure to the caller (re-throw) so downstream
    // code (loadFromArrayBuffer) doesn't fire with a half-initialised
    // loader and emit a misleading "must be awaited" cascade error.
    let OBC;
    try {
      OBC = await import("@thatopen/components");
    } catch (importErr) {
      console.error("[CivilAgent] @thatopen/components failed to load:", importErr);
      this.onError?.(importErr);
      this._setStatus("error");
      throw importErr;
    }

    try {
      this._components = new OBC.Components();

      // ---- IfcLoader ------------------------------------------------
      this._ifcLoader = this._components.get(OBC.IfcLoader);
      await this._ifcLoader.setup({
        autoSetWasm: false,
        wasm: { path: WASM_PATH, absolute: true },
      });

      // ---- FragmentsManager -----------------------------------------
      const workerUrl = await OBC.FragmentsManager.getWorker();
      this._fragments = this._components.get(OBC.FragmentsManager);
      this._fragments.init(workerUrl);

      // When a Fragment model is ready, plug it into our scene group.
      this._fragments.list.onItemSet.add(({ value: model }) => {
        if (this._disposed) return;
        model.useCamera(this.camera);
        this.sourceModelGroup.add(model.object);
        this._fragments.core.update(true);

        console.group("[CivilAgent] Source Model Load");
        console.log("fragment model loaded:", model);
        console.log("source model object:", model.object);
        const bbox = new THREE.Box3().setFromObject(this.sourceModelGroup);
        console.log("sourceModelGroup bbox after add:", bbox);
        console.groupEnd();

        this.onLoaded?.({ model, object: model.object });
        this._setStatus("loaded");
      });

      // Reduce z-fighting between source and structural layers.
      this._fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
        if (!("isLodMaterial" in material && material.isLodMaterial)) {
          material.polygonOffset = true;
          material.polygonOffsetUnits = 1;
          material.polygonOffsetFactor = Math.random();
          // Apply ghost-like appearance so source model reads as reference context.
          material.transparent = true;
          material.opacity = 0.38;
        }
      });

      // Drive fragment LOD updates from the existing OrbitControls.
      this._controlsListener = () => {
        if (!this._disposed) this._fragments?.core?.update();
      };
      this.controls?.addEventListener?.("change", this._controlsListener);

      this._components.init();
      this._ready = true;
    } catch (err) {
      console.error("[CivilAgent] IfcSourceLoader.init failed:", err);
      this.onError?.(err);
      this._setStatus("error");
      // Re-throw so the caller sees the real init error rather than the
      // misleading "must be awaited" cascade from loadFromArrayBuffer.
      throw err;
    }
  }

  /**
   * Load an IFC file from an ArrayBuffer, convert it to Fragments, and
   * add the result to sourceModelGroup.
   *
   * @param {ArrayBuffer} arrayBuffer
   * @param {string}      [modelId="source-ifc-model"]
   * @param {object}      [originTransform] - { tx, ty } from ParsedGeometry metadata
   * @param {number}      [unitScale=1]     - multiply IFC coords by this to match structural
   */
  async loadFromArrayBuffer(arrayBuffer, modelId = "source-ifc-model", originTransform = {}, unitScale = 1) {
    if (!this._ready) {
      throw new Error("IfcSourceLoader.init() must be awaited before loadFromArrayBuffer.");
    }
    if (this._disposed) return;

    this._currentModelId = modelId;
    this._setStatus("loading");

    console.group("[CivilAgent] Source Model Load");
    console.log("IFC buffer byte length:", arrayBuffer.byteLength);
    console.log("modelId:", modelId);
    console.log("originTransform:", originTransform);
    console.log("unitScale:", unitScale);
    console.groupEnd();

    try {
      const buffer = new Uint8Array(arrayBuffer);
      await this._ifcLoader.load(buffer, false, modelId, {
        processData: {
          progressCallback: (progress) => {
            this.onProgress?.(progress);
          },
        },
      });

      // Apply coordinate alignment: scale the source model from IFC native units
      // to feet, then shift it by the inverse of the origin transform.
      //
      // The IFC model is loaded in the file's native units (typically mm for
      // architectural models).  The structural layer is in ft after the adapter
      // applies MM_TO_FT.  We need:
      //   group.scale  = unitScale (e.g. 0.00328084 for mm→ft)
      //   group.position = -centroid_in_ft  so the model is rebased to origin
      //
      // Note: group.position is in WORLD space (ft), while the group's children
      // are in LOCAL space (mm).  Three.js applies scale before position, so
      // "position = -scaledTx" correctly places the centroid at the world origin.
      const tx = originTransform.tx ?? 0;
      const ty = originTransform.ty ?? 0;
      const scaledTx = tx * unitScale;
      const scaledTy = ty * unitScale;
      this.sourceModelGroup.position.set(-scaledTx, 0, -scaledTy);
      this.sourceModelGroup.scale.setScalar(unitScale);

    } catch (err) {
      console.error("[CivilAgent] IfcSourceLoader.loadFromArrayBuffer failed:", err);
      this.onError?.(err);
      this._setStatus("error");
    }
  }

  /**
   * Remove all source model objects from the group and release resources.
   * Safe to call multiple times.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this._controlsListener && this.controls) {
      this.controls.removeEventListener("change", this._controlsListener);
      this._controlsListener = null;
    }

    // Remove all children from the group so the scene is clean.
    while (this.sourceModelGroup.children.length > 0) {
      this.sourceModelGroup.remove(this.sourceModelGroup.children[0]);
    }

    try {
      this._components?.dispose?.();
    } catch (_) { /* ignore */ }

    this._components = null;
    this._ifcLoader = null;
    this._fragments = null;
    this._ready = false;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _setStatus(status) {
    this.onStatus?.(status);
  }
}
