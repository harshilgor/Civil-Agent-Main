/**
 * Shared "canvas page" — used by Geometry, Placement, Loads, Schemes, Sizing.
 *
 * Layout:
 *   ┌─────────────────────────┬───────────┐
 *   │ canvas + tray (column)  │ inspector │
 *   └─────────────────────────┴───────────┘
 *
 * Wraps a CanvasController and hosts the bottom tray. The inspector and
 * sidebar are mounted at the workspace shell level and update reactively.
 */

import { mount } from "../utils/dom.js";
import { CanvasController } from "../canvas/canvas-controller.js";
import { mountBottomTray } from "../components/bottom-tray.js";
import { cancelOptimization } from "../canvas/optimization-animation.js";
import { triggerOptimization } from "../canvas/optimization-presets.js";
import { state } from "../state.js";

let canvas = null;
let trayHandle = null;
let demoTimer = null;

const DEMO_PAGES = new Set(["placement", "loads", "schemes", "sizing"]);

function isDemoMode() {
  if (typeof window === "undefined") return false;
  if (window.CIVILAGENT_DEMO_MODE === true) return true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") return true;
  } catch { /* ignore */ }
  return false;
}

export function renderCanvasPage(host) {
  host.className = "stage workspace-stage";
  mount(
    host,
    `<div class="canvas-column" data-tray="open">
      <div class="canvas-page-body" data-canvas-host></div>
      <div data-tray-host></div>
    </div>
    <div data-inspector-host></div>`,
  );

  const cvHost = host.querySelector("[data-canvas-host]");
  if (canvas) canvas.unmount();
  canvas = new CanvasController(cvHost);
  canvas.mount();

  const trayHost = host.querySelector("[data-tray-host]");
  if (trayHandle?.dispose) trayHandle.dispose();
  trayHandle = mountBottomTray(trayHost);

  // DEMO_MODE: auto-fire the optimization animation shortly after the
  // canvas mounts on one of the four AI pages. Canvas takes ~600ms to
  // settle (Three.js mount + first paint); waiting longer keeps the
  // first scan readable on a screen recording.
  if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  if (isDemoMode() && DEMO_PAGES.has(state.page)) {
    demoTimer = setTimeout(() => {
      demoTimer = null;
      triggerOptimization(state.page);
    }, 1200);
  }

  return host.querySelector("[data-inspector-host]");
}

export function leaveCanvasPage() {
  cancelOptimization();
  if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  if (canvas) {
    canvas.unmount();
    canvas = null;
  }
  if (trayHandle?.dispose) trayHandle.dispose();
  trayHandle = null;
}
