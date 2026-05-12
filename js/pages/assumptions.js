import { mount, on as delegate, escapeHtml } from "../utils/dom.js";
import { btn, statusChip, detailRow } from "../utils/helpers.js";
import { assumptions } from "../data/mock-assumptions.js";
import { state } from "../state.js";
import { mountInspector } from "../components/inspector.js";
import { toast } from "../components/toast.js";

let inspectorHandle = null;
let isBound = false;

function tableMarkup() {
  return `<div class="table-frame">
    <div class="section-head" style="padding:var(--space-lg) var(--space-lg) 0">
      <div>
        <p class="eyebrow">Assumptions</p>
        <h2>Engineering control panel</h2>
        <p>Every deterministic calculation is tied to reviewed assumptions and source documents.</p>
      </div>
      <div class="section-head-actions">
        ${btn("Approve low-risk", { variant: "secondary", size: "sm", data: { action: "approve-low" } })}
        ${btn("Snapshot", { variant: "secondary", size: "sm" })}
        ${btn("Recalculate", { variant: "secondary", size: "sm", data: { action: "recalculate" } })}
      </div>
    </div>
    <div class="table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th>Group</th>
            <th>Label</th>
            <th>Value</th>
            <th>Source</th>
            <th>Status</th>
            <th>Affects</th>
          </tr>
        </thead>
        <tbody>
          ${assumptions
            .map(
              (a) => `
            <tr data-assumption="${a.id}" class="${state.selectedAssumptionId === a.id ? "is-active" : ""}">
              <td>${escapeHtml(a.category)}</td>
              <td class="cell-primary">${escapeHtml(a.label)}</td>
              <td class="cell-mono cell-primary">${escapeHtml(a.value)} ${escapeHtml(a.units || "")}</td>
              <td>${escapeHtml(a.source)}</td>
              <td>${statusChip(a.status)}</td>
              <td>${escapeHtml(a.affects)}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function inspectorMarkup() {
  const a = assumptions.find((x) => x.id === state.selectedAssumptionId) || assumptions[0];
  const tone = a.status === "approved" ? "pass" : a.status === "needs_review" ? "warn" : "default";
  return `
    <div class="inspector-head">
      <div>
        <p class="eyebrow">Selected assumption</p>
        <h2 class="inspector-title">${escapeHtml(a.label)}</h2>
      </div>
    </div>
    <div class="inspector-body">
      <section class="inspector-section">
        <div class="detail-list">
          ${detailRow("Value", `${a.value} ${a.units || ""}`)}
          ${detailRow("Source", a.source)}
          ${detailRow("Source document", a.sourceDocumentId || "None")}
          ${detailRow("Status", a.status, { tone })}
          ${detailRow("Affects", a.affects)}
          ${detailRow("Last changed", `${a.lastChangedBy} · ${a.lastChangedAt}`)}
        </div>
      </section>
      <div class="reasoning-note">This value is used by load generation, scheme ranking, sizing checks, and reports. Review status controls downstream readiness.</div>
      <div class="inspector-actions">
        ${btn("Approve", { variant: "primary", block: true, data: { action: "approve-assumption" } })}
        ${btn("Edit", { variant: "secondary", block: true })}
        ${btn("Reject extracted value", { variant: "secondary", block: true })}
        ${btn("Open source document", { variant: "secondary", block: true, data: { page: "vault" } })}
      </div>
    </div>
  `;
}

const boundHosts = new WeakSet();

export function renderAssumptions(host) {
  host.className = "stage workspace-stage";
  host.style.display = "";
  host.style.gridTemplateColumns = "";
  host.style.height = "";
  mount(
    host,
    `<div class="table-page">
      <div data-table></div>
    </div>
    <aside class="inspector" data-inspector></aside>`,
  );

  host.querySelector("[data-table]").innerHTML = tableMarkup();
  host.querySelector("[data-inspector]").innerHTML = inspectorMarkup();

  if (boundHosts.has(host)) return;
  boundHosts.add(host);

  if (isBound) return;
  isBound = true;

  delegate(host, "click", "[data-assumption]", (_e, target) => {
    state.selectedAssumptionId = target.dataset.assumption;
    host.querySelector("[data-table]").innerHTML = tableMarkup();
    host.querySelector("[data-inspector]").innerHTML = inspectorMarkup();
  });
  delegate(host, "click", "[data-action='approve-assumption']", () => {
    const a = assumptions.find((x) => x.id === state.selectedAssumptionId);
    if (a) a.status = "approved";
    host.querySelector("[data-table]").innerHTML = tableMarkup();
    host.querySelector("[data-inspector]").innerHTML = inspectorMarkup();
    toast("Assumption approved");
  });
  delegate(host, "click", "[data-action='approve-low']", () => toast("Low-risk defaults approved"));
  delegate(host, "click", "[data-action='recalculate']", () => toast("Recalculation queued"));
}

export function leaveAssumptions() {
  inspectorHandle = null;
}
