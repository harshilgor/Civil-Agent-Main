/**
 * Render orchestrator — owns the top-level shell, decides which page to
 * mount, and wires together the persistent panels.
 *
 * Persistent panels (sidebar, topbar, inspector) survive page changes so
 * they don't unmount/remount their state. The page area is the only thing
 * that gets swapped.
 */

import { state, on } from "./state.js";
import { mount, $ } from "./utils/dom.js";
import { mountSidebar } from "./components/sidebar.js";
import { mountTopbar } from "./components/topbar.js";
import { mountInspector } from "./components/inspector.js";

import { renderProjectsHome } from "./pages/projects.js";
import { renderNewProject } from "./pages/new-project.js";
import { renderProcessing, leaveProcessing } from "./pages/processing.js";
import { renderOverview, leaveOverview } from "./pages/overview.js";
import { renderCanvasPage, leaveCanvasPage } from "./pages/canvas-page.js";
import { renderAssumptions } from "./pages/assumptions.js";
import { renderVault } from "./pages/vault.js";
import { renderReports } from "./pages/reports.js";
import { renderSettings } from "./pages/settings.js";

let appHost;
let currentMode = null;
let currentPage = null;

let sidebarHandle = null;
let topbarHandle = null;
let inspectorHandle = null;

function buildWorkspaceShell() {
  appHost.innerHTML = `
    <main class="shell workspace-shell">
      <aside data-sidebar></aside>
      <section class="main">
        <header data-topbar></header>
        <div class="stage workspace-stage" data-stage></div>
      </section>
    </main>
  `;
  sidebarHandle = mountSidebar($("[data-sidebar]"));
  topbarHandle = mountTopbar($("[data-topbar]"));
}

function ensureWorkspaceShell() {
  if (currentMode !== "workspace") {
    leaveCurrent();
    buildWorkspaceShell();
    currentMode = "workspace";
    currentPage = null;
  }
}

function leaveCurrent() {
  if (currentMode === "processing") leaveProcessing();
  if (currentMode === "workspace") {
    if (currentPage === "overview") leaveOverview();
    if (["geometry", "placement", "loads", "schemes", "sizing"].includes(currentPage)) leaveCanvasPage();
  }
  sidebarHandle = topbarHandle = inspectorHandle = null;
}

function renderPage(stage) {
  const page = state.page;
  if (page === "overview") {
    leaveCanvasPage();
    renderOverview(stage);
    return null;
  }
  if (["geometry", "placement", "loads", "schemes", "sizing"].includes(page)) {
    const inspectorHost = renderCanvasPage(stage);
    return inspectorHost;
  }
  leaveCanvasPage();
  if (page === "assumptions") return renderAssumptions(stage);
  if (page === "vault") return renderVault(stage);
  if (page === "reports") return renderReports(stage);
  if (page === "settings") return renderSettings(stage);
  // Fallback
  renderOverview(stage);
  return null;
}

function renderRoot() {
  if (state.mode === "projects") {
    if (currentMode !== "projects") {
      leaveCurrent();
      currentMode = "projects";
      currentPage = null;
    }
    renderProjectsHome(appHost);
    return;
  }
  if (state.mode === "new-project") {
    if (currentMode !== "new-project") {
      leaveCurrent();
      currentMode = "new-project";
      currentPage = null;
    }
    renderNewProject(appHost);
    return;
  }
  if (state.mode === "processing") {
    if (currentMode !== "processing") {
      leaveCurrent();
      currentMode = "processing";
      currentPage = null;
    }
    renderProcessing(appHost);
    return;
  }
  if (state.mode === "workspace") {
    ensureWorkspaceShell();
    // Only re-render the stage when the page changes, not on every state change
    if (currentPage !== state.page) {
      const stage = $("[data-stage]");
      if (currentPage === "overview") leaveOverview();
      const inspectorHost = renderPage(stage);

      // For canvas pages, mount inspector inside the page; for table pages,
      // each page renders its own inspector markup. Workspace overview and
      // table pages don't use the shared inspector module, so we only mount
      // it on canvas pages.
      if (inspectorHandle?.dispose) inspectorHandle.dispose();
      if (inspectorHost) {
        inspectorHandle = mountInspector(inspectorHost);
      } else {
        inspectorHandle = null;
      }
      currentPage = state.page;
    }
  }
}

export function init(host) {
  appHost = host;
  on("mode", () => {
    currentPage = null; // force page re-render when mode changes
    renderRoot();
  });
  on("page", () => renderRoot());
  on("projectId", () => {
    if (state.mode === "workspace" && sidebarHandle) sidebarHandle.update();
  });
  renderRoot();
}
