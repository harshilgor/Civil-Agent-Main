/**
 * StructuralModelBuilder — owns the structural scene graph.
 *
 * Inputs (always go through adapters):
 *   * Normalized geometry from `adaptParsedGeometry()`.
 *   * Scheme bundle from `getSchemeBundle()`.
 *
 * Outputs (registered + added to scene):
 *   rootGroup
 *   ├── contextLayer       (ground plane, building bounds aid)
 *   ├── geometryLayer      (slabs, slab edges, grids, cores, openings, NCZ)
 *   ├── structuralLayer    (columns, beams, shear walls, braces)
 *   ├── overlayLayer       (load arrows, tributary, warning markers)
 *   └── selectionLayer     (transient outline clones)
 *
 * Lifecycle:
 *   buildFromParsedGeometry() → clearAll() → build geometryLayer + context
 *   rebuildScheme()          → drops structuralLayer children, rebuilds
 *   dispose()                → frees every geometry/material via registry
 */

import * as THREE from "three";

import { adaptParsedGeometry, GeometryAdapterError } from "./parsed-geometry-adapter.js";
import { SceneObjectRegistry } from "./scene-object-registry.js";
import { BASE_MATERIALS, PALETTE } from "./material-registry.js";

import {
  buildFloorPlatePolygon,
  buildCorePolygon,
  buildNoColumnZonePolygon,
  buildOpeningPolygon,
  buildExistingColumn,
  buildSchemeColumn,
  buildSchemeBeam,
  buildSchemeShearWall,
  buildGridLinesPolygon,
} from "./structural-objects.js";

export class StructuralModelBuilder {
  constructor(scene) {
    this.scene = scene;
    this.registry = new SceneObjectRegistry();

    this.rootGroup = new THREE.Group();
    this.rootGroup.name = "civilagent:root";

    this.contextLayer    = makeLayer("context");
    this.geometryLayer   = makeLayer("geometry");
    this.structuralLayer = makeLayer("structural");
    this.overlayLayer    = makeLayer("overlay");
    this.selectionLayer  = makeLayer("selection");

    this.rootGroup.add(this.contextLayer);
    this.rootGroup.add(this.geometryLayer);
    this.rootGroup.add(this.structuralLayer);
    this.rootGroup.add(this.overlayLayer);
    this.rootGroup.add(this.selectionLayer);

    this.scene.add(this.rootGroup);

    /** @type {import('./parsed-geometry-adapter.js').NormalizedGeometry|null} */
    this.geometry = null;

    this._activeLevelId = "all";
    /** @type {number|null} center used by camera presets (avg of bounds). */
    this.modelCenter = new THREE.Vector3();
  }

  // ──────────────────────────────────────────────────────────
  // Geometry build
  // ──────────────────────────────────────────────────────────

  /**
   * Full rebuild from raw ParsedGeometry. Always wipes the previous
   * scene first so re-uploading an IFC (or switching projects) cannot
   * stack new meshes on top of the old set.
   *
   * Throws GeometryAdapterError on critical failures so the caller can
   * surface a "could not render" UI.
   */
  buildFromParsedGeometry(rawGeometry) {
    const normalized = adaptParsedGeometry(rawGeometry);

    // Adapter ran successfully — safe to drop the previous scene.
    this.clearAll();
    this.geometry = normalized;

    this._buildContext(normalized);
    this._buildGeometryLayer(normalized);

    const { minX, maxX, minZ, maxZ } = normalized.buildingBounds;
    this.modelCenter.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);

    return normalized;
  }

  /**
   * Replace columns/beams/shear walls/braces with a fresh scheme bundle.
   * `geometry` must already be set via {@link buildFromParsedGeometry}.
   */
  rebuildScheme(scheme) {
    if (!this.geometry) {
      throw new Error("rebuildScheme called before buildFromParsedGeometry.");
    }
    this._clearLayer(this.structuralLayer);
    this._buildStructuralLayer(scheme);
  }

  clearAll() {
    this._clearLayer(this.geometryLayer);
    this._clearLayer(this.structuralLayer);
    this._clearLayer(this.overlayLayer);
    this._clearLayer(this.selectionLayer);
    this._clearLayer(this.contextLayer);
    this.registry.disposeAll();
    this.geometry = null;
  }

  dispose() {
    this.clearAll();
    if (this.scene && this.rootGroup.parent === this.scene) {
      this.scene.remove(this.rootGroup);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Layer builders
  // ──────────────────────────────────────────────────────────

  _buildContext(geom) {
    const { buildingBounds } = geom;
    const w = buildingBounds.maxX - buildingBounds.minX;
    const d = buildingBounds.maxZ - buildingBounds.minZ;
    const cx = (buildingBounds.minX + buildingBounds.maxX) / 2;
    const cz = (buildingBounds.minZ + buildingBounds.maxZ) / 2;

    // Wide subtle ground plane so the building doesn't float in void.
    const planeSize = Math.max(w, d) * 4 + 200;
    const groundGeo = new THREE.PlaneGeometry(planeSize, planeSize);
    const groundMat = BASE_MATERIALS.groundPlane();
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.5, cz);
    ground.userData = {
      type: "ground", id: "ground-plane", layerType: "ground",
      baseOpacity: 0.55, selectable: false,
    };
    this.contextLayer.add(ground);
    this.registry.register(ground);

    // Subtle GridHelper inside the building bounds for spatial reference.
    const gridSize = Math.max(w, d) * 1.6;
    const gridDiv = Math.max(8, Math.round(gridSize / 10));
    const gridHelper = new THREE.GridHelper(gridSize, gridDiv, 0x1f2937, 0x111827);
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.35;
    gridHelper.position.set(cx, -0.45, cz);
    gridHelper.userData = {
      type: "ground-grid", id: "ground-grid", layerType: "ground",
      baseOpacity: 0.35, selectable: false,
    };
    this.contextLayer.add(gridHelper);
    this.registry.register(gridHelper);
  }

  _buildGeometryLayer(geom) {
    // Floor plates per level
    for (const level of geom.levels) {
      if (!level.planBoundary) continue;
      const built = buildFloorPlatePolygon(level);
      if (!built) continue;
      this.geometryLayer.add(built.mesh);
      if (built.edge) this.geometryLayer.add(built.edge);
      this.registry.register(built.mesh);
      this.registry.register(built.edge);
    }

    // Cores
    for (const core of geom.cores) {
      const built = buildCorePolygon(core, geom.levels);
      if (!built) continue;
      this.geometryLayer.add(built.mesh);
      built.edges.forEach((e) => {
        this.geometryLayer.add(e);
        this.registry.register(e);
      });
      this.registry.register(built.mesh);
    }

    // No-column zones — draw at every level the zone applies to. If the
    // zone has no levelIds, fall back to L1 only (matches mock behavior).
    for (const zone of geom.noColumnZones) {
      const targetLevelIds = zone.levelIds && zone.levelIds.length
        ? zone.levelIds
        : [geom.levels[0].id];
      for (const lvlId of targetLevelIds) {
        const lvl = geom.levelById.get(lvlId);
        if (!lvl) continue;
        const built = buildNoColumnZonePolygon(zone, lvl);
        if (!built) continue;
        this.geometryLayer.add(built.mesh);
        this.geometryLayer.add(built.outline);
        this.registry.register(built.mesh);
        this.registry.register(built.outline);
      }
    }

    // Openings
    for (const opening of geom.openings) {
      const lvl = geom.levelById.get(opening.levelId);
      if (!lvl) continue;
      const built = buildOpeningPolygon(opening, lvl);
      if (!built) continue;
      this.geometryLayer.add(built.mesh);
      this.geometryLayer.add(built.outline);
      this.registry.register(built.mesh);
      this.registry.register(built.outline);
    }

    // Grid lines
    const grids = buildGridLinesPolygon(geom.gridLines, geom.buildingBounds);
    this.geometryLayer.add(grids);
    grids.children.forEach((line) => this.registry.register(line));

    // Existing columns (from ParsedGeometry — context, not scheme)
    for (const col of geom.existingColumns) {
      const mesh = buildExistingColumn(col, geom.levelById);
      if (!mesh) continue;
      mesh.userData.layerType = "column";
      this.structuralLayer.add(mesh);
      this.registry.register(mesh);
    }
  }

  _buildStructuralLayer(scheme) {
    if (!this.geometry) return;
    const { levels, levelById } = this.geometry;

    for (const col of scheme.columns ?? []) {
      const mesh = buildSchemeColumn(col, levelById);
      if (!mesh) continue;
      this.structuralLayer.add(mesh);
      this.registry.register(mesh);
    }
    for (const beam of scheme.beams ?? []) {
      const mesh = buildSchemeBeam(beam, levelById);
      if (!mesh) continue;
      this.structuralLayer.add(mesh);
      this.registry.register(mesh);
    }
    for (const wall of scheme.shearWalls ?? []) {
      const built = buildSchemeShearWall(wall, levels);
      if (!built) continue;
      this.structuralLayer.add(built.mesh);
      this.structuralLayer.add(built.edges);
      this.registry.register(built.mesh);
      this.registry.register(built.edges);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Active level filtering
  // ──────────────────────────────────────────────────────────

  setActiveLevel(levelId) {
    this._activeLevelId = levelId ?? "all";
    const all = this._activeLevelId === "all";

    // Anything tagged with a single-level userData.levelId gets ghosted
    // when not on the active level. Multi-level objects (cores, walls,
    // existing columns) have levelId === null and stay visible.
    this.registry.allWithId().forEach((mesh) => {
      const ud = mesh.userData;
      if (!ud?.levelId) return;
      const onActive = all || ud.levelId === this._activeLevelId;
      const factor = onActive ? 1.0 : 0.15;
      mesh.userData.__levelFactor = factor;
    });
  }

  getActiveLevel() {
    return this._activeLevelId;
  }

  // ──────────────────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────────────────

  getSceneStats() {
    const stats = this.registry.stats();
    stats.warnings = this.geometry?.metadata?.adapterWarnings?.length ?? 0;
    return stats;
  }

  // ──────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────

  _clearLayer(layer) {
    while (layer.children.length) {
      layer.remove(layer.children[0]);
    }
  }

  /** Convenience exception re-export for callers. */
  static get GeometryAdapterError() {
    return GeometryAdapterError;
  }
}

function makeLayer(name) {
  const g = new THREE.Group();
  g.name = `civilagent:${name}`;
  return g;
}

// Soft import (silences unused-warning if PALETTE import is not referenced).
void PALETTE;
