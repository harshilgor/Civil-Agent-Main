/**
 * Three.js viewport — thin orchestration shell.
 *
 * Responsibilities (and *only* these):
 *   • Create the renderer, scene, cameras (perspective + ortho), lights,
 *     OrbitControls, ResizeObserver, animation loop.
 *   • Instantiate the structural model builder and the controllers
 *     (page-mode, interaction, overlay, labels).
 *   • Forward CanvasController API calls (`mount`, `unmount`, `pause`,
 *     `resume`, `setPageMode`, `preset.apply`) into the appropriate
 *     controller method.
 *   • Forward state events (`page`, `selectedObject`, `activeSchemeId`,
 *     `activeLevelId`, `layers`) to the right controller.
 *
 * Everything else — scene construction, materials, opacity tweens,
 * raycasting, selection visuals, sizing/load overlays — lives in
 * dedicated modules.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { CameraPresetManager } from "./camera-controls.js";
import { StructuralModelBuilder } from "./structural-model-builder.js";
import { PageModeController } from "./page-mode-controller.js";
import { InteractionController } from "./interaction-controller.js";
import { OverlayController } from "./overlay-controller.js";
import { LabelManager } from "./label-manager.js";
import { IfcSourceLoader } from "./source-model/ifc-source-loader.js";

import { GeometryAdapterError } from "./parsed-geometry-adapter.js";
import {
  getSchemeBundle,
  getMemberDcrChecks,
  loadSchemes,
  loadSizing,
  getActiveSchemeId,
  getCachedScheme,
  getCachedSizing,
} from "./scheme-adapter.js";
import {
  loadParsedGeometry,
  getCachedRawGeometry,
  getCachedEnvelope,
  onGeometryChange,
} from "./parsed-geometry-cache.js";
import { onSizingStateChange } from "../components/sizing-runner.js";
import { getGeometrySourceFileUrl } from "../api/files.js";

import { state, on, set } from "../state.js";

// Bundled fixture used as a deterministic fallback when *no* real
// geometry is available (offline dev, fresh DB, mock projects). Once
// the cache resolves a real ParsedGeometry payload it takes over.
import { PARSED_GEOMETRY_FIXTURE as parsedGeometryFixture } from "../data/fixtures/parsed-geometry.fixture.js";

const PAGE_CAMERA = {
  overview: "iso-3d",
  geometry: "iso-3d",
  placement: "top-down",
  loads: "iso-tilted",
  schemes: "iso-3d",
  sizing: "iso-3d",
  reports: "iso-3d",
};

export class ThreeCanvas {
  constructor(host) {
    this.host = host;
    this.host.classList.add("three-host");

    this.scene = new THREE.Scene();
    this.scene.fog = null;

    this.target = new THREE.Vector3(0, 0, 0);
    this.activeCamera = null;
    this.perspCamera = null;
    this.orthoCamera = null;
    this.renderer = null;
    this.controls = null;

    // ── Three scene layer groups ──────────────────────────────────────────
    // Layer 1: Original uploaded IFC, rendered by That Open IfcLoader.
    this.sourceModelGroup = new THREE.Group();
    this.sourceModelGroup.name = "civilagent:source-model";

    // Layer 2 + 3: Civil Agent structural interpretation + generated scheme.
    // Both live inside StructuralModelBuilder.rootGroup (geometry + structural
    // sub-layers) — we expose the group handle here for camera-fit logic.
    this.structuralGroup = null; // set to builder.rootGroup after mount

    /** @type {StructuralModelBuilder} */
    this.builder = null;
    /** @type {PageModeController} */
    this.pageMode = null;
    /** @type {InteractionController} */
    this.interaction = null;
    /** @type {OverlayController} */
    this.overlay = null;
    /** @type {LabelManager} */
    this.labels = null;

    this.preset = null;

    /** @type {IfcSourceLoader|null} */
    this._ifcSourceLoader = null;
    /** Current IFC source load task promise (to avoid double-load). */
    this._ifcLoadPromise = null;

    /** @type {string|null} last GeometryAdapterError message from _safeBuild */
    this._lastBuildErrorMessage = null;

    this.running = false;
    this._needsRender = true;
    this._rafId = null;
    this._unsubs = [];
    this._handleResize = this._handleResize.bind(this);
    this._loop = this._loop.bind(this);
  }

  // ──────────────────────────────────────────────────────────
  // Lifecycle (CanvasController contract)
  // ──────────────────────────────────────────────────────────

  mount() {
    const w = this.host.clientWidth || 800;
    const h = this.host.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(0x070707, 1);
    // Engineering surface — no shadows.
    this.renderer.shadowMap.enabled = false;
    this.host.appendChild(this.renderer.domElement);

    this._setupCameras(w, h);
    this._setupLights();
    this._setupControls();

    this.preset = new CameraPresetManager(this);

    // Layer groups — source model sits beneath the structural overlay so
    // the engineering scene always reads on top.
    this.scene.add(this.sourceModelGroup);

    // Build initial geometry from the fixture (real API geometry takes
    // over via `applyParsedGeometry` once the upload pipeline ships).
    this.builder = new StructuralModelBuilder(this.scene);
    this.structuralGroup = this.builder.rootGroup;
    this.labels = new LabelManager(this.host);

    // Source priority for the initial render:
    //   1. ParsedGeometry handed off by the new-project flow on the
    //      processing screen — guaranteed fresh, already in memory.
    //   2. Whatever the geometry cache already holds (e.g. user
    //      navigated back to the workspace from another page).
    //   3. The bundled fixture, so the canvas has *something* to
    //      render while we kick off the real fetch.
    const initialRaw =
      state.newProject?.parsedGeometry ??
      getCachedRawGeometry() ??
      parsedGeometryFixture;
    const geometry = this._safeBuild(initialRaw);

    if (geometry) {
      this._clearGeometryErrorBanner();
      this._lastAppliedGeometry = initialRaw;
      this.target.copy(this.builder.modelCenter);
      this.controls.target.copy(this.target);
      // Snap cameras to model-centered positions on first load so the
      // building occupies the middle of the screen rather than drifting
      // to the right when the geometry is not anchored at the origin.
      this._snapCamerasToTarget();
      this.labels.setSource(geometry.gridLines, geometry.buildingBounds);
      this._rebuildScheme();
      // Pull schemes for the active project as soon as the canvas
      // mounts. The cache will be empty before this resolves; the
      // builder happily renders an empty bundle so the user sees the
      // floor plates / grids while scheme data loads.
      this._refreshSchemes();
      // And kick off the parsed-geometry fetch so the next frame can
      // swap in the real building if the user just landed here from
      // a different page (the new-project flow has parsedGeometry in
      // hand already, so the fetch is short-circuited via the cache).
      this._refreshParsedGeometry();
    } else {
      this._showGeometryErrorBanner(
        this._lastBuildErrorMessage ||
          "No renderable geometry was produced from the parsed model.",
      );
      this._refreshParsedGeometry();
    }

    this.pageMode = new PageModeController(this.builder.registry, () => this.requestRender());
    this.overlay = new OverlayController(this.builder.registry, this.builder.overlayLayer, () => this.requestRender());
    this.interaction = new InteractionController(
      this.renderer.domElement,
      this.activeCamera,
      this.builder.registry,
      this.builder.selectionLayer,
      {
        onChange: () => this.requestRender(),
        // Selection dim-others lives in PageModeController so opacity has
        // a single owner (page mode = baseline; selection = multiplier).
        onSelectionChange: (id) => this.pageMode?.setSelection(id),
        onZoomTo: (id) => {
          if (id) {
            const mesh = this.builder.registry.getById(id);
            if (mesh) this._zoomToMesh(mesh);
          } else {
            this.preset.apply("fit-all");
          }
        },
      },
    );

    this._wireStateSubscriptions();

    // Initial paint
    this.pageMode.applyPageMode(state.page, { instant: true });
    this._applyOverlayForPage(state.page);

    this._resizeObserver = new ResizeObserver(this._handleResize);
    this._resizeObserver.observe(this.host);

    this.running = true;
    this._loop();
  }

  unmount() {
    this.running = false;
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._clearGeometryErrorBanner();
    this._disposeIfcSourceLoader();

    this._unsubs.forEach((fn) => fn());
    this._unsubs = [];

    this.interaction?.dispose();
    this.overlay?.dispose();
    this.pageMode?.dispose();
    this.builder?.dispose();
    this.labels?.dispose();

    if (this.renderer) {
      try { this.host.removeChild(this.renderer.domElement); } catch (_) {}
      this.renderer.dispose();
    }
    this.renderer = null;
    this.controls = null;
    this.host.classList.remove("three-host");
  }

  pause() {
    this.running = false;
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  // ──────────────────────────────────────────────────────────
  // Public methods invoked by CanvasController (or future callers)
  // ──────────────────────────────────────────────────────────

  /**
   * Apply the visual profile for a workspace page.
   * Preserved name — CanvasController already calls this.
   */
  setPageMode(pageName) {
    if (!this.builder) return;

    // If the currently-selected element would tween toward near-zero
    // opacity on the new page, clear selection first so the wireframe
    // doesn't sit on a ghost. Setting state.selectedObject = null fires
    // the existing subscription, which routes through the page-mode
    // controller and drops the dim-others factor cleanly.
    this._clearSelectionIfHiddenOn(pageName);

    this.pageMode.applyPageMode(pageName);
    this._applyOverlayForPage(pageName);
    const cam = PAGE_CAMERA[pageName];
    if (cam && this.preset) this.preset.apply(cam);
    this.requestRender();
  }

  _clearSelectionIfHiddenOn(pageName) {
    const sel = state.selectedObject;
    if (!sel?.id || !this.builder || !this.pageMode) return;
    const mesh = this.builder.registry.getById(sel.id);
    if (!mesh) return;
    if (!this.pageMode.willBeVisibleOnPage(mesh, pageName)) {
      state.selectedObject = null;
    }
  }

  /**
   * Replace the structural geometry. Safe to call multiple times — the
   * previous scene graph is fully disposed first.
   */
  applyParsedGeometry(rawGeometry) {
    if (!this.builder) return null;
    const geometry = this._safeBuild(rawGeometry);
    if (!geometry) {
      this._showGeometryErrorBanner(
        this._lastBuildErrorMessage ||
          "Geometry could not be rendered from the latest parsed data.",
      );
      return null;
    }

    this._clearGeometryErrorBanner();
    this._rebuildScheme();
    this.target.copy(this.builder.modelCenter);
    this.controls.target.copy(this.target);
    this.labels.setSource(geometry.gridLines, geometry.buildingBounds);

    // Fly to the new model centre after a geometry hot-swap so the
    // building stays centred when the project changes.
    this.preset.apply("iso-3d");

    this.pageMode.applyPageMode(state.page, { instant: true });
    this._applyOverlayForPage(state.page);
    this.requestRender();
    // Geometry hot-swap usually means the project just finished
    // parsing — refresh the scheme cache so the workspace shows real
    // generated layouts as soon as Agent 3 finishes.
    this._refreshSchemes();
    return geometry;
  }

  setActiveLevel(levelId) {
    if (!this.builder) return;
    this.builder.setActiveLevel(levelId);
    this.pageMode.refresh();
    this.requestRender();
  }

  /** Used by CameraPresetManager to swap which camera OrbitControls owns. */
  useCamera(kind) {
    this.activeCamera = kind === "ortho" ? this.orthoCamera : this.perspCamera;
    if (this.controls) {
      this.controls.object = this.activeCamera;
      this.controls.update();
    }
    this.interaction?.setCamera(this.activeCamera);
    this.requestRender();
  }

  requestRender() {
    this._needsRender = true;
  }

  // ──────────────────────────────────────────────────────────
  // Setup helpers
  // ──────────────────────────────────────────────────────────

  _setupCameras(w, h) {
    const aspect = w / h;
    const frustum = 80;

    this.orthoCamera = new THREE.OrthographicCamera(
      -frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 4000,
    );
    this.orthoCamera.position.set(0, 320, 0);
    this.orthoCamera.lookAt(this.target);

    this.perspCamera = new THREE.PerspectiveCamera(38, aspect, 0.1, 4000);
    this.perspCamera.position.set(180, 130, 180);
    this.perspCamera.lookAt(this.target);

    this.activeCamera = this.perspCamera;
  }

  _setupLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(-100, 220, 90);
    // No shadows — see Section 6 of the agent spec.
    key.castShadow = false;
    this.scene.add(key);

    this.scene.add(new THREE.HemisphereLight(0x1a2538, 0x080808, 0.30));
  }

  _setupControls() {
    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement);

    // Orbit + pan + zoom
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enableZoom = true;
    this.controls.zoomSpeed = 1.2;
    this.controls.enablePan = true;
    this.controls.panSpeed = 0.8;
    // Pan along the ground plane (right-click drag / middle-click drag /
    // two-finger drag on touch). False = pan moves the orbit target in
    // world-space XZ so the building stays planted on the ground.
    this.controls.screenSpacePanning = false;

    // Keyboard arrow keys also pan — useful when inspector is open.
    this.controls.enableKeys = true;
    this.controls.keyPanSpeed = 12;

    this.controls.target.copy(this.target);
    // Block looking past vertical so the building never flips upside-down.
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 1200;

    this.controls.addEventListener("change", () => {
      this._needsRender = true;
    });
  }

  _wireStateSubscriptions() {
    this._unsubs.push(on("page", (p) => this.setPageMode(p)));
    this._unsubs.push(on("selectedObject", (sel) => {
      this.interaction?.selectElement(sel ? sel.id : null);
    }));
    this._unsubs.push(on("activeSchemeId", (id) => {
      this._rebuildScheme();
      this._maybeFetchSizing(id);
    }));
    this._unsubs.push(on("projectId", () => {
      this._refreshSchemes();
      this._refreshParsedGeometry();
    }));
    // Cache changes (refresh, accept, clear) → swap geometry in place.
    this._unsubs.push(
      onGeometryChange((entry) => {
        const raw = entry?.raw;
        if (!raw || raw === this._lastAppliedGeometry) return;
        this._lastAppliedGeometry = raw;
        this.applyParsedGeometry(raw);
      }),
    );
    this._unsubs.push(on("activeLevelId", (id) => this.setActiveLevel(id)));
    // Project switch: dispose any in-progress or completed IFC source load so
    // the next _maybeLoadSourceModel call starts fresh for the new project.
    this._unsubs.push(on("projectId", () => {
      this._disposeIfcSourceLoader();
    }));
    // Re-paint D/C overlay whenever a sizing run completes for the
    // active scheme (the runner has already refreshed the cache).
    this._unsubs.push(onSizingStateChange(() => {
      if (state.page === "sizing") {
        this._applyOverlayForPage("sizing");
      }
      // Also re-render scheme bundle so size labels and tray cards
      // pick up the freshly-merged sizing data.
      this._rebuildScheme();
    }));
    this._unsubs.push(on("layers", (layers) => {
      this.pageMode?.setLayerOverrides(layers);
      // Top-level group toggles — owned by ThreeCanvas, not PageModeController.
      if (this.sourceModelGroup) {
        this.sourceModelGroup.visible = layers.sourceModel !== false;
      }
      if (this.structuralGroup) {
        // structuralInterpretation covers floor plates / grids / cores / NCZ.
        // generatedScheme covers columns / beams / walls / braces.
        // Both share the same rootGroup but PageModeController manages their
        // individual sublayer opacities; we just gate the whole group here.
        this.structuralGroup.visible =
          (layers.structuralInterpretation !== false) ||
          (layers.generatedScheme !== false);
      }
      this._needsRender = true;
    }));
    // Hot-swap geometry when the new-project flow finishes parsing
    // while the workspace is already mounted (e.g. processing → workspace
    // hand-off via the "Open workspace" CTA). Only act on a *change*
    // since `newProject` fires on every nested mutation.
    this._unsubs.push(
      on("newProject.parsedGeometry", (geometry) => {
        if (geometry && geometry !== this._lastAppliedGeometry) {
          this._lastAppliedGeometry = geometry;
          this.applyParsedGeometry(geometry);
        }
      }),
    );
  }

  // ──────────────────────────────────────────────────────────
  // Build helpers
  // ──────────────────────────────────────────────────────────

  _safeBuild(rawGeometry) {
    this._lastBuildErrorMessage = null;
    console.group("[CivilAgent] _safeBuild");
    console.log(
      "input keys:",
      rawGeometry && typeof rawGeometry === "object" ? Object.keys(rawGeometry) : rawGeometry,
    );
    console.log("levels count:", rawGeometry?.levels?.length);
    console.log("existingColumns count:", rawGeometry?.existingColumns?.length);
    try {
      const model = this.builder.buildFromParsedGeometry(rawGeometry);
      console.log("adapted OK — normalized levels:", model?.levels?.length);
      const withBoundary = model?.levels?.filter((l) => l.planBoundary)?.length ?? 0;
      console.log("levels with planBoundary:", withBoundary, "/", model?.levels?.length);
      const bb = this.builder.geometry?.buildingBounds;
      const mc = this.builder.modelCenter;
      if (bb) {
        console.log(
          "[CivilAgent] scene bounds: x " + bb.minX.toFixed(2) + "…" + bb.maxX.toFixed(2) +
          "  z " + bb.minZ.toFixed(2) + "…" + bb.maxZ.toFixed(2),
        );
        console.log(
          "[CivilAgent] modelCenter: (" + mc.x.toFixed(2) + ", " + mc.y.toFixed(2) + ", " + mc.z.toFixed(2) + ")",
        );
      }
      console.groupEnd();
      return model;
    } catch (err) {
      if (err instanceof GeometryAdapterError) {
        this._lastBuildErrorMessage = err.message;
        console.error("[CivilAgent] Geometry could not be rendered:", err.message);
        console.groupEnd();
        return null;
      }
      console.groupEnd();
      throw err;
    }
  }

  _clearGeometryErrorBanner() {
    if (!this.host) return;
    this.host.querySelectorAll(".three-geometry-error").forEach((el) => el.remove());
  }

  _showGeometryErrorBanner(detailMessage) {
    if (!this.host) return;
    this._clearGeometryErrorBanner();
    const wrap = document.createElement("div");
    wrap.className = "three-geometry-error";
    wrap.setAttribute("role", "alert");

    const title = document.createElement("p");
    title.textContent = "Geometry could not be rendered for this project.";

    const hint = document.createElement("p");
    hint.textContent =
      "The 3D view needs ParsedGeometry levels with usable plan boundaries (typically from slabs or inferred footprints). Check the console for [CivilAgent] logs and the Network tab for GET …/geometry.";

    const detail = document.createElement("p");
    detail.className = "mono";
    detail.textContent = detailMessage || "";

    wrap.append(title, hint, detail);
    this.host.appendChild(wrap);
  }

  /**
   * Instantly place both cameras relative to `this.target` (the model
   * centre) without animation. Called once after the first geometry
   * build so the building is always centred on screen regardless of
   * where the origin is in world-space.
   *
   * All subsequent camera moves (page switches, preset buttons, zoom-to)
   * use the same offset formula, so the behaviour is identical to
   * `CameraPresetManager.apply("iso-3d")` but without the tween — an
   * instant snap is better for the initial load (no visible fly-in).
   */
  _snapCamerasToTarget() {
    const cx = this.target.x;
    const cz = this.target.z;

    // Perspective — iso-3d angle: 45° azimuth, ~36° elevation
    this.perspCamera.position.set(cx + 180, 130, cz + 180);
    this.perspCamera.lookAt(this.target);

    // Orthographic — directly above for the top-down preset
    this.orthoCamera.position.set(cx, 320, cz + 0.001);
    this.orthoCamera.lookAt(this.target);

    if (this.controls) {
      this.controls.target.copy(this.target);
      this.controls.update();
    }
    this.requestRender();
  }

  /**
   * Pull scheme members from the scheme adapter (API-backed cache)
   * and feed them to the builder. Called on first mount, on
   * `activeSchemeId` change, and after `applyParsedGeometry`.
   *
   * Synchronous — the cache is populated by `_refreshSchemes()`
   * (which is async). If the cache is empty for the requested id,
   * the builder receives an empty bundle and clears any prior scheme
   * meshes; the geometry layer (floor plates, grids) keeps rendering.
   */
  _rebuildScheme() {
    if (!this.builder?.geometry) return;
    const transform = this.builder.geometry.metadata?.originTransform || {};
    const bundle = getSchemeBundle(state.activeSchemeId, transform);
    this.builder.rebuildScheme(bundle);
    this.pageMode?.refresh();
    this.requestRender();
  }

  /**
   * Reload the scheme cache from the API for the current project,
   * then rebuild whichever scheme is currently active. Falls back to
   * the cache's "active" scheme if `state.activeSchemeId` was never
   * set (first project load).
   *
   * Errors are swallowed — they're already reported by `request()`
   * via toast plumbing in the caller — so a failed scheme fetch
   * doesn't tear down the canvas.
   */
  async _refreshSchemes() {
    const projectId = state.projectId || state.newProject?.projectId;
    if (!projectId) return;
    try {
      await loadSchemes(projectId);
    } catch (err) {
      // PROJECT_NOT_FOUND for a frontend-mock project (e.g. fresh dev DB)
      // is expected — the UI falls back to the bundled mock data, no
      // need to surface it as a warning.
      if (err?.code !== "PROJECT_NOT_FOUND") {
        console.warn("[CivilAgent] Failed to load schemes:", err?.message || err);
      }
      return;
    }
    if (!state.activeSchemeId) {
      const next = getActiveSchemeId();
      if (next) state.activeSchemeId = next;
    }
    this._rebuildScheme();
    this._maybeFetchSizing(state.activeSchemeId);
  }

  /**
   * Pull the project's parsed geometry from the cache (which fetches
   * if needed) and let the cache listener swap it into the scene. The
   * cache is the single source of truth for the inspector / tray / 2D
   * canvas as well, so a single load here unblocks every UI surface.
   *
   * Errors are reported but don't tear down the canvas — the existing
   * geometry (fixture or last-good payload) keeps rendering.
   */
  async _refreshParsedGeometry() {
    const projectId = state.projectId || state.newProject?.projectId;
    if (!projectId) return;
    try {
      await loadParsedGeometry(projectId);
      // After geometry is in cache, attempt to load the source IFC model.
      this._maybeLoadSourceModel(projectId);
    } catch (err) {
      console.warn(
        "[CivilAgent] Failed to load parsed geometry:",
        err?.message || err,
      );
    }
  }

  /**
   * Attempt to load the original IFC source model if the geometry envelope
   * knows which file was parsed and the file format is IFC.
   */
  _maybeLoadSourceModel(projectId) {
    const raw = getCachedRawGeometry();
    const envelope = getCachedEnvelope();

    // Prefer the geometry ID from the envelope — lets the backend endpoint
    // follow the authoritative DB FK (ParsedGeometryRow.source_file_id) and
    // fall back to the most recent IFC upload when the original file row was
    // deleted.  The raw metadata's `sourceFileId` can become stale after a
    // DB migration or file deletion, so we no longer rely on it for lookup.
    const geometryId = envelope?.geometryId ?? null;
    const format = raw?.metadata?.fileFormat ?? envelope?.sourceFileFormat ?? "";

    console.log("[CivilAgent] _maybeLoadSourceModel", {
      projectId,
      geometryId,
      fileFormat: format,
      sourceFileId: raw?.metadata?.sourceFileId,
    });

    if (!geometryId) {
      console.warn("[CivilAgent] Source model load skipped: no geometryId in envelope");
      return;
    }

    if (format !== "ifc") {
      console.warn("[CivilAgent] Source model load skipped: source file is not IFC", { format });
      return;
    }

    const originTransform = raw?.metadata?.originTransform ?? {};

    // Mirror the same mm→ft heuristic used in parsed-geometry-adapter.js so
    // the source model group is scaled identically to the structural layer.
    const { tx: rawTx = 0, ty: rawTy = 0 } = originTransform;
    const rawOffset = Math.max(Math.abs(rawTx), Math.abs(rawTy));
    const unitScale = rawOffset > 500 ? 0.00328084 : 1.0;

    console.log("[CivilAgent] _maybeLoadSourceModel unitScale:", unitScale, "(rawOffset:", rawOffset.toFixed(0) + ")");

    this._loadIfcSourceModel(projectId, geometryId, originTransform, unitScale);
  }

  /**
   * Fetch sizing data for a scheme if it has been sized but the
   * adapter cache is empty (typical scenario: page load with a scheme
   * that was sized in a previous session). Quietly no-ops when the
   * scheme has not been sized.
   */
  async _maybeFetchSizing(schemeId) {
    if (!schemeId) return;
    const projectId = state.projectId || state.newProject?.projectId;
    if (!projectId) return;
    if (getCachedSizing(schemeId)) return;            // already loaded
    const scheme = getCachedScheme(schemeId);
    if (!scheme) return;
    if (scheme.sizingStatus !== "sized") return;       // never sized — skip the fetch
    try {
      await loadSizing(projectId, schemeId);
    } catch (err) {
      console.warn(
        "[CivilAgent] Failed to load sizing for scheme:",
        err?.message || err,
      );
      return;
    }
    // Re-paint and re-apply overlay so the freshly-cached D/C numbers
    // show up in place.
    this._rebuildScheme();
    if (state.page === "sizing") {
      this._applyOverlayForPage("sizing");
    }
  }

  // ──────────────────────────────────────────────────────────
  // Source model layer (That Open IFC)
  // ──────────────────────────────────────────────────────────

  /**
   * Fetch the original IFC file from S3 and load it via That Open
   * IfcLoader into `sourceModelGroup`. Safe to call multiple times —
   * subsequent calls are no-ops once a load is in flight or complete.
   *
   * @param {string} projectId
   * @param {string} geometryId    - ParsedGeometryRow.id (used to find source file)
   * @param {object} [originTransform] - { tx, ty } from metadata
   * @param {number} [unitScale]   - mm→ft conversion factor
   */
  async _loadIfcSourceModel(projectId, geometryId, originTransform = {}, unitScale = 1) {
    if (this._ifcLoadPromise) return; // already loading or loaded
    if (!geometryId) return;

    this._ifcLoadPromise = this._doLoadIfcSourceModel(projectId, geometryId, originTransform, unitScale);
    try {
      await this._ifcLoadPromise;
    } catch (_err) {
      // Download/API errors don't permanently block future attempts — clear the
      // slot so a subsequent _maybeLoadSourceModel call (e.g. after a page
      // action or project switch) can retry.
      this._ifcLoadPromise = null;
    }
    // Successful loads keep the promise set to prevent double-loading the same
    // model.  The slot is also cleared by _disposeIfcSourceLoader() on project
    // switch and component unmount.
  }

  async _doLoadIfcSourceModel(projectId, geometryId, originTransform, unitScale = 1) {
    set("sourceModelStatus", "loading");
    console.log("[CivilAgent] _doLoadIfcSourceModel start — projectId:", projectId, "geometryId:", geometryId);
    try {
      // 1. Get a presigned download URL via the geometry-scoped endpoint.
      //    The backend follows ParsedGeometryRow.source_file_id (authoritative
      //    FK) and falls back to the most recent IFC upload for the project
      //    when the original file row was deleted or is unavailable.
      const { downloadUrl, fileId: resolvedFileId } = await getGeometrySourceFileUrl(projectId, geometryId);
      console.log("[CivilAgent] Source IFC resolved — fileId:", resolvedFileId);

      // 2. Fetch the IFC bytes.
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`IFC fetch failed: ${res.status} ${res.statusText}`);
      const arrayBuffer = await res.arrayBuffer();

      // 3. Init That Open loader (idempotent).
      if (!this._ifcSourceLoader) {
        this._ifcSourceLoader = new IfcSourceLoader({
          scene: this.scene,
          camera: this.activeCamera,
          controls: this.controls,
          sourceModelGroup: this.sourceModelGroup,
          onProgress: (p) => {
            console.log("[CivilAgent] IFC source model conversion progress:", Math.round(p * 100) + "%");
          },
          onLoaded: () => {
            set("sourceModelStatus", "loaded");
            this._logLayerBounds(originTransform);
            this.requestRender();
          },
          onError: (err) => {
            console.error("[CivilAgent] IfcSourceLoader error:", err);
            set("sourceModelStatus", "error");
          },
          onStatus: (s) => {
            if (s !== "loaded") set("sourceModelStatus", s);
          },
        });
        await this._ifcSourceLoader.init();
      }

      // 4. Convert + add to scene, applying coordinate alignment + unit scale.
      await this._ifcSourceLoader.loadFromArrayBuffer(
        arrayBuffer,
        `${projectId}-source`,
        originTransform,
        unitScale,
      );

      // Apply initial visibility from layer state.
      this.sourceModelGroup.visible = state.layers?.sourceModel !== false;

    } catch (err) {
      console.error("[CivilAgent] _doLoadIfcSourceModel failed:", err);
      set("sourceModelStatus", "error");
      // Tear down a half-initialised loader so the next retry (e.g. after
      // project switch or page-action change) starts fresh instead of
      // tripping the "must be awaited" cascade.
      this._disposeIfcSourceLoader();
      // Re-throw so _loadIfcSourceModel clears its in-flight promise and
      // a future call can retry rather than no-op.
      throw err;
    }
  }

  _disposeIfcSourceLoader() {
    if (this._ifcSourceLoader) {
      this._ifcSourceLoader.dispose();
      this._ifcSourceLoader = null;
    }
    this._ifcLoadPromise = null;
  }

  /**
   * Log bounding boxes and alignment diagnostics for both layers.
   * @param {object} originTransform
   */
  _logLayerBounds(originTransform) {
    const sourceBbox = new THREE.Box3().setFromObject(this.sourceModelGroup);
    const structuralBbox = this.structuralGroup
      ? new THREE.Box3().setFromObject(this.structuralGroup)
      : null;

    const sourceCenter = sourceBbox.isEmpty() ? null : sourceBbox.getCenter(new THREE.Vector3());
    const structuralCenter = structuralBbox?.isEmpty() ? null : structuralBbox?.getCenter(new THREE.Vector3());

    console.group("[CivilAgent] Source vs Structural Alignment");
    console.log("source model bbox:", sourceBbox);
    console.log("structural model bbox:", structuralBbox);
    console.log("source center:", sourceCenter);
    console.log("structural center:", structuralCenter);
    console.log("originTransform applied:", originTransform);
    if (sourceCenter && structuralCenter) {
      const drift = new THREE.Vector3().subVectors(sourceCenter, structuralCenter);
      console.log("center drift (source − structural):", drift);
      if (drift.length() > 50) {
        console.warn(
          "[CivilAgent] Large alignment drift detected (" + drift.length().toFixed(1) + " units). " +
          "Check unit scale (IFC metres vs Civil Agent feet: multiply by 3.28084) or originTransform.",
        );
      }
    }
    console.log("[CivilAgent] Layer Groups children counts:");
    console.log("  sourceModelGroup:", this.sourceModelGroup.children.length);
    console.log("  structuralGroup:", this.structuralGroup?.children.length ?? "n/a");
    console.groupEnd();
  }

  _applyOverlayForPage(pageName) {
    if (!this.overlay || !this.builder?.geometry) return;
    const levelById = this.builder.geometry.levelById;

    if (pageName === "sizing") {
      this.overlay.clearLoadVisualization();
      this.overlay.applySizingColors(getMemberDcrChecks(state.activeSchemeId));
    } else if (pageName === "loads") {
      this.overlay.clearSizingColors();
      this.overlay.applyLoadVisualization(buildLoadPayload(levelById), levelById);
    } else {
      this.overlay.clearSizingColors();
      this.overlay.clearLoadVisualization();
    }
  }

  // ──────────────────────────────────────────────────────────
  // Camera utilities
  // ──────────────────────────────────────────────────────────

  _zoomToMesh(mesh) {
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) {
      this.preset?.apply("fit-all");
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 5);
    const distance = Math.max(maxDim * 2.4, 25);
    this.target.copy(center);
    this.controls.target.copy(center);

    if (this.activeCamera === this.perspCamera) {
      const dest = new THREE.Vector3(
        center.x + distance,
        center.y + distance * 0.6,
        center.z + distance,
      );
      animateVec(this.activeCamera.position, dest, 400, () => {
        this.requestRender();
      });
    }
  }

  // ──────────────────────────────────────────────────────────
  // Resize + render loop
  // ──────────────────────────────────────────────────────────

  _handleResize() {
    if (!this.renderer || !this.host) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    const aspect = w / h;
    this.renderer.setSize(w, h, false);

    this.perspCamera.aspect = aspect;
    this.perspCamera.updateProjectionMatrix();

    const f = 80;
    this.orthoCamera.left = -f * aspect;
    this.orthoCamera.right = f * aspect;
    this.orthoCamera.top = f;
    this.orthoCamera.bottom = -f;
    this.orthoCamera.updateProjectionMatrix();

    this._needsRender = true;
  }

  _loop() {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(this._loop);
    if (this.controls) this.controls.update();
    if (this.labels) this.labels.update(this.activeCamera);
    if (this.renderer && this.activeCamera) {
      this.renderer.render(this.scene, this.activeCamera);
    }
    this._needsRender = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function animateVec(target, dest, duration, onTick) {
  const start = target.clone();
  const t0 = performance.now();
  const step = () => {
    const t = Math.min((performance.now() - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    target.lerpVectors(start, dest, eased);
    onTick?.();
    if (t < 1) requestAnimationFrame(step);
  };
  step();
}

/**
 * Synthesize a load-visualization payload from the existing fixture.
 * Until Agent 4 ships real load output, we render a sparse arrow grid +
 * representative tributary polygons just like the previous monolith did.
 */
function buildLoadPayload(levelById) {
  const targetLevel = levelById.get("L6") || levelById.values().next().value;
  if (!targetLevel) return { arrows: [], tributary: [] };

  const xs = [28, 70, 112];
  const zs = [13, 52];
  const arrows = [];
  for (const x of xs) {
    for (const z of zs) {
      arrows.push({ x, z, levelId: targetLevel.id, magnitude: 60 });
    }
  }

  const palette = [0x3b82f6, 0x8b5cf6, 0x06b6d4, 0xf59e0b];
  const samples = [
    [[28, 13], [56, 13], [56, 39], [28, 39]],
    [[56, 13], [84, 13], [84, 39], [56, 39]],
    [[84, 13], [112, 13], [112, 39], [84, 39]],
    [[28, 39], [56, 39], [56, 65], [28, 65]],
  ];
  const tributary = samples.map((points, i) => ({
    points,
    levelId: targetLevel.id,
    color: palette[i % palette.length],
  }));

  return { arrows, tributary };
}
