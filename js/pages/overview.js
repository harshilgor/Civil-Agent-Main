import { mount, on as delegate } from "../utils/dom.js";
import { metric, btn } from "../utils/helpers.js";
import { state } from "../state.js";
import { navigateToPage } from "../router.js";
import { CanvasController } from "../canvas/canvas-controller.js";

const STEPS = [
  { id: "geometry", label: "Geometry", state: "done", meta: "Reviewed" },
  { id: "assumptions", label: "Assumptions", state: "done", meta: "5 of 7 approved" },
  { id: "placement", label: "Placement", state: "done", meta: "Scheme A" },
  { id: "loads", label: "Loads", state: "done", meta: "Combinations ready" },
  { id: "schemes", label: "Schemes", state: "done", meta: "5 generated" },
  { id: "sizing", label: "Sizing", state: "active", meta: "1 fail · 2 warn" },
  { id: "reports", label: "Reports", state: "todo", meta: "Pending" },
];

const ACTIONS = [
  ["Review 3 extracted assumptions", "assumptions"],
  ["Resolve 1 failing shear wall", "sizing"],
  ["Generate member schedule", "reports"],
  ["Export Revit package", "reports"],
];

const ACTIVITY = [
  ["Scheme A recalculated from Assumption Set v3.", "12 min ago"],
  ["SW2 flagged as failing E-W shear check.", "18 min ago"],
  ["Geotechnical report sent bearing pressure to assumptions.", "Today"],
  ["Equipment schedule marked for engineer review.", "Today"],
];

let canvas = null;
let isBound = false;

export function renderOverview(host) {
  host.className = "stage";
  mount(
    host,
    `<div class="overview-grid">
      <div class="overview-main">
        <section class="metric-strip">
          ${metric("Active scheme", "Scheme A", "Balanced strategy")}
          ${metric("Pending assumptions", "3", "1 high-impact extraction")}
          ${metric("Critical issues", "1 fail", "SW2 shear check")}
          ${metric("Vault review", "4 items", "Geotech + MEP")}
          ${metric("Last recalculated", "12m", state.recalculating ? "Running..." : "Ready")}
        </section>
        <div class="overview-canvas-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Model preview</p>
              <h2>Current structural workspace</h2>
            </div>
            <div class="section-head-actions">
              ${btn("Open geometry", { variant: "secondary", size: "sm", data: { page: "geometry" } })}
            </div>
          </div>
          <div data-overview-canvas></div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h3 class="panel-title">Recent activity</h3>
          </div>
          <div class="activity-list">
            ${ACTIVITY.map(([t, time]) => `<div class="activity-item"><strong>${t}</strong><span>${time}</span></div>`).join("")}
          </div>
        </div>
      </div>
      <aside class="overview-side">
        <section class="panel">
          <div class="panel-header"><h3 class="panel-title">Next actions</h3></div>
          <div class="action-list">
            ${ACTIONS.map(
              ([t, page]) => `<button class="action-line" data-page="${page}"><span>${t}</span><span class="chip">${page}</span></button>`,
            ).join("")}
          </div>
        </section>
        <section class="panel">
          <div class="panel-header"><h3 class="panel-title">Workflow</h3></div>
          <div class="workflow">
            ${STEPS.map(
              (s) => `<div class="workflow-step" data-state="${s.state}">
                <span class="workflow-dot"></span>
                <span class="workflow-label">${s.label}</span>
                <span class="workflow-meta">${s.meta}</span>
              </div>`,
            ).join("")}
          </div>
        </section>
      </aside>
    </div>`,
  );

  // Embed a small canvas preview
  const cvHost = host.querySelector("[data-overview-canvas]");
  if (cvHost) {
    cvHost.style.height = "300px";
    cvHost.classList.add("canvas-frame");
    if (canvas) canvas.unmount();
    canvas = new CanvasController(cvHost);
    canvas.mount();
    state.viewMode = "3d";
  }

  if (!isBound) {
    isBound = true;
    delegate(host, "click", "[data-page]", (_e, target) => {
      navigateToPage(target.dataset.page);
    });
  }
}

export function leaveOverview() {
  if (canvas) {
    canvas.unmount();
    canvas = null;
  }
}
