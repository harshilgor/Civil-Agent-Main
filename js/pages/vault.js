import { mount, on as delegate, escapeHtml } from "../utils/dom.js";
import { btn, statusChip, detailRow } from "../utils/helpers.js";
import { vaultDocuments } from "../data/mock-vault.js";
import { state } from "../state.js";

const TABS = [
  ["documents", "Documents"],
  ["insights", "Extracted insights"],
  ["pending", "Pending review"],
];

let isBound = false;

function selectedDoc() {
  return vaultDocuments.find((d) => d.id === state.selectedDocumentId) || vaultDocuments[0];
}

const boundHosts = new WeakSet();

function tableMarkup() {
  if (state.vaultTab === "insights") {
    const items = vaultDocuments.flatMap((d) =>
      d.insights.map((t) => ({ docId: d.id, name: d.name, text: t })),
    );
    return `<div style="padding:var(--space-md)">${items
      .map(
        (i) => `<button class="action-line" data-doc="${i.docId}" style="height:auto;padding:12px 8px;flex-direction:column;align-items:flex-start;gap:4px"><strong style="color:var(--text-primary)">${escapeHtml(i.text)}</strong><span style="color:var(--text-tertiary);font-size:var(--text-xs)">${escapeHtml(i.name)}</span></button>`,
      )
      .join("")}</div>`;
  }
  if (state.vaultTab === "pending") {
    const items = vaultDocuments.filter((d) => d.reviewStatus === "needs_review");
    return `<div style="padding:var(--space-md)">${items
      .map(
        (d) => `<button class="action-line" data-doc="${d.id}" style="height:auto;padding:12px 8px;flex-direction:column;align-items:flex-start;gap:4px"><strong style="color:var(--text-primary)">${escapeHtml(d.name)}</strong><span style="color:var(--text-tertiary);font-size:var(--text-xs)">${escapeHtml(d.insights[0])}</span></button>`,
      )
      .join("")}</div>`;
  }
  return `<div class="table-scroll"><table class="table">
    <thead>
      <tr>
        <th>Name</th><th>Category</th><th>Source</th><th>Version</th><th>Updated</th><th>AI status</th><th>Referenced by</th>
      </tr>
    </thead>
    <tbody>
      ${vaultDocuments
        .map(
          (d) => `<tr data-doc="${d.id}" class="${state.selectedDocumentId === d.id ? "is-active" : ""}">
        <td class="cell-primary">${escapeHtml(d.name)}</td>
        <td>${escapeHtml(d.category)}</td>
        <td>${escapeHtml(d.source)}</td>
        <td class="cell-mono">${escapeHtml(d.version)}</td>
        <td>${escapeHtml(d.updatedAt)}</td>
        <td>${statusChip(d.aiStatus)}</td>
        <td>${escapeHtml(d.referencedBy)}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table></div>`;
}

function inspectorMarkup() {
  const d = selectedDoc();
  return `<div class="inspector-head"><div><p class="eyebrow">Vault context</p><h2 class="inspector-title">${escapeHtml(d.name)}</h2></div></div>
    <div class="inspector-body">
      <section class="inspector-section">
        <div class="detail-list">
          ${detailRow("Category", d.category)}
          ${detailRow("Version", d.version)}
          ${detailRow("File type", d.fileType)}
          ${detailRow("AI status", d.aiStatus)}
          ${detailRow("Review", d.reviewStatus.replace(/_/g, " "))}
          ${detailRow("Referenced by", d.referencedBy)}
        </div>
      </section>
      <div class="reasoning-note">${escapeHtml(d.insights.join(" "))}</div>
      <div class="inspector-actions">
        ${btn("Mark reviewed", { variant: "primary", block: true })}
        ${btn("Preview", { variant: "secondary", block: true })}
        ${btn("Replace version", { variant: "secondary", block: true })}
        ${btn("Download", { variant: "secondary", block: true })}
      </div>
    </div>`;
}

export function renderVault(host) {
  host.className = "stage workspace-stage";
  host.style.display = "";
  host.style.gridTemplateColumns = "";
  host.style.height = "";

  mount(
    host,
    `<div class="table-page">
      <div class="section-head">
        <div><p class="eyebrow">Project Vault</p><h2>Project knowledge layer</h2><p>Documents, extracted insights, and pending review items.</p></div>
        ${btn("Upload context", { variant: "primary", size: "sm", icon: "plus" })}
      </div>
      <div class="tabs">
        ${TABS.map(([id, label]) => `<button class="tab ${state.vaultTab === id ? "is-active" : ""}" data-vault-tab="${id}">${label}</button>`).join("")}
      </div>
      <div class="table-frame" data-vault-table>${tableMarkup()}</div>
    </div>
    <aside class="inspector" data-inspector>${inspectorMarkup()}</aside>`,
  );

  if (boundHosts.has(host)) return;
  boundHosts.add(host);

  if (isBound) return;
  isBound = true;

  delegate(host, "click", "[data-vault-tab]", (_e, target) => {
    state.vaultTab = target.dataset.vaultTab;
    host.querySelector("[data-vault-table]").innerHTML = tableMarkup();
    host.querySelectorAll("[data-vault-tab]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.vaultTab === state.vaultTab),
    );
  });
  delegate(host, "click", "[data-doc]", (_e, target) => {
    state.selectedDocumentId = target.dataset.doc;
    host.querySelector("[data-vault-table]").innerHTML = tableMarkup();
    host.querySelector("[data-inspector]").innerHTML = inspectorMarkup();
  });
}
