/**
 * Placement compare modal — side-by-side metrics for the active
 * strategy vs. an alternate one. Includes a "Use this strategy" CTA
 * that promotes the alternate strategy to active.
 *
 * The modal is created on demand in the document body and torn down
 * on close; it doesn't subscribe to state, callers re-open it after
 * any state change that should refresh the view.
 */

import { state } from "../state.js";
import {
  getActiveStrategy,
  getStrategyById,
  selectStrategy,
} from "../placement/placement-binding.js";
import { toast } from "./toast.js";

let _root = null;

const ROWS = [
  { key: "columns",        label: "Columns" },
  { key: "beams",          label: "Beams" },
  { key: "shearWalls",     label: "Shear walls" },
  { key: "maxSpanFt",      label: "Max span",       suffix: " ft" },
  { key: "maxBeamDepthIn", label: "Max beam depth", suffix: " in" },
  { key: "avgBayFt",       label: "Avg bay",        suffix: " ft" },
  { key: "steelWeightTons",label: "Estimated steel",suffix: " t" },
  { key: "estimatedCostM", label: "Cost",           suffix: " M",   prefix: "$" },
  { key: "carbonTCO2",     label: "Carbon",         suffix: " tCO₂" },
];

export function openPlacementCompare(alternateId) {
  closePlacementCompare();
  const active = getActiveStrategy();
  const alt = getStrategyById(alternateId);
  if (!active || !alt) {
    toast("Could not open comparison.", { tone: "warn" });
    return;
  }

  const root = document.createElement("div");
  root.className = "placement-compare-overlay";
  root.innerHTML = renderModal(alt, active);
  document.body.appendChild(root);
  _root = root;

  // Click outside to dismiss
  root.addEventListener("click", (e) => {
    if (e.target === root) closePlacementCompare();
  });
  root.querySelector("[data-action='close-compare']").addEventListener("click", closePlacementCompare);
  root.querySelector("[data-action='use-strategy']").addEventListener("click", () => {
    selectStrategy(alt.id);
    toast(`${alt.name} set as active strategy.`);
    closePlacementCompare();
  });

  // Esc closes
  document.addEventListener("keydown", _onKey);
}

export function closePlacementCompare() {
  if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
  _root = null;
  document.removeEventListener("keydown", _onKey);
}

function _onKey(e) {
  if (e.key === "Escape") closePlacementCompare();
}

function renderModal(alt, active) {
  const altWarnings = alt.warnings.length;
  const activeWarnings = active.warnings.length;
  return `
    <div class="placement-compare-modal" role="dialog" aria-modal="true">
      <header class="placement-compare-head">
        <div>
          <p class="eyebrow">Compare strategies</p>
          <h2>${escape(alt.name)} <span class="vs">vs</span> ${escape(active.name)}</h2>
        </div>
        <button class="btn-icon" data-action="close-compare" aria-label="Close">×</button>
      </header>
      <div class="placement-compare-body">
        <div class="placement-compare-grid">
          <div class="placement-compare-col placement-compare-col--alt">
            <p class="eyebrow">Alternate</p>
            <h3>${escape(alt.name)}</h3>
            <p class="placement-compare-desc">${escape(alt.description)}</p>
          </div>
          <div class="placement-compare-col placement-compare-col--active">
            <p class="eyebrow">Active</p>
            <h3>${escape(active.name)}</h3>
            <p class="placement-compare-desc">${escape(active.description)}</p>
          </div>
        </div>
        <table class="placement-compare-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>${escape(alt.name)}</th>
              <th>${escape(active.name)}</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            ${ROWS.map((row) => renderRow(row, alt, active)).join("")}
            <tr>
              <td>Warnings</td>
              <td>${altWarnings}</td>
              <td>${activeWarnings}</td>
              <td>${formatDelta(altWarnings - activeWarnings, "")}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer class="placement-compare-foot">
        <button class="btn btn-ghost" data-action="close-compare">Cancel</button>
        <button class="btn btn-primary" data-action="use-strategy">Use this strategy</button>
      </footer>
    </div>
  `;
}

function renderRow(row, alt, active) {
  const a = alt[row.key];
  const b = active[row.key];
  const dispA = formatValue(a, row);
  const dispB = formatValue(b, row);
  const delta = (typeof a === "number" && typeof b === "number") ? a - b : null;
  return `
    <tr>
      <td>${row.label}</td>
      <td>${dispA}</td>
      <td>${dispB}</td>
      <td>${delta == null ? "—" : formatDelta(delta, row.suffix || "")}</td>
    </tr>
  `;
}

function formatValue(v, row) {
  if (v == null || Number.isNaN(v)) return "—";
  const prefix = row.prefix || "";
  const suffix = row.suffix || "";
  if (typeof v === "number") {
    const n = Math.abs(v) >= 100 ? Math.round(v) : (Math.round(v * 10) / 10);
    return `${prefix}${n}${suffix}`;
  }
  return `${prefix}${v}${suffix}`;
}

function formatDelta(diff, suffix) {
  if (diff === 0) return `<span class="delta delta--zero">—</span>`;
  const sign = diff > 0 ? "+" : "−";
  const tone = diff > 0 ? "delta--pos" : "delta--neg";
  const abs = Math.abs(diff);
  const rounded = abs >= 100 ? Math.round(abs) : (Math.round(abs * 10) / 10);
  return `<span class="delta ${tone}">${sign}${rounded}${suffix}</span>`;
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Hint to the bundler that we touch state here for symbol stability.
void state;
