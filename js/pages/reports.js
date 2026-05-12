import { mount, on as delegate, escapeHtml } from "../utils/dom.js";
import { btn, statusChip, detailRow } from "../utils/helpers.js";
import { reports } from "../data/mock-vault.js";
import { state } from "../state.js";
import { toast } from "../components/toast.js";

const PRESETS = [
  ["Internal review package", "Engineer-of-record review"],
  ["Client concept package", "For owner / architect review"],
  ["EOR review package", "Final pre-stamp"],
];

let isBound = false;

export function renderReports(host) {
  host.className = "stage workspace-stage";
  host.style.display = "";
  host.style.gridTemplateColumns = "";
  host.style.height = "";

  mount(
    host,
    `<div class="table-page">
      <div class="section-head">
        <div><p class="eyebrow">Reports</p><h2>Preliminary deliverables</h2><p>Generated from the active scheme, approved assumptions, sizing checks, and Vault context.</p></div>
        ${btn("Generate package", { variant: "primary", size: "sm", icon: "plus", data: { action: "generate-package" } })}
      </div>
      <div class="np-grid-3">
        ${PRESETS.map(
          ([t, sub]) => `<button class="card card-interactive">
            <strong style="color:var(--text-primary);font-size:var(--text-sm);font-weight:500">${t}</strong>
            <span style="color:var(--text-tertiary);font-size:var(--text-xs);margin-top:4px">${sub}</span>
          </button>`,
        ).join("")}
      </div>
      <div class="table-frame">
        <div class="table-scroll"><table class="table">
          <thead><tr><th>Report</th><th>Status</th><th>Last generated</th><th>Missing inputs</th><th></th></tr></thead>
          <tbody>
            ${reports
              .map(
                (r) => `<tr>
              <td class="cell-primary">${escapeHtml(r.name)}<br><span style="color:var(--text-tertiary);font-size:var(--text-xs);font-weight:400">${escapeHtml(r.includedSources)}</span></td>
              <td>${statusChip(r.status)}</td>
              <td>${escapeHtml(r.lastGeneratedAt)}</td>
              <td style="color:var(--text-tertiary)">${escapeHtml(r.missingInputs)}</td>
              <td>${btn("Generate", { variant: "secondary", size: "sm", data: { action: "generate-report", report: r.id } })}</td>
            </tr>`,
              )
              .join("")}
          </tbody>
        </table></div>
      </div>
    </div>
    <aside class="inspector">
      <div class="inspector-head"><div><p class="eyebrow">Report package</p><h2 class="inspector-title">Export status</h2></div></div>
      <div class="inspector-body">
        <section class="inspector-section">
          <div class="detail-list">
            ${detailRow("Generated reports", "2")}
            ${detailRow("Pending reports", "5")}
            ${detailRow("Unresolved assumptions", "1")}
            ${detailRow("Referenced Vault docs", "8")}
            ${detailRow("Active scheme used", `Scheme ${state.activeSchemeId}`)}
            ${detailRow("Format", "PDF + browser preview")}
          </div>
        </section>
        <div class="reasoning-note">Report copy is preliminary and for engineer review. CivilAgent does not produce final stamped construction documents.</div>
      </div>
    </aside>`,
  );

  if (boundHosts.has(host)) return;
  boundHosts.add(host);

  if (isBound) return;
  isBound = true;
  delegate(host, "click", "[data-action='generate-package']", () => toast("Package generation queued"));
  delegate(host, "click", "[data-action='generate-report']", () => toast("Report generated"));
}

const boundHosts = new WeakSet();
