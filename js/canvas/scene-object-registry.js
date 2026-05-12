/**
 * Central scene-object registry.
 *
 * Every renderable element registers itself here when the builder creates
 * it. Page-mode tweens, raycasting, selection, D/C overlays, and disposal
 * all read from this single map rather than walking the scene graph or
 * holding scattered references.
 *
 * The registry is a *lookup index*, not the owner. Disposing a mesh is
 * the registry's job (so geometries/materials don't leak), but adding a
 * mesh to the scene graph is the builder's job.
 */

export class SceneObjectRegistry {
  constructor() {
    /** @type {Map<string, THREE.Object3D>}  id → primary mesh */
    this.objectsById = new Map();
    /** @type {Map<string, THREE.Object3D[]>} type → meshes */
    this.objectsByType = new Map();
    /** @type {Map<string, THREE.Object3D[]>} layerType → meshes */
    this.objectsByLayer = new Map();
    /** @type {Map<string, THREE.Object3D[]>} levelId → meshes (single-level only) */
    this.objectsByLevel = new Map();
    /** @type {Map<string, {color:number, opacity:number}>} id → original style */
    this.originalStyles = new Map();
    /** @type {Set<THREE.Material>} every material created via factories */
    this.materials = new Set();
    /** @type {Set<THREE.BufferGeometry>} every geometry created */
    this.geometries = new Set();
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a top-level renderable (slab, column, core, etc.). Walks
   * children automatically so edge outlines / sub-elements get indexed
   * by their own `userData.layerType`.
   */
  register(object) {
    this._indexOne(object);
    object.traverse?.((child) => {
      if (child !== object) this._indexOne(child);
    });
  }

  _indexOne(object) {
    const ud = object.userData || {};
    const { id, type, layerType, levelId } = ud;

    if (id && type) {
      // First registration wins as the "primary" mesh for the id; later
      // children (edge outlines etc.) keep being indexed by layer/type.
      if (!this.objectsById.has(id)) {
        this.objectsById.set(id, object);
        if (object.material?.color != null) {
          const baseOpacity = object.material.opacity ?? 1;
          this.originalStyles.set(id, {
            color: object.material.color.getHex(),
            opacity: baseOpacity,
          });
        }
      }
    }
    if (type) this._push(this.objectsByType, type, object);
    if (layerType) this._push(this.objectsByLayer, layerType, object);
    if (levelId) this._push(this.objectsByLevel, levelId, object);

    if (object.material) this.materials.add(object.material);
    if (object.geometry) this.geometries.add(object.geometry);
  }

  _push(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  getById(id) { return this.objectsById.get(id) ?? null; }

  getByType(type) { return this.objectsByType.get(type) ?? []; }

  getByLayer(layerType) { return this.objectsByLayer.get(layerType) ?? []; }

  getByLevel(levelId) { return this.objectsByLevel.get(levelId) ?? []; }

  /** All registered top-level meshes that have an id. */
  allWithId() {
    return Array.from(this.objectsById.values());
  }

  /** All meshes that should be raycaster-pickable. */
  selectables() {
    const out = [];
    this.objectsById.forEach((mesh) => {
      if (mesh.userData?.selectable !== false && mesh.visible !== false) {
        out.push(mesh);
      }
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Original-style bookkeeping (used by D/C overlay and selection dim)
  // -------------------------------------------------------------------------

  recordOriginalStyle(id, color, opacity) {
    if (!this.originalStyles.has(id)) {
      this.originalStyles.set(id, { color, opacity });
    }
  }

  originalStyleFor(id) {
    return this.originalStyles.get(id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Stats / disposal
  // -------------------------------------------------------------------------

  stats() {
    const countLayer = (k) => (this.objectsByLayer.get(k)?.length ?? 0);
    return {
      total: this.objectsById.size,
      slabs: countLayer("slab"),
      columns: countLayer("column"),
      beams: countLayer("beam"),
      shearWalls: countLayer("wall"),
      cores: countLayer("core"),
      grids: countLayer("grid"),
      noColumnZones: countLayer("noColumnZone"),
      openings: countLayer("opening"),
      loadArrows: countLayer("load"),
      tributary: countLayer("tributary"),
    };
  }

  /**
   * Dispose every registered geometry + material and clear all maps.
   * Caller is responsible for removing meshes from the scene graph
   * before/after this call.
   */
  disposeAll() {
    this.geometries.forEach((g) => { try { g.dispose(); } catch (_) {} });
    this.materials.forEach((m) => { try { m.dispose(); } catch (_) {} });
    this.objectsById.clear();
    this.objectsByType.clear();
    this.objectsByLayer.clear();
    this.objectsByLevel.clear();
    this.originalStyles.clear();
    this.materials.clear();
    this.geometries.clear();
  }
}
