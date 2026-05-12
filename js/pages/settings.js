import { mount } from "../utils/dom.js";
import { btn, detailRow } from "../utils/helpers.js";
import { projects } from "../data/mock-project.js";
import { state } from "../state.js";

const CARDS = [
  ["Project metadata", ["Davis, CA", "IBC 2021 / ASCE 7-16", "Steel composite"]],
  ["Codes and design basis", ["Risk Category II", "IBC 2021", "ASCE 7-16"]],
  ["Team", ["Harsh Grant — owner", "A. Patel — architecture", "M. Chen — reviewer"]],
  ["Export targets", ["Revit connection: connected", "ETABS v21", "IFC schema: IFC4"]],
  ["Assumption history", ["Apr 30 — live load approved", "Apr 30 — bearing pressure extracted", "Apr 29 — Site Class D imported"]],
  ["Firm defaults", ["Member library: Vellum standard", "Report template: preliminary structural"]],
];

export function renderSettings(host) {
  host.className = "stage workspace-stage";
  host.style.display = "";
  host.style.gridTemplateColumns = "";
  host.style.height = "";

  const project = projects.find((p) => p.id === state.projectId) || projects[0];
  mount(
    host,
    `<div class="table-page">
      <div class="section-head">
        <div><p class="eyebrow">Project settings</p><h2>${project.name}</h2><p>Project-level controls, connections, team access, and audit trail.</p></div>
      </div>
      <div class="settings-grid">
        ${CARDS.map(([title, rows]) => `<div class="settings-card"><h3>${title}</h3>${rows.map((r) => `<span>${r}</span>`).join("")}</div>`).join("")}
      </div>
    </div>
    <aside class="inspector">
      <div class="inspector-head"><div><p class="eyebrow">Workspace settings</p><h2 class="inspector-title">Connection summary</h2></div></div>
      <div class="inspector-body">
        <section class="inspector-section">
          <div class="detail-list">
            ${detailRow("Revit connection", "Connected", { tone: "pass" })}
            ${detailRow("Active export target", "Revit + ETABS")}
            ${detailRow("Team members", "3")}
            ${detailRow("Assumption log entries", "12")}
            ${detailRow("Last sync", "Today 12:06")}
          </div>
        </section>
      </div>
    </aside>`,
  );
}
