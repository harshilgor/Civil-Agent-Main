/**
 * CivilAgent — entry point.
 *
 * Loads the modular architecture, initializes the router, and mounts the
 * persistent UI components (toasts, modals, command palette, assistant).
 */

import { init as initRender } from "./render.js";
import { initRouter } from "./router.js";
import { initToasts } from "./components/toast.js";
import { initModals } from "./components/modal.js";
import { initCommandPalette } from "./components/command-palette.js";
import { initAssistantDrawer } from "./components/assistant-drawer.js";
import { state } from "./state.js";
import { navigateToPage } from "./router.js";

const root = document.getElementById("app");
if (!root) {
  throw new Error("CivilAgent: #app host not found");
}

initToasts();
initModals();
initCommandPalette();
initAssistantDrawer();
initRender(root);
initRouter();

// Global keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  const isInput = ["input", "textarea", "select"].includes(
    (document.activeElement?.tagName || "").toLowerCase(),
  );

  if ((e.metaKey || e.ctrlKey) && key === "k") {
    e.preventDefault();
    state.cmdkOpen = true;
    return;
  }
  if (e.key === "Escape") {
    if (state.cmdkOpen) state.cmdkOpen = false;
    if (state.assistantOpen) state.assistantOpen = false;
    if (state.showLayers) state.showLayers = false;
    return;
  }

  if (isInput) return;

  if (state.mode !== "workspace") return;

  // Page numbers
  const pageMap = {
    1: "overview", 2: "geometry", 3: "assumptions", 4: "placement",
    5: "loads", 6: "schemes", 7: "sizing", 8: "vault", 9: "reports",
  };
  if (pageMap[e.key]) {
    e.preventDefault();
    navigateToPage(pageMap[e.key]);
    return;
  }

  if (e.key === " ") {
    e.preventDefault();
    state.viewMode = state.viewMode === "3d" ? "2d" : "3d";
  } else if (key === "g") {
    state.layers = { ...state.layers, grids: !state.layers.grids };
  } else if (key === "l") {
    state.layers = { ...state.layers, labels: !state.layers.labels };
  } else if (e.key === "[") {
    // Previous level — wrap-around handled in components
  } else if (e.key === "]") {
    // Next level
  }
});
