/**
 * Optimization animation orchestrator.
 *
 * Drives the three-phase "AI is thinking" sequence (scan → iterate →
 * resolve) across the canvas (2D SVG + 3D Three.js), the inspector
 * panel, and the bottom tray. Used by Placement, Loads, Schemes, and
 * Sizing pages.
 *
 * Public API:
 *   runOptimization(config)   — start a sequence (cancels any running one)
 *   cancelOptimization()      — abort, restore canvas/inspector/tray state
 *   isOptimizationRunning()   — boolean
 *   onOptimizationStateChange(fn) — subscribe to phase transitions
 *
 * The orchestrator never mutates application state (`state.layers`,
 * `state.activeSchemeId`, etc.) — it only paints transient visuals over
 * existing renderers. That keeps it safe to compose with real backend
 * jobs: a page can fire a real API call (`startGeneration`,
 * `startSizing`) and call `runOptimization()` in parallel for the
 * "feels alive" surface.
 *
 * Page-specific behaviour is config, not forked code. The config keys
 * are documented inline on the `runOptimization()` function.
 */

import * as THREE from "three";
import { getActiveCanvasController } from "./canvas-controller.js";
import { toast } from "../components/toast.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const COLOR_SCAN = 0x3b82f6;        // accent blue
const COLOR_RESOLVE = 0x22c55e;     // accent green
const COLOR_WARN = 0xf59e0b;
const COLOR_FAIL = 0xef4444;

// SVG hex strings (ditto)
const HEX_SCAN = "#3b82f6";
const HEX_RESOLVE = "#22c55e";
const HEX_WARN = "#f59e0b";
const HEX_FAIL = "#ef4444";

const DEFAULT_DURATIONS = {
  scan: 3500,
  iterate: 10000,
  resolve: 3500,
};

// ─────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────

/**
 * Monotonic token bumped on every cancel/start. RAF callbacks check
 * their captured token against this to bail when the run is stale —
 * cheaper and more reliable than tearing down callbacks individually.
 */
let _runToken = 0;

/** @type {"idle"|"scan"|"iterate"|"resolve"|"complete"} */
let _phase = "idle";
let _running = false;

const _listeners = new Set();
function _emit() {
  for (const fn of _listeners) {
    try { fn(_phase); } catch { /* swallow */ }
  }
}

// Resources we need to clean up on cancel/finish.
let _cleanupFns = [];
function _addCleanup(fn) { _cleanupFns.push(fn); }
function _runCleanup() {
  const fns = _cleanupFns;
  _cleanupFns = [];
  for (const fn of fns) {
    try { fn(); } catch (err) { console.warn("[opt-anim] cleanup error", err); }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export function isOptimizationRunning() { return _running; }
export function optimizationPhase() { return _phase; }

export function onOptimizationStateChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function cancelOptimization() {
  _runToken += 1;
  _running = false;
  _phase = "idle";
  _runCleanup();
  _emit();
}

/**
 * Start the three-phase animation sequence.
 *
 * @param {object} cfg
 * @param {"placement"|"loads"|"schemes"|"sizing"} cfg.pageId
 * @param {object} [cfg.durations]      override scan/iterate/resolve ms
 * @param {number} [cfg.totalIterations] number to spin the iteration counter to (default 847)
 * @param {number} [cfg.visibleIterations] visible mutation cycles (default 6)
 * @param {Array<MetricSpec>} cfg.metrics    panel metrics shown in inspector
 * @param {string} [cfg.iterationLabel] bottom-tray progress label
 * @param {string} [cfg.successMessage] toast on completion
 * @param {string} [cfg.regenerateBtnSelector] button to flip to "Optimizing…" during run
 *
 * Page behaviours (booleans, default off):
 * @param {boolean} [cfg.iterateColumnsAndSlabs] mutate column positions + slab regions (placement)
 * @param {string[]} [cfg.combinationCycle]      cycle text in a value (loads)
 * @param {string} [cfg.combinationTargetLabel]  detail-label whose value is replaced (loads)
 * @param {Array<{table:string, key:string, start:number, end:number, format:(n:number)=>string}>}
 *                          [cfg.tableValueAnimations] animate values inside the bottom tray (loads)
 * @param {string[]} [cfg.sizeCycle]    W-shape designation cycle (sizing)
 * @param {boolean} [cfg.utilizationColors]      apply pass/warn/fail tinting on resolve (sizing)
 * @param {boolean} [cfg.schemeFilmstrip]        accumulate scheme cards 0→N during iterate (schemes)
 * @param {Array<object>} [cfg.schemeCards]      synthetic cards for filmstrip
 * @param {boolean} [cfg.dramaticCrossfade]      wholesale layout swap per iteration (schemes)
 *
 * @returns {Promise<void>}  resolves on completion or cancellation
 */
export async function runOptimization(cfg) {
  cancelOptimization(); // clears prior token + cleanup
  const token = ++_runToken;
  _running = true;
  _phase = "scan";
  _emit();

  const dur = { ...DEFAULT_DURATIONS, ...(cfg.durations || {}) };

  // Find the live canvas. If we don't have one (e.g. animation triggered
  // before mount completes), bail gracefully.
  const controller = getActiveCanvasController();
  if (!controller) {
    _running = false;
    _phase = "idle";
    _emit();
    return;
  }

  const surfaceMode = controller.getActiveSurface(); // "svg" | "three"
  const svgEl = controller.getSvgEl();
  const overlayLayer = controller.getSvgOverlayLayer();
  const three = controller.getThreeContext();

  // Mark canvas frame so CSS can dim baseline elements globally.
  const frame = svgEl?.closest(".canvas-frame") || three?.scene && document.querySelector(".canvas-frame");
  if (frame) {
    frame.dataset.optAnim = "scanning";
    _addCleanup(() => { delete frame.dataset.optAnim; });
  }

  // 3D mesh baseline snapshot bookkeeping — wipe at end of run so the
  // next run's mutations re-snapshot from a clean state.
  if (three?.registry) {
    _addCleanup(() => {
      for (const mesh of three.registry.allWithId()) {
        if (mesh.userData) {
          delete mesh.userData.__optBasePos;
          delete mesh.userData.__optBaseScale;
        }
      }
    });
  }

  // Inspector + tray overlays go up immediately so the user sees status
  // before the first scan finishes.
  const inspectorOverlay = mountInspectorOverlay(cfg);
  const trayOverlay = mountTrayOverlay(cfg);
  _addCleanup(() => inspectorOverlay?.remove());
  _addCleanup(() => trayOverlay?.remove());

  // Flip a regenerate button if the page configured one.
  const regenBtn = cfg.regenerateBtnSelector
    ? document.querySelector(cfg.regenerateBtnSelector)
    : null;
  if (regenBtn) {
    regenBtn.dataset.optBusy = "1";
    const originalText = regenBtn.querySelector("span")?.textContent;
    if (originalText && regenBtn.querySelector("span")) {
      regenBtn.querySelector("span").textContent = "Optimizing…";
    }
    _addCleanup(() => {
      if (!regenBtn.isConnected) return;
      delete regenBtn.dataset.optBusy;
      const span = regenBtn.querySelector("span");
      if (span && originalText) span.textContent = originalText;
      regenBtn.classList.add("opt-btn-flash");
      setTimeout(() => regenBtn.classList.remove("opt-btn-flash"), 700);
    });
  }

  // Phase 1: Scan
  await runScanPhase({ token, dur: dur.scan, surfaceMode, svgEl, overlayLayer, three, cfg, inspectorOverlay });
  if (token !== _runToken) return _finishCancelled();

  _phase = "iterate";
  _emit();
  if (frame) frame.dataset.optAnim = "iterating";

  // Phase 2: Iterate
  await runIteratePhase({ token, dur: dur.iterate, surfaceMode, svgEl, three, cfg, inspectorOverlay, trayOverlay });
  if (token !== _runToken) return _finishCancelled();

  _phase = "resolve";
  _emit();
  if (frame) frame.dataset.optAnim = "resolving";

  // Phase 3: Resolve
  await runResolvePhase({ token, dur: dur.resolve, surfaceMode, svgEl, three, cfg, inspectorOverlay, trayOverlay });
  if (token !== _runToken) return _finishCancelled();

  // Final state
  _phase = "complete";
  _emit();
  if (cfg.successMessage) {
    toast(cfg.successMessage, { tone: "pass", duration: 4200 });
  }

  // Linger briefly on the green-state, then tear down overlays. The
  // canvas itself stays in the "resolved" look for a moment so the
  // user reads the final numbers, then we restore everything.
  await sleep(900, token);
  if (token !== _runToken) return _finishCancelled();

  _running = false;
  _phase = "idle";
  _runCleanup();
  _emit();
}

function _finishCancelled() {
  _running = false;
  _phase = "idle";
  _runCleanup();
  _emit();
}

// ─────────────────────────────────────────────────────────────────────
// Phase 1: Scan
// ─────────────────────────────────────────────────────────────────────

async function runScanPhase({ token, dur, surfaceMode, svgEl, overlayLayer, three, cfg, inspectorOverlay }) {
  // Snapshot initial scan counter
  const total = countScannableElements({ surfaceMode, svgEl, three });
  setInspectorScanCounter(inspectorOverlay, 0, total);

  // 2D scan: a horizontal glowing rect that translates from top to bottom.
  let svgScanCleanup = null;
  if (svgEl && (surfaceMode === "svg" || true /* always run for split layouts */)) {
    svgScanCleanup = startSvgScan({ token, dur, svgEl, overlayLayer, total, inspectorOverlay, cfg });
  }
  if (svgScanCleanup) _addCleanup(svgScanCleanup);

  // 3D scan plane: a translucent THREE.Mesh that sweeps downward.
  let threeScanCleanup = null;
  if (three?.scene && three?.structuralGroup) {
    threeScanCleanup = startThreeScan({ token, dur, three, total, inspectorOverlay, cfg });
  }
  if (threeScanCleanup) _addCleanup(threeScanCleanup);

  await sleep(dur, token);
}

function startSvgScan({ token, dur, svgEl, overlayLayer, total, inspectorOverlay, cfg }) {
  const vb = svgEl.viewBox.baseVal;
  const viewMinY = vb.y;
  const viewMaxY = vb.y + vb.height;
  const viewMinX = vb.x;
  const viewW = vb.width;

  // Defs: gradient for a soft leading edge
  const NS = "http://www.w3.org/2000/svg";
  const defs = svgEl.querySelector("defs");
  const gradId = `opt-scan-grad-${token}`;
  const grad = document.createElementNS(NS, "linearGradient");
  grad.setAttribute("id", gradId);
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  grad.innerHTML = `
    <stop offset="0%"  stop-color="${HEX_SCAN}" stop-opacity="0.0"/>
    <stop offset="65%" stop-color="${HEX_SCAN}" stop-opacity="0.25"/>
    <stop offset="92%" stop-color="${HEX_SCAN}" stop-opacity="0.85"/>
    <stop offset="100%" stop-color="#bfdbfe" stop-opacity="1.0"/>
  `;
  defs.appendChild(grad);

  const scanH = Math.max(8, vb.height * 0.18);
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("class", "opt-scan-rect");
  rect.setAttribute("x", String(viewMinX));
  rect.setAttribute("width", String(viewW));
  rect.setAttribute("height", String(scanH));
  rect.setAttribute("y", String(viewMinY - scanH));
  rect.setAttribute("fill", `url(#${gradId})`);
  rect.style.pointerEvents = "none";
  overlayLayer.appendChild(rect);

  // Dim every selectable element. Per page-specific config we may also
  // want to drop additional flair (like the loads heatmap fade-in).
  svgEl.classList.add("opt-anim-active");

  // Pulse-on-touch: each element gets a `data-pulsed` flip when the
  // scan rect's leading edge crosses its bbox top.
  const elementsWithBBox = collectSvgScannables(svgEl);

  const t0 = performance.now();
  let scanned = 0;
  let rafId = 0;

  const tick = () => {
    if (token !== _runToken) return;
    const t = (performance.now() - t0) / dur;
    const tt = Math.min(t, 1);
    const yLeading = viewMinY + (viewMinY < 0 ? 0 : 0) + (viewMaxY - viewMinY + scanH) * tt - scanH;
    rect.setAttribute("y", String(yLeading));

    // Trigger pulses for elements crossed in this frame.
    for (const e of elementsWithBBox) {
      if (e._pulsed) continue;
      if (yLeading + scanH >= e.bboxTop) {
        e._pulsed = true;
        e.el.classList.add("opt-pulse");
        setTimeout(() => e.el.classList.remove("opt-pulse"), 320);
        e.el.classList.add("opt-dim"); // settle into dim after pulse
        scanned += 1;
        setInspectorScanCounter(inspectorOverlay, scanned, total);
      }
    }

    if (tt < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      // After the rect exits the viewport, fade it out.
      rect.style.transition = "opacity 220ms ease";
      rect.style.opacity = "0";
    }
  };
  rafId = requestAnimationFrame(tick);

  // Loads page: as the scan passes, fade in colored load overlays on
  // top of each slab so it reads as "AI is identifying loads."
  if (cfg.pageId === "loads") {
    addLoadOverlayDuringScan({ token, dur, svgEl, overlayLayer });
  }

  return () => {
    cancelAnimationFrame(rafId);
    rect.remove();
    grad.remove();
    svgEl.classList.remove("opt-anim-active");
    elementsWithBBox.forEach(({ el }) => {
      el.classList.remove("opt-pulse", "opt-dim", "opt-mutating", "opt-resolved", "opt-resolved-fail", "opt-resolved-warn");
      el.style.removeProperty("--opt-dx");
      el.style.removeProperty("--opt-dy");
      el.style.removeProperty("--opt-scale");
      el.style.removeProperty("transition");
    });
    // Remove transient overlays
    overlayLayer.querySelectorAll("[data-opt-transient]").forEach((n) => n.remove());
  };
}

function addLoadOverlayDuringScan({ token, dur, svgEl, overlayLayer }) {
  // Synthetic load tinting on the slab panels — uses the same panels as
  // svg-canvas._drawLoadHeatmap but on a transient layer so the
  // baseline slab heatmap stays visible underneath.
  const NS = "http://www.w3.org/2000/svg";
  const panels = [
    { x: 0,   y: 0,  w: 56, h: 26, dead: 0.20, live: 0.10 },
    { x: 56,  y: 0,  w: 56, h: 26, dead: 0.18, live: 0.18 },
    { x: 112, y: 0,  w: 36, h: 26, dead: 0.18, live: 0.20 },
    { x: 0,   y: 26, w: 56, h: 26, dead: 0.22, live: 0.16 },
    { x: 56,  y: 26, w: 56, h: 26, dead: 0.16, live: 0.30 },
    { x: 112, y: 26, w: 36, h: 26, dead: 0.20, live: 0.16 },
    { x: 0,   y: 52, w: 56, h: 26, dead: 0.18, live: 0.10 },
    { x: 56,  y: 52, w: 56, h: 26, dead: 0.20, live: 0.16 },
    { x: 112, y: 52, w: 36, h: 26, dead: 0.18, live: 0.12 },
  ];

  const t0 = performance.now();
  panels.forEach((p, i) => {
    const dead = document.createElementNS(NS, "rect");
    dead.setAttribute("x", String(p.x));
    dead.setAttribute("y", String(p.y));
    dead.setAttribute("width", String(p.w));
    dead.setAttribute("height", String(p.h));
    dead.setAttribute("fill", HEX_SCAN);
    dead.setAttribute("opacity", "0");
    dead.setAttribute("data-opt-transient", "load-dead");
    overlayLayer.appendChild(dead);

    const live = document.createElementNS(NS, "rect");
    live.setAttribute("x", String(p.x));
    live.setAttribute("y", String(p.y));
    live.setAttribute("width", String(p.w));
    live.setAttribute("height", String(p.h));
    live.setAttribute("fill", "#f59e0b"); // amber for live
    live.setAttribute("opacity", "0");
    live.setAttribute("data-opt-transient", "load-live");
    overlayLayer.appendChild(live);

    // Schedule fade-in roughly when the scan plane reaches that panel.
    const stagger = (p.y / 78) * dur * 0.85 + 80;
    setTimeout(() => {
      if (token !== _runToken) return;
      dead.style.transition = "opacity 380ms ease";
      live.style.transition = "opacity 380ms ease 80ms";
      dead.setAttribute("opacity", String(p.dead));
      live.setAttribute("opacity", String(p.live));
    }, stagger);
  });
}

function collectSvgScannables(svgEl) {
  // Selectable structural elements + slab outlines.
  const selectors = [
    ".layer-columns rect.column",
    ".layer-columns g.selectable",
    ".layer-beams line.beam",
    ".layer-walls line.shear-wall",
    ".layer-braces line.brace",
    ".layer-cores g.selectable",
    ".layer-slabs rect.slab-zone",
    ".layer-ncz g.selectable",
  ].join(",");
  const out = [];
  svgEl.querySelectorAll(selectors).forEach((el) => {
    let bbox;
    try { bbox = el.getBBox(); } catch { return; }
    if (!bbox) return;
    out.push({ el, bboxTop: bbox.y, bboxLeft: bbox.x, bbox });
  });
  return out;
}

function countScannableElements({ surfaceMode, svgEl, three }) {
  if (svgEl) return collectSvgScannables(svgEl).length || 1;
  if (three?.registry) return three.registry.allWithId().length || 1;
  return 1;
}

// 3D scan plane: a thin translucent box swept along world-Y from top
// to bottom of the structural bounds.
function startThreeScan({ token, dur, three, total, inspectorOverlay, cfg }) {
  const box = new THREE.Box3().setFromObject(three.structuralGroup);
  if (box.isEmpty()) return null;

  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  const planeGeom = new THREE.PlaneGeometry(size.x * 1.15, size.z * 1.15);
  planeGeom.rotateX(-Math.PI / 2);
  const planeMat = new THREE.MeshBasicMaterial({
    color: COLOR_SCAN,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const plane = new THREE.Mesh(planeGeom, planeMat);
  plane.position.set(center.x, box.max.y + 4, center.z);
  three.scene.add(plane);

  // Bright leading-edge ring (a thin slab just under the plane)
  const edgeGeom = new THREE.PlaneGeometry(size.x * 1.15, 0.4);
  edgeGeom.rotateX(-Math.PI / 2);
  const edgeMat = new THREE.MeshBasicMaterial({
    color: 0xbfdbfe, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const edge = new THREE.Mesh(edgeGeom, edgeMat);
  edge.position.copy(plane.position);
  three.scene.add(edge);

  // Dim every registered structural mesh by reducing material opacity.
  const meshes = three.registry?.allWithId() || [];
  const restorers = [];
  meshes.forEach((mesh) => {
    if (!mesh.material) return;
    const mat = mesh.material;
    const wasTransparent = mat.transparent;
    const prevOpacity = mat.opacity ?? 1;
    mat.transparent = true;
    restorers.push(() => {
      mat.transparent = wasTransparent;
      mat.opacity = prevOpacity;
      mat.needsUpdate = true;
    });
  });

  const t0 = performance.now();
  let scanned = 0;
  let rafId = 0;

  const yTop = box.max.y + 4;
  const yBot = box.min.y - 4;
  const distance = yTop - yBot;

  const pulsed = new WeakSet();

  const tick = () => {
    if (token !== _runToken) return;
    const t = Math.min((performance.now() - t0) / dur, 1);
    const y = yTop - distance * t;
    plane.position.y = y;
    edge.position.y = y - 0.05;

    // Pulse meshes whose centers we just crossed
    meshes.forEach((mesh) => {
      if (pulsed.has(mesh)) {
        // Apply dim factor to elements already scanned
        if (mesh.material && mesh.material.opacity > 0.41) {
          mesh.material.opacity = Math.max(0.4, mesh.material.opacity - 0.04);
          mesh.material.needsUpdate = true;
        }
        return;
      }
      const mb = new THREE.Box3().setFromObject(mesh);
      if (mb.isEmpty()) return;
      const mc = new THREE.Vector3(); mb.getCenter(mc);
      if (y <= mc.y) {
        pulsed.add(mesh);
        scanned += 1;
        setInspectorScanCounter(inspectorOverlay, scanned, total);
        // brief flash: bump opacity to 1, then settle to 0.4 over ~300ms
        if (mesh.material) {
          mesh.material.opacity = 1.0;
          mesh.material.needsUpdate = true;
        }
      }
    });

    three.requestRender();
    if (t < 1) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    three.scene.remove(plane);
    three.scene.remove(edge);
    planeGeom.dispose(); planeMat.dispose();
    edgeGeom.dispose(); edgeMat.dispose();
    restorers.forEach((fn) => fn());
    three.requestRender();
  };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2: Iterate
// ─────────────────────────────────────────────────────────────────────

async function runIteratePhase({ token, dur, surfaceMode, svgEl, three, cfg, inspectorOverlay, trayOverlay }) {
  const visibleIters = cfg.visibleIterations ?? 6;
  const perIter = dur / visibleIters;
  const total = cfg.totalIterations ?? 847;

  // Replace inspector body with metrics panel and start the iteration counter spinning.
  showInspectorMetrics(inspectorOverlay, cfg);
  const iterStart = performance.now();
  const iterCounter = startIterationCounterTicker({ token, dur, totalIterations: total, inspectorOverlay });
  _addCleanup(iterCounter.cancel);

  showTrayProgress(trayOverlay, cfg, dur);

  // Loads page: cycle the "Active combination" in the inspector
  let combinationCancel = null;
  if (cfg.pageId === "loads" && Array.isArray(cfg.combinationCycle) && cfg.combinationCycle.length) {
    combinationCancel = startCombinationCycle({ token, dur, cfg, inspectorOverlay });
  }
  if (combinationCancel) _addCleanup(combinationCancel);

  // Loads page: animate values in the load table inside the bottom tray.
  let tableCancel = null;
  if (cfg.pageId === "loads") {
    tableCancel = startLoadTableTicker({ token, dur, cfg });
  }
  if (tableCancel) _addCleanup(tableCancel);

  // Schemes page: accumulate scheme cards across the iterate phase.
  let filmstripCancel = null;
  if (cfg.pageId === "schemes" && cfg.schemeFilmstrip) {
    filmstripCancel = startSchemeFilmstrip({ token, dur, cfg, trayOverlay });
  }
  if (filmstripCancel) _addCleanup(filmstripCancel);

  // Iteration mutations: run `visibleIters` cycles. Each cycle picks a
  // subset of structural elements and tweens them to new transient
  // positions/sizes, with a mid-cycle flash.
  const svgEls = svgEl ? collectSvgScannables(svgEl) : [];
  const threeMeshes = three?.registry?.allWithId() || [];

  for (let i = 0; i < visibleIters; i++) {
    if (token !== _runToken) return;

    // Pick 30–40% of elements
    const fraction = 0.30 + Math.random() * 0.10;

    // SVG mutations
    if (svgEls.length) applySvgMutations({ token, els: svgEls, fraction, perIter, cfg });

    // 3D mutations
    if (threeMeshes.length) applyThreeMutations({ token, meshes: threeMeshes, fraction, perIter, three, cfg });

    // Update aggregate metrics for this iteration step
    pushMetricStep({ inspectorOverlay, cfg, stepIndex: i, totalSteps: visibleIters });

    // Mid-iteration flash (brief blue glow on changed elements)
    setTimeout(() => {
      if (token !== _runToken) return;
      svgEl?.classList.add("opt-flash");
      setTimeout(() => svgEl?.classList.remove("opt-flash"), 110);
    }, perIter * 0.85);

    await sleep(perIter, token);
  }
}

function applySvgMutations({ token, els, fraction, perIter, cfg }) {
  const tweenMs = Math.min(800, perIter * 0.8);
  els.forEach(({ el, bbox }) => {
    if (Math.random() > fraction) {
      // restore to baseline
      el.style.setProperty("--opt-dx", "0px");
      el.style.setProperty("--opt-dy", "0px");
      el.style.setProperty("--opt-scale", "1");
      return;
    }
    const isColumn = el.classList.contains("column") || el.closest(".layer-columns");
    const isBeam = el.classList.contains("beam");
    const isSlab = el.classList.contains("slab-zone");

    el.style.transition = `transform ${tweenMs}ms cubic-bezier(.4,0,.2,1), opacity 240ms ease, stroke-width 280ms ease`;
    el.classList.add("opt-mutating");

    let dx = 0, dy = 0, scale = 1;
    if (cfg.pageId === "sizing") {
      // Sizing keeps positions; vary stroke-width / scale to imply size change
      scale = 0.85 + Math.random() * 0.30;
      el.style.setProperty("--opt-stroke-bump", String((scale - 1).toFixed(2)));
    } else if (cfg.pageId === "schemes" && cfg.dramaticCrossfade) {
      // Wholesale layout swaps — bigger position deltas
      dx = (Math.random() - 0.5) * 12;
      dy = (Math.random() - 0.5) * 8;
    } else {
      // Placement / loads — small position shifts along grid
      const stepX = isBeam ? 6 : 4;
      const stepY = isBeam ? 4 : 3;
      dx = Math.round((Math.random() - 0.5) * 2) * stepX * 0.5;
      dy = Math.round((Math.random() - 0.5) * 2) * stepY * 0.5;
    }

    el.style.setProperty("--opt-dx", `${dx}px`);
    el.style.setProperty("--opt-dy", `${dy}px`);
    el.style.setProperty("--opt-scale", `${scale.toFixed(3)}`);

    // Schemes page: flicker visibility for "appears/disappears"
    if (cfg.pageId === "placement" && Math.random() < 0.18 && (isColumn || isBeam)) {
      el.style.opacity = "0.05";
      setTimeout(() => {
        if (token !== _runToken) return;
        el.style.opacity = "";
      }, tweenMs * 0.7);
    }
  });
}

function applyThreeMutations({ token, meshes, fraction, perIter, three, cfg }) {
  const tweenMs = Math.min(800, perIter * 0.8);
  meshes.forEach((mesh) => {
    // Snapshot base pose on first touch so resolve can restore exactly.
    if (!mesh.userData) mesh.userData = {};
    if (!mesh.userData.__optBasePos) {
      mesh.userData.__optBasePos = mesh.position.clone();
      mesh.userData.__optBaseScale = mesh.scale.clone();
    }
    if (Math.random() > fraction) return;
    const mat = mesh.material;
    const startEmissive = mat?.emissive?.getHex?.() ?? null;

    // Brief flash: blue emissive
    if (mat?.emissive) {
      mat.emissive.setHex(COLOR_SCAN);
      mat.emissiveIntensity = 0.6;
      mat.needsUpdate = true;
      setTimeout(() => {
        if (token !== _runToken) return;
        if (startEmissive != null) mat.emissive.setHex(startEmissive);
        mat.emissiveIntensity = 0;
        mat.needsUpdate = true;
        three.requestRender();
      }, 110);
    }

    // Position jitter for placement / schemes; scale jitter for sizing
    const targetPos = mesh.position.clone();
    const startPos = mesh.position.clone();
    const targetScale = mesh.scale.clone();
    const startScale = mesh.scale.clone();

    if (cfg.pageId === "sizing") {
      const s = 0.85 + Math.random() * 0.30;
      targetScale.set(s, s, s);
    } else if (cfg.pageId === "schemes" && cfg.dramaticCrossfade) {
      targetPos.x += (Math.random() - 0.5) * 12;
      targetPos.z += (Math.random() - 0.5) * 8;
    } else {
      targetPos.x += (Math.random() - 0.5) * 6;
      targetPos.z += (Math.random() - 0.5) * 4;
    }

    tweenMesh({ token, mesh, startPos, targetPos, startScale, targetScale, dur: tweenMs, three });
  });
}

function tweenMesh({ token, mesh, startPos, targetPos, startScale, targetScale, dur, three }) {
  const t0 = performance.now();
  const step = () => {
    if (token !== _runToken) return;
    const t = Math.min((performance.now() - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    mesh.position.lerpVectors(startPos, targetPos, eased);
    mesh.scale.lerpVectors(startScale, targetScale, eased);
    three.requestRender();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ─────────────────────────────────────────────────────────────────────
// Phase 3: Resolve
// ─────────────────────────────────────────────────────────────────────

async function runResolvePhase({ token, dur, surfaceMode, svgEl, three, cfg, inspectorOverlay, trayOverlay }) {
  // Settle (~600ms) — return everything to baseline transform/scale
  const els = svgEl ? collectSvgScannables(svgEl) : [];
  els.forEach(({ el }) => {
    el.style.transition = "transform 600ms cubic-bezier(.16,1,.3,1), opacity 320ms ease";
    el.style.setProperty("--opt-dx", "0px");
    el.style.setProperty("--opt-dy", "0px");
    el.style.setProperty("--opt-scale", "1");
    el.style.opacity = "";
  });

  const meshes = three?.registry?.allWithId() || [];
  meshes.forEach((mesh) => {
    const targetPos = mesh.userData?.__optBasePos || mesh.position.clone();
    const targetScale = mesh.userData?.__optBaseScale || new THREE.Vector3(1, 1, 1);
    tweenMesh({
      token,
      mesh,
      startPos: mesh.position.clone(),
      targetPos,
      startScale: mesh.scale.clone(),
      targetScale,
      dur: 600,
      three,
    });
  });

  await sleep(600, token);
  if (token !== _runToken) return;

  // Cascading wave — bottom-left → top-right based on bbox center
  const sortedSvg = els.slice().sort((a, b) => {
    const av = a.bbox.x + (a.bbox.y * -1); // bottom-left first
    const bv = b.bbox.x + (b.bbox.y * -1);
    return av - bv;
  });

  const totalCascade = Math.min(2200, dur - 600);
  const stagger = sortedSvg.length > 0 ? Math.min(70, totalCascade / Math.max(sortedSvg.length, 1)) : 50;

  sortedSvg.forEach((entry, i) => {
    setTimeout(() => {
      if (token !== _runToken) return;
      entry.el.classList.remove("opt-dim", "opt-mutating");

      // Sizing page: utilization color resolution
      if (cfg.pageId === "sizing" && cfg.utilizationColors) {
        const r = Math.random();
        if (r < 0.78) entry.el.classList.add("opt-resolved");        // green
        else if (r < 0.93) entry.el.classList.add("opt-resolved-warn"); // amber
        else entry.el.classList.add("opt-resolved-fail");                // red
      } else {
        entry.el.classList.add("opt-resolved");
      }

      // Brief checkmark popup over element center
      spawnCheckmark(entry, cfg);
    }, i * stagger);
  });

  // 3D cascade — sort by world position (x + z asc, y desc)
  const sortedMeshes = meshes.slice().sort((a, b) => {
    const ap = a.position.x + a.position.z - a.position.y * 0.5;
    const bp = b.position.x + b.position.z - b.position.y * 0.5;
    return ap - bp;
  });
  const meshStagger = sortedMeshes.length > 0 ? Math.min(40, totalCascade / Math.max(sortedMeshes.length, 1)) : 40;
  sortedMeshes.forEach((mesh, i) => {
    setTimeout(() => {
      if (token !== _runToken) return;
      const mat = mesh.material;
      if (!mat) return;
      const finalColor = pickResolveColor(cfg, mesh);
      mat.opacity = 1;
      if (mat.emissive) {
        mat.emissive.setHex(finalColor);
        mat.emissiveIntensity = 0.55;
        // Decay emissive after a moment so the resolved scene doesn't stay glowing.
        setTimeout(() => {
          if (token !== _runToken) return;
          if (mat.emissive) {
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 0;
          }
          three?.requestRender();
        }, 700);
      }
      mat.needsUpdate = true;
      three?.requestRender();
    }, i * meshStagger);
  });

  // Snap metric values to their final, fade in delta badges.
  finalizeInspectorMetrics(inspectorOverlay, cfg);

  // Schemes page: highlight winning card
  if (cfg.pageId === "schemes" && trayOverlay) {
    finalizeSchemeFilmstrip(trayOverlay);
  }

  // Loads page: flip "needs review" → "approved" inside the loads tray
  if (cfg.pageId === "loads") finalizeLoadsTable();

  // Sizing page: write final summary numbers ("Passing 94", etc.)
  if (cfg.pageId === "sizing") finalizeSizingSummary();

  // Crossfade tray back to its real content (we just remove the overlay)
  await sleep(Math.max(400, dur - 600), token);
}

function pickResolveColor(cfg, mesh) {
  if (cfg.pageId !== "sizing" || !cfg.utilizationColors) return COLOR_RESOLVE;
  const r = Math.random();
  if (r < 0.78) return COLOR_RESOLVE;
  if (r < 0.93) return COLOR_WARN;
  return COLOR_FAIL;
}

function spawnCheckmark(entry, cfg) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = entry.el.ownerSVGElement;
  if (!svg) return;
  const overlay = svg.querySelector(".layer-overlay");
  if (!overlay) return;
  const cx = entry.bbox.x + entry.bbox.width / 2;
  const cy = entry.bbox.y + entry.bbox.height / 2;
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "opt-check");
  g.setAttribute("data-opt-transient", "check");
  g.setAttribute("transform", `translate(${cx},${cy})`);
  g.innerHTML = `
    <circle r="2.6" fill="${HEX_RESOLVE}" fill-opacity="0.18"/>
    <path d="M-1.6 0 L-0.4 1.2 L1.7 -1.2" stroke="${HEX_RESOLVE}" stroke-width="0.55" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  `;
  overlay.appendChild(g);
  setTimeout(() => g.remove(), 420);
}

// ─────────────────────────────────────────────────────────────────────
// Inspector overlay (metrics panel, scan counter, deltas)
// ─────────────────────────────────────────────────────────────────────

function mountInspectorOverlay(cfg) {
  const inspector = document.querySelector(".inspector");
  if (!inspector) return null;

  inspector.dataset.optAnim = "1";
  const el = document.createElement("div");
  el.className = "opt-inspector-overlay";
  el.innerHTML = `
    <div class="opt-status">
      <span class="opt-status-dot"></span>
      <span class="opt-status-text">Analyzing structure…</span>
    </div>
    <div class="opt-counter">Elements scanned: <span data-opt-scan-counter>0</span> / <span data-opt-scan-total>—</span></div>
    <div class="opt-metrics" data-opt-metrics hidden></div>
  `;
  inspector.appendChild(el);

  // Inspector re-renders on many state events (page, selection, scheme,
  // sizing progress, geometry refresh) by overwriting innerHTML — which
  // would wipe our overlay. Keep ourselves alive with a MutationObserver.
  const observer = new MutationObserver(() => {
    if (!el.isConnected && inspector.isConnected) {
      inspector.appendChild(el);
      inspector.dataset.optAnim = "1";
    }
  });
  observer.observe(inspector, { childList: true });
  el.__optObserver = observer;
  el.__optHost = inspector;

  // Augment the cleanup chain.
  const origRemove = el.remove.bind(el);
  el.remove = () => {
    try { observer.disconnect(); } catch { /* ignore */ }
    delete inspector.dataset.optAnim;
    if (el.isConnected) origRemove();
  };
  return el;
}

function setInspectorScanCounter(overlay, scanned, total) {
  if (!overlay) return;
  const c = overlay.querySelector("[data-opt-scan-counter]");
  const t = overlay.querySelector("[data-opt-scan-total]");
  if (c) c.textContent = String(scanned);
  if (t) t.textContent = String(total);
}

function showInspectorMetrics(overlay, cfg) {
  if (!overlay) return;
  const counterRow = overlay.querySelector(".opt-counter");
  if (counterRow) counterRow.style.display = "none";
  const status = overlay.querySelector(".opt-status-text");
  if (status) status.textContent = cfg.iterationLabel || "Optimizing — evaluating configurations…";

  const metricsBox = overlay.querySelector("[data-opt-metrics]");
  if (!metricsBox) return;
  metricsBox.hidden = false;

  const m = cfg.metrics || [];
  metricsBox.innerHTML = m
    .map(
      (mc) => `
      <div class="opt-metric" data-opt-metric="${mc.key}">
        <span class="opt-metric-label">${mc.label}</span>
        <span class="opt-metric-value" data-opt-metric-value>${formatMetric(mc, mc.start)}</span>
        <span class="opt-spark" data-opt-spark></span>
        <span class="opt-delta" data-opt-delta hidden></span>
      </div>`,
    )
    .join("");

  // Initialize history with starting value so spark draws something.
  m.forEach((mc) => {
    overlay.querySelector(`[data-opt-metric="${mc.key}"]`).__history = [mc.start];
  });
}

function pushMetricStep({ inspectorOverlay, cfg, stepIndex, totalSteps }) {
  if (!inspectorOverlay) return;
  const m = cfg.metrics || [];
  m.forEach((mc) => {
    if (mc.isCounter) return; // iteration counter handles itself
    const row = inspectorOverlay.querySelector(`[data-opt-metric="${mc.key}"]`);
    if (!row) return;
    const t = (stepIndex + 1) / totalSteps;
    // Random walk that monotonically trends toward `end` while wiggling
    const baseline = mc.start + (mc.end - mc.start) * t;
    const wiggle = (mc.end - mc.start) * 0.12 * (Math.random() - 0.5);
    const next = baseline + wiggle;
    const history = row.__history || [];
    const prev = history[history.length - 1] ?? mc.start;
    history.push(next);
    if (history.length > 6) history.shift();
    row.__history = history;
    animateMetricValue(row, prev, next, mc, 600);
    drawSparkline(row.querySelector("[data-opt-spark]"), history, mc);
  });
}

function animateMetricValue(row, from, to, mc, dur) {
  const span = row.querySelector("[data-opt-metric-value]");
  if (!span) return;
  if (row.__rafCancel) row.__rafCancel();
  const t0 = performance.now();
  let cancelled = false;
  row.__rafCancel = () => { cancelled = true; };
  const tick = () => {
    if (cancelled) return;
    const t = Math.min((performance.now() - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 2);
    const v = from + (to - from) * eased;
    span.textContent = formatMetric(mc, v);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function formatMetric(mc, v) {
  if (typeof mc.format === "function") return mc.format(v);
  const unit = mc.unit ?? "";
  if (Number.isInteger(mc.start) && Number.isInteger(mc.end)) {
    return `${Math.round(v).toLocaleString()}${unit}`;
  }
  return `${Number(v).toFixed(1)}${unit}`;
}

function drawSparkline(host, values, mc) {
  if (!host) return;
  const w = 60, h = 18;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const trendDown = values[values.length - 1] < values[0];
  const stroke = trendDown ? HEX_RESOLVE : HEX_SCAN;
  host.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function startIterationCounterTicker({ token, dur, totalIterations, inspectorOverlay }) {
  // Find the iter row (configured with isCounter:true)
  const row = inspectorOverlay?.querySelector(`[data-opt-metric="iter"]`);
  if (!row) return { cancel: () => {} };
  const span = row.querySelector("[data-opt-metric-value]");
  let rafId;
  const t0 = performance.now();
  const tick = () => {
    if (token !== _runToken) return;
    const t = Math.min((performance.now() - t0) / dur, 1);
    // Use ease-out so it races early then settles — feels like sampling many configs fast.
    const eased = 1 - Math.pow(1 - t, 2.2);
    const v = Math.max(1, Math.round(eased * totalIterations));
    if (span) span.textContent = `${v.toLocaleString()} of ${totalIterations.toLocaleString()}`;
    if (t < 1) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
  return { cancel: () => cancelAnimationFrame(rafId) };
}

function finalizeInspectorMetrics(overlay, cfg) {
  if (!overlay) return;
  const m = cfg.metrics || [];
  const status = overlay.querySelector(".opt-status-text");
  if (status) status.textContent = "Optimization complete";
  overlay.classList.add("opt-resolved-state");
  m.forEach((mc) => {
    const row = overlay.querySelector(`[data-opt-metric="${mc.key}"]`);
    if (!row) return;
    const span = row.querySelector("[data-opt-metric-value]");
    if (span) span.textContent = formatMetric(mc, mc.end);
    if (mc.deltaText) {
      const delta = row.querySelector("[data-opt-delta]");
      if (delta) {
        delta.hidden = false;
        const trendDown = mc.end < mc.start;
        delta.textContent = mc.deltaText;
        delta.dataset.trend = trendDown ? "down" : "up";
        delta.style.opacity = "0";
        delta.style.transform = "translateY(4px)";
        setTimeout(() => {
          delta.style.transition = "opacity 280ms ease, transform 280ms ease";
          delta.style.opacity = "1";
          delta.style.transform = "translateY(0)";
        }, 80 + (cfg.metrics.indexOf(mc) * 90));
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Bottom tray overlay (progress bar + filmstrip)
// ─────────────────────────────────────────────────────────────────────

function mountTrayOverlay(cfg) {
  // Place the overlay over the tray host so the underlying tray cards
  // are visually replaced for the duration of the run.
  const trayHost =
    document.querySelector("[data-tray-host]") ||
    document.querySelector(".tray")?.parentElement;
  if (!trayHost) return null;

  trayHost.dataset.optAnim = "1";
  const el = document.createElement("div");
  el.className = "opt-tray-overlay";
  el.innerHTML = `
    <div class="opt-tray-row">
      <span class="opt-tray-label">${cfg.iterationLabel || "Optimizing — evaluating configurations…"}</span>
      <span class="opt-tray-pct" data-opt-tray-pct>0%</span>
    </div>
    <div class="opt-tray-bar"><div class="opt-tray-bar-fill" data-opt-tray-fill></div></div>
    <div class="opt-tray-cards" data-opt-tray-cards></div>
  `;
  trayHost.appendChild(el);

  // The bottom tray patches its host's innerHTML on most state events
  // (scheme cache, sizing progress, geometry, tray open/close). Survive
  // those re-renders the same way the inspector overlay does.
  const observer = new MutationObserver(() => {
    if (!el.isConnected && trayHost.isConnected) {
      trayHost.appendChild(el);
      trayHost.dataset.optAnim = "1";
    }
  });
  observer.observe(trayHost, { childList: true });

  const origRemove = el.remove.bind(el);
  el.remove = () => {
    try { observer.disconnect(); } catch { /* ignore */ }
    delete trayHost.dataset.optAnim;
    if (el.isConnected) origRemove();
  };
  return el;
}

function showTrayProgress(overlay, cfg, dur) {
  if (!overlay) return;
  const fill = overlay.querySelector("[data-opt-tray-fill]");
  const pct = overlay.querySelector("[data-opt-tray-pct]");
  const t0 = performance.now();
  const token = _runToken;
  const tick = () => {
    if (token !== _runToken) return;
    const t = Math.min((performance.now() - t0) / dur, 1);
    if (fill) fill.style.width = `${(t * 100).toFixed(1)}%`;
    if (pct) pct.textContent = `${Math.round(t * 100)}%`;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function startSchemeFilmstrip({ token, dur, cfg, trayOverlay }) {
  if (!trayOverlay) return null;
  const cards = trayOverlay.querySelector("[data-opt-tray-cards]");
  if (!cards) return null;
  const seed = cfg.schemeCards || [
    { name: "Balanced grid",       cols: 42, span: "31.8 ft" },
    { name: "Fewer columns",       cols: 36, span: "36.0 ft" },
    { name: "Shallow beams",       cols: 54, span: "27.5 ft" },
    { name: "Core-wall dominant",  cols: 44, span: "30.5 ft" },
    { name: "Long span",           cols: 32, span: "39.4 ft" },
  ];
  const interval = dur / (seed.length + 1);
  const timers = [];
  seed.forEach((s, i) => {
    const id = setTimeout(() => {
      if (token !== _runToken) return;
      const card = document.createElement("div");
      card.className = "opt-strip-card";
      card.dataset.optStripIndex = String(i);
      card.innerHTML = `
        <div class="opt-strip-card-name">${s.name}</div>
        <div class="opt-strip-card-stat"><span>${s.cols}</span><small>cols</small></div>
        <div class="opt-strip-card-stat"><span>${s.span}</span><small>max span</small></div>
      `;
      cards.appendChild(card);
      requestAnimationFrame(() => card.classList.add("is-in"));
    }, interval * (i + 1));
    timers.push(id);
  });
  return () => timers.forEach(clearTimeout);
}

function finalizeSchemeFilmstrip(trayOverlay) {
  if (!trayOverlay) return;
  const allCards = trayOverlay.querySelectorAll(".opt-strip-card");
  if (!allCards.length) return;
  // Pick a random non-first card as the recommendation for variety.
  const recIndex = allCards.length > 1 ? 1 : 0;
  allCards.forEach((c, i) => {
    if (i === recIndex) {
      c.classList.add("is-recommended");
      const chip = document.createElement("span");
      chip.className = "opt-strip-card-chip";
      chip.textContent = "AI Recommended";
      c.appendChild(chip);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Loads page helpers
// ─────────────────────────────────────────────────────────────────────

function startCombinationCycle({ token, dur, cfg, inspectorOverlay }) {
  // Find the inspector row whose label matches `combinationTargetLabel`.
  // The inspector renders detail-rows with "<span class='detail-label'>X</span>"
  // We mutate the sibling .detail-value text in place so it's clearly visible.
  const findRow = () => {
    const inspector = document.querySelector(".inspector");
    if (!inspector) return null;
    const labels = inspector.querySelectorAll(".detail-label");
    for (const lbl of labels) {
      if ((lbl.textContent || "").trim() === (cfg.combinationTargetLabel || "Active combination")) {
        return lbl.parentElement;
      }
    }
    return null;
  };

  const row = findRow();
  if (!row) return null;
  const valueEl = row.querySelector(".detail-value");
  if (!valueEl) return null;

  const original = valueEl.textContent;
  valueEl.dataset.optOriginal = original;
  valueEl.classList.add("opt-cycling");

  const cycle = cfg.combinationCycle;
  const stepMs = Math.max(380, dur / Math.max(cycle.length * 1.6, 1));
  let i = 0;
  let stop = false;
  const tick = () => {
    if (stop || token !== _runToken) return;
    valueEl.textContent = cycle[i % cycle.length];
    i += 1;
    setTimeout(tick, stepMs);
  };
  tick();

  return () => {
    stop = true;
    if (valueEl.isConnected) {
      valueEl.classList.remove("opt-cycling");
      valueEl.textContent = cfg.finalCombination || cycle[cycle.length - 1] || original;
      delete valueEl.dataset.optOriginal;
    }
  };
}

function startLoadTableTicker({ token, dur }) {
  // Animate `.tray-loads-num` values inside the bottom-tray. Each row
  // wiggles around its baseline and lands close to it on resolution.
  const nums = document.querySelectorAll(".tray-loads-num");
  if (!nums.length) return null;
  const records = [];
  nums.forEach((el) => {
    const m = (el.textContent || "").match(/([0-9.]+)\s*(.*)/);
    if (!m) return;
    records.push({ el, base: parseFloat(m[1]), unit: m[2].trim(), originalText: el.textContent });
  });
  if (!records.length) return null;

  const t0 = performance.now();
  let rafId = 0;
  const tick = () => {
    if (token !== _runToken) return;
    const t = Math.min((performance.now() - t0) / dur, 1);
    records.forEach(({ el, base, unit }) => {
      const wiggle = base * 0.18 * Math.sin(t * Math.PI * 6 + Math.random() * 0.4);
      const v = base + wiggle * (1 - t * 0.4);
      const fmt = base >= 10 ? Math.round(v) : v.toFixed(2);
      el.textContent = `${fmt} ${unit}`.trim();
    });
    if (t < 1) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    records.forEach(({ el, originalText }) => {
      if (el.isConnected) el.textContent = originalText;
    });
  };
}

function finalizeLoadsTable() {
  const chips = document.querySelectorAll(".tray-loads-row .status-chip");
  chips.forEach((chip) => {
    if (chip.textContent?.trim() === "needs review") {
      chip.classList.add("opt-flip-approved");
      chip.dataset.tone = "pass";
      chip.textContent = "approved";
    }
  });
  // Inspector: animate "Unapproved cases" down to 0 if visible.
  const inspector = document.querySelector(".inspector");
  if (!inspector) return;
  inspector.querySelectorAll(".detail-label").forEach((lbl) => {
    if ((lbl.textContent || "").trim() === "Unapproved cases") {
      const v = lbl.parentElement?.querySelector(".detail-value");
      if (v) v.textContent = "0";
    }
  });
}

function finalizeSizingSummary() {
  const inspector = document.querySelector(".inspector");
  if (!inspector) return;
  const setRow = (label, value, tone) => {
    inspector.querySelectorAll(".detail-label").forEach((lbl) => {
      if ((lbl.textContent || "").trim() === label) {
        const v = lbl.parentElement?.querySelector(".detail-value");
        if (!v) return;
        const start = 0;
        const end = parseInt(value, 10) || 0;
        const t0 = performance.now();
        const dur = 500;
        const tick = () => {
          const t = Math.min((performance.now() - t0) / dur, 1);
          v.textContent = String(Math.round(start + (end - start) * t));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        if (tone) v.dataset.tone = tone;
      }
    });
  };
  setRow("Passing", "94", "pass");
  setRow("Near capacity", "8", "warn");
  setRow("Failing", "0", "pass");
  inspector.querySelectorAll(".detail-label").forEach((lbl) => {
    if ((lbl.textContent || "").trim() === "Top issue") {
      const v = lbl.parentElement?.querySelector(".detail-value");
      if (v) v.textContent = "B21 (D/C 0.86)";
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────

function sleep(ms, token) {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(), ms);
    // Token check happens in callers — they bail when `_runToken` advances.
    // We don't clear the timer on cancel because resolved promises just go
    // unhandled, but we attach a one-shot listener for cleaner cancellation.
    void id;
  });
}
