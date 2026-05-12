/**
 * Three.js renderer for the placement domain.
 *
 * Owns its own THREE.Group ("placement-layer") which is added to the
 * active ThreeCanvas scene when the user lands on the placement page,
 * and removed (with full disposal) when they leave.
 *
 * On activation we hide the existing scheme's columns/beams/shear walls
 * (registered via SceneObjectRegistry under layerType "column"/"beam"/
 * "wall"/"wall-edge") so the placement layer is the single source of
 * truth for those structural categories. Floor plates, grids, cores,
 * and no-column zones from the existing geometry layer stay visible —
 * they're our context.
 */

import * as THREE from "three";

const PALETTE = {
  generated: { column: 0x9aa6b5, beam: 0x6b7785, wall: 0xef6c4d, wallEdge: 0xff9277 },
  manual:    { column: 0x60a5fa, beam: 0x3b82f6, wall: 0xfb923c, wallEdge: 0xffd0a8 },
  selected:  0x22d3ee,
};

const BEAM_DEPTH_DEFAULT = 1.6; // ft
const COLUMN_BASE_SIZE = 1.2;   // ft

export class PlacementThreeRenderer {
  /**
   * @param {object} threeCtx { scene, camera, registry, structuralGroup, requestRender }
   */
  constructor(threeCtx) {
    this.ctx = threeCtx;
    this.group = new THREE.Group();
    this.group.name = "civilagent:placement";
    this.ctx.scene.add(this.group);

    /** @type {Map<string, THREE.Object3D>} placementId → primary mesh */
    this.byId = new Map();
    /** @type {Set<THREE.Material|THREE.BufferGeometry>} for disposal */
    this._disposables = new Set();

    this._hiddenExisting = []; // { mesh, prevVisible }
    this._selectedId = null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  activate() {
    this._hideExistingScheme(true);
  }

  deactivate() {
    this._hideExistingScheme(false);
    this.clear();
    if (this.group.parent) this.group.parent.remove(this.group);
  }

  _hideExistingScheme(hide) {
    if (!this.ctx.registry) return;
    // We zero baseOpacity (instead of just toggling visible) because the
    // PageModeController recomputes mesh.visible from opacity each time
    // the page changes; visible=false alone would be clobbered.
    if (hide) {
      this._hiddenExisting = [];
      const types = ["column", "beam", "wall", "wall-edge"];
      for (const t of types) {
        const meshes = this.ctx.registry.getByLayer(t) || [];
        for (const m of meshes) {
          const ud = m.userData || (m.userData = {});
          this._hiddenExisting.push({
            mesh: m,
            prevBaseOpacity: ud.baseOpacity,
            prevVisible: m.visible,
          });
          ud.baseOpacity = 0;
          m.visible = false;
          if (m.material) {
            m.material.transparent = true;
            m.material.opacity = 0;
          }
        }
      }
    } else {
      for (const r of this._hiddenExisting) {
        if (r.mesh.userData) r.mesh.userData.baseOpacity = r.prevBaseOpacity ?? 1;
        r.mesh.visible = r.prevVisible;
        if (r.mesh.material && r.prevBaseOpacity != null) {
          r.mesh.material.opacity = r.prevBaseOpacity;
        }
      }
      this._hiddenExisting = [];
      // Force page-mode-controller to recompute target opacities now that
      // baseOpacity has been restored — otherwise the meshes will stay at
      // opacity 0 (the value the controller computed while we were hiding).
      this.ctx.pageMode?.refresh();
    }
    this.ctx.requestRender?.();
  }

  // ─── Public draw API ──────────────────────────────────────────────

  /**
   * Replace the placement geometry with a fresh strategy.
   *
   * @param {object} strategy   strategy from placement-engine
   * @param {object} grid       grid from placement-engine (for height context)
   * @param {object} options    { selectedId? }
   */
  render(strategy, grid, options = {}) {
    this.clear();
    this._selectedId = options.selectedId || null;

    const buildingHeight = grid?.totalHeight || 78;

    for (const c of strategy.elements.columns) {
      this._addColumn(c, buildingHeight);
    }
    for (const w of strategy.elements.shearWalls) {
      this._addWall(w, buildingHeight);
    }
    for (const b of strategy.elements.beams) {
      this._addBeam(b);
    }
    this.ctx.requestRender?.();
  }

  setSelected(id) {
    if (this._selectedId === id) return;
    const prev = this._selectedId;
    this._selectedId = id;

    if (prev) this._restoreColor(prev);
    if (id) this._tintSelected(id);
    this.ctx.requestRender?.();
  }

  clear() {
    while (this.group.children.length) {
      const child = this.group.children[0];
      this.group.remove(child);
    }
    for (const d of this._disposables) {
      try { d.dispose?.(); } catch { /* ignore */ }
    }
    this._disposables.clear();
    this.byId.clear();
  }

  // ─── Element builders ─────────────────────────────────────────────

  _addColumn(c, buildingHeight) {
    const isManual = c.source === "manual";
    const palette = isManual ? PALETTE.manual : PALETTE.generated;
    const w = (c.width ?? COLUMN_BASE_SIZE) * (isManual ? 1.3 : 1.0);
    const d = (c.depth ?? COLUMN_BASE_SIZE) * (isManual ? 1.3 : 1.0);
    const h = c.height ?? buildingHeight;

    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: palette.column,
      metalness: isManual ? 0.45 : 0.35,
      roughness: 0.55,
      transparent: true,
      opacity: isManual ? 1.0 : 0.92,
      emissive: isManual ? new THREE.Color(0x1f3a5f) : new THREE.Color(0x000000),
      emissiveIntensity: isManual ? 0.3 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(c.x, 0, c.y);
    mesh.userData = {
      placementType: "column",
      placementId: c.id,
      label: c.label || c.id,
      source: c.source,
      locked: !!c.locked,
      manual: isManual,
      kind: c.kind,
    };
    this.group.add(mesh);
    this.byId.set(c.id, mesh);
    this._disposables.add(geo);
    this._disposables.add(mat);

    // Manual columns get a thin highlight ring at the base.
    if (isManual) {
      const ringGeo = new THREE.RingGeometry(w * 0.85, w * 1.25, 24);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: palette.column,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(c.x, 0.05, c.y);
      ring.userData = { placementId: `${c.id}-ring`, selectable: false };
      this.group.add(ring);
      this._disposables.add(ringGeo);
      this._disposables.add(ringMat);
    }
  }

  _addBeam(b) {
    const dx = b.x2 - b.x1;
    const dy = b.y2 - b.y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.5) return;

    const isManual = b.source === "manual";
    const palette = isManual ? PALETTE.manual : PALETTE.generated;
    const span = b.spanFt || length;
    // Visual depth: scale slightly with span so long-span beams look beefier.
    const visualDepth = Math.min(2.4, BEAM_DEPTH_DEFAULT + (span - 24) * 0.04);
    const visualWidth = isManual ? 0.75 : 0.6;
    const z = b.z1 ?? 60;

    const geo = new THREE.BoxGeometry(length, visualDepth, visualWidth);
    const mat = new THREE.MeshStandardMaterial({
      color: palette.beam,
      metalness: 0.4,
      roughness: 0.5,
      transparent: true,
      opacity: isManual ? 1.0 : 0.86,
      emissive: isManual ? new THREE.Color(0x16335a) : new THREE.Color(0x000000),
      emissiveIntensity: isManual ? 0.25 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Rotate to align with (dx, dy) in plan; X = beam axis, plan-Y is world Z.
    const angle = Math.atan2(dy, dx);
    mesh.position.set((b.x1 + b.x2) / 2, z, (b.y1 + b.y2) / 2);
    mesh.rotation.y = -angle;
    mesh.userData = {
      placementType: "beam",
      placementId: b.id,
      label: b.id,
      source: b.source,
      locked: !!b.locked,
      manual: isManual,
      span,
    };
    this.group.add(mesh);
    this.byId.set(b.id, mesh);
    this._disposables.add(geo);
    this._disposables.add(mat);
  }

  _addWall(w, buildingHeight) {
    const dx = w.x2 - w.x1;
    const dy = w.y2 - w.y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.5) return;

    const isManual = w.source === "manual";
    const palette = isManual ? PALETTE.manual : PALETTE.generated;
    const thickness = w.thickness ?? 0.6;
    const height = w.height ?? buildingHeight;

    const geo = new THREE.BoxGeometry(length, height, Math.max(thickness * 1.4, 0.6));
    geo.translate(0, height / 2, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: palette.wall,
      metalness: 0.1,
      roughness: 0.7,
      transparent: true,
      opacity: 0.72,
      emissive: new THREE.Color(palette.wall).multiplyScalar(isManual ? 0.25 : 0.08),
    });
    const mesh = new THREE.Mesh(geo, mat);
    const angle = Math.atan2(dy, dx);
    mesh.position.set((w.x1 + w.x2) / 2, 0, (w.y1 + w.y2) / 2);
    mesh.rotation.y = -angle;
    mesh.userData = {
      placementType: "shearWall",
      placementId: w.id,
      label: w.label || w.id,
      source: w.source,
      locked: !!w.locked,
      manual: isManual,
    };
    this.group.add(mesh);
    this.byId.set(w.id, mesh);
    this._disposables.add(geo);
    this._disposables.add(mat);

    // Outline edges
    const edges = new THREE.EdgesGeometry(geo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: palette.wallEdge,
      transparent: true,
      opacity: isManual ? 1.0 : 0.65,
    });
    const edgeMesh = new THREE.LineSegments(edges, edgeMat);
    edgeMesh.position.copy(mesh.position);
    edgeMesh.rotation.copy(mesh.rotation);
    edgeMesh.userData = { placementId: `${w.id}-edge`, selectable: false };
    this.group.add(edgeMesh);
    this._disposables.add(edges);
    this._disposables.add(edgeMat);
  }

  _tintSelected(id) {
    const mesh = this.byId.get(id);
    if (!mesh?.material) return;
    const mat = mesh.material;
    mesh.userData.__prevColor = mat.color.getHex();
    mesh.userData.__prevEmissive = mat.emissive ? mat.emissive.getHex() : null;
    mat.color.setHex(PALETTE.selected);
    if (mat.emissive) {
      mat.emissive.setHex(PALETTE.selected);
      mat.emissiveIntensity = 0.6;
    }
    mat.needsUpdate = true;
  }

  _restoreColor(id) {
    const mesh = this.byId.get(id);
    if (!mesh?.material) return;
    const mat = mesh.material;
    if (mesh.userData.__prevColor != null) {
      mat.color.setHex(mesh.userData.__prevColor);
    }
    if (mesh.userData.__prevEmissive != null && mat.emissive) {
      mat.emissive.setHex(mesh.userData.__prevEmissive);
      mat.emissiveIntensity = mesh.userData.manual ? 0.25 : 0;
    }
    mat.needsUpdate = true;
  }

  // ─── Raycasting (used by interactions) ────────────────────────────

  /**
   * Raycast the placement group from a normalized device coordinate.
   * @returns {{ id: string, type: string, mesh: THREE.Object3D } | null}
   */
  raycast(ndc, camera) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(this.group.children, true);
    for (const h of hits) {
      if (h.object?.userData?.placementId && h.object.userData.selectable !== false) {
        return {
          id: h.object.userData.placementId,
          type: h.object.userData.placementType,
          mesh: h.object,
        };
      }
    }
    return null;
  }
}
