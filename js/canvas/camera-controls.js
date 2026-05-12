/**
 * Camera presets and smooth transitions for the Three.js viewport.
 *
 * Two cameras are kept around: an OrthographicCamera (default for engineering
 * clarity) and a PerspectiveCamera (for the 3D angled view). Switching
 * presets just swaps which camera is bound to OrbitControls.
 */

import * as THREE from "three";

export class CameraPresetManager {
  constructor(viewport) {
    this.viewport = viewport;
  }

  /**
   * Smoothly move the active camera to the given preset.
   * @param {'iso-3d'|'top-down'|'section'|'fit-all'} preset
   */
  apply(preset) {
    const v = this.viewport;
    if (!v.perspCamera || !v.orthoCamera) return;
    switch (preset) {
      case "iso-3d":
        v.useCamera("persp");
        this._tween(v.perspCamera, new THREE.Vector3(v.target.x + 180, 130, v.target.z + 180), v.target);
        break;
      case "iso-tilted":
        // Slightly higher angle so vertical load flow reads better
        v.useCamera("persp");
        this._tween(v.perspCamera, new THREE.Vector3(v.target.x + 150, 200, v.target.z + 150), v.target);
        break;
      case "top-down":
        v.useCamera("ortho");
        this._tween(v.orthoCamera, new THREE.Vector3(v.target.x, 320, v.target.z + 0.001), v.target);
        break;
      case "section":
        v.useCamera("ortho");
        this._tween(v.orthoCamera, new THREE.Vector3(v.target.x - 280, 70, v.target.z), v.target);
        break;
      case "fit-all":
        this._fit();
        break;
      default:
    }
  }

  _tween(camera, position, lookAt, duration = 500) {
    const start = camera.position.clone();
    const end = position.clone();
    const startTime = performance.now();

    const animate = () => {
      // Viewport may have been unmounted (page change) while tween is in-flight;
      // its renderer/controls are nulled in that case — abort silently.
      if (!this.viewport || !this.viewport.renderer) return;
      const t = Math.min((performance.now() - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out
      camera.position.lerpVectors(start, end, eased);
      camera.lookAt(lookAt);
      if (t < 1) {
        requestAnimationFrame(animate);
      } else if (this.viewport.controls) {
        this.viewport.controls.target.copy(lookAt);
      }
    };
    animate();
  }

  _fit() {
    const box = new THREE.Box3();
    const v = this.viewport;

    // Include the source model group if it is visible and non-empty.
    if (v.sourceModelGroup?.visible) {
      const smBox = new THREE.Box3().setFromObject(v.sourceModelGroup);
      if (!smBox.isEmpty()) box.union(smBox);
    }

    // Include Civil Agent structural + scheme geometry (existing behaviour,
    // scoped to meshes tagged with userData.type so helpers are excluded).
    if (v.structuralGroup?.visible) {
      v.structuralGroup.traverse((o) => {
        if (o.isMesh && o.userData?.type) box.expandByObject(o);
      });
    } else {
      // Fallback: scan the full scene as before (handles processing preview).
      v.scene.traverse((o) => {
        if (o.isMesh && o.userData?.type) box.expandByObject(o);
      });
    }

    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 1.4;
    this._tween(
      v.activeCamera,
      new THREE.Vector3(center.x + distance, center.y + distance, center.z + distance),
      center,
    );
    v.target.copy(center);
  }
}
