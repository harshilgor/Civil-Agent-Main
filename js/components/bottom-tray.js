import { state, on, emit, ensurePlacementState } from "../state.js";
import { patch, on as delegate } from "../utils/dom.js";
import { icon } from "../utils/icons.js";
import { iconBtn } from "../utils/helpers.js";
import { createInitialLoadsState } from "../loads/load-engine.js";
import { startAnalysis, isAnalysisRunning, onAnalysisStateChange } from "../loads/load-runner.js";
import { toast } from "./toast.js";
import {
  getCachedScheme,
  getCachedSizing,
  listCachedSchemes,
} from "../canvas/scheme-adapter.js";
import {
  getCachedNormalizedGeometry,
  getCachedEnvelope,
  onGeometryChange,
} from "../canvas/parsed-geometry-cache.js";
import {
  startGeneration,
  resetGeneration,
  generationPhase,
  generationSteps,
  generationError,
  onGenerationStateChange,
} from "./scheme-generator.js";
import {
  startSizing,
  resetSizing,
  sizingPhase,
  sizingSteps,
  sizingError,
  sizingProgress,
  onSizingStateChange,
} from "./sizing-runner.js";
import { triggerOptimization } from "../canvas/optimization-presets.js";
import { isOptimizationRunning } from "../canvas/optimization-animation.js";
import { selectStrategy as selectPlacementStrategy } from "../placement/placement-binding.js";
import { openPlacementCompare } from "./placement-compare-modal.js";

const PAGES_WITH_TRAY = new Set([
  "geometry",
  "placement",
  "loads",
  "schemes",
  "sizing",
]);

// Material system options (must match MATERIAL_BAY_LIMITS keys in the engine)
const MATERIAL_SYSTEMS = [
  { value: "steel_composite",     label: "Steel composite" },
  { value: "steel_moment_frame",  label: "Steel moment frame" },
  { value: "concrete_flat_plate", label: "Concrete flat plate" },
  { value: "concrete_pan_joist",  label: "Concrete pan joist" },
  { value: "timber",              label: "Timber" },
];

const STEP_ICON = {
  pending:  "○",
  running:  "◎",
  complete: "✓",
  failed:   "✕",
};

function metricCell(value, label) {
  return `<span class="tray-metric"><span class="tray-metric-value">${value}</span><span class="tray-metric-label">${label}</span></span>`;
}

// ---------------------------------------------------------------------------
// Tray sections
// ---------------------------------------------------------------------------

function _confidencePct(value) {
  if (!Number.isFinite(value)) return null;
  // API confidence is 0..1; surface as a percentage for the user.
  return `${Math.round(value * 100)}%`;
}

function _meanConfidence(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const it of items) {
    if (Number.isFinite(it?.confidence)) {
      sum += it.confidence;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

function geometryTray() {
  const geom = getCachedNormalizedGeometry();
  const env = getCachedEnvelope();

  // No geometry resolved yet (offline / fixture / waiting on parse).
  if (!geom) {
    return `
      <div class="tray-card">
        <div class="tray-card-title"><span>Geometry</span></div>
        <div class="tray-card-big">—</div>
        <span class="tray-card-sub">${
          env?.parseStatus === "processing"
            ? "Parse still running"
            : "Awaiting parsed geometry"
        }</span>
      </div>
    `;
  }

  const overall = _confidencePct(env?.overallConfidence);
  const gridConf = _confidencePct(_meanConfidence(geom.gridLines));
  const coreConf = _confidencePct(_meanConfidence(geom.cores));
  const openingConf = _confidencePct(_meanConfidence(geom.openings));

  const cards = [
    [
      "Levels",
      String(geom.levels.length),
      overall ? `${overall} confidence` : "extracted",
    ],
    [
      "Grids",
      String(geom.gridLines.length),
      gridConf ? `${gridConf} confidence` : `${geom.gridLines.length} gridlines`,
    ],
    [
      "Cores",
      String(geom.cores.length),
      coreConf
        ? `${coreConf} confidence`
        : env?.reviewStatus === "accepted"
          ? "accepted"
          : "pending review",
    ],
    [
      "Openings",
      String(geom.openings.length),
      openingConf ? `${openingConf} confidence` : "extracted",
    ],
  ];

  const warnings = [
    ...(env?.apiWarnings ?? []),
    ...(env?.adapterWarnings ?? []),
  ].slice(0, 5); // surface at most 5 warning chips so the tray stays scannable

  return [
    ...cards.map(
      ([l, v, n]) => `<div class="tray-card">
        <div class="tray-card-title"><span>${l}</span></div>
        <div class="tray-card-big">${v}</div>
        <span class="tray-card-sub">${n}</span>
      </div>`,
    ),
    ...warnings.map(
      (w) => `<div class="tray-card" style="flex:0 0 240px"><div class="tray-card-warning">${icon("warning", 12)}<span>${escapeText(w)}</span></div></div>`,
    ),
  ].join("");
}

function escapeText(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function placementTray() {
  const placement = ensurePlacementState();
  const strategies = placement.strategies || [];
  const activeId = placement.activeStrategyId;
  if (!strategies.length) {
    return `<div class="tray-card">
      <div class="tray-card-title"><span>Placement</span></div>
      <div class="tray-card-big">—</div>
      <span class="tray-card-sub">Generating strategies…</span>
    </div>`;
  }
  return strategies
    .map((s) => {
      const isActive = s.id === activeId;
      const tone = s.warnings.length <= 2 ? "pass" : s.warnings.length <= 4 ? "warn" : "fail";
      const compare = isActive
        ? `<span class="tray-metric"><span class="tray-metric-value">★</span><span class="tray-metric-label">recommended</span></span>`
        : `<button class="placement-compare-btn" data-action="placement-compare" data-placement-strategy-id="${s.id}">Compare</button>`;
      return `
        <button class="tray-card placement-strategy-card ${isActive ? "is-active" : ""}" data-placement-strategy-id="${s.id}">
          <div class="tray-card-title">
            <span>${escapeText(s.name)}</span>
            <span class="status-dot" data-tone="${tone}"></span>
          </div>
          <span class="tray-card-sub">${isActive ? "Active strategy" : "Alternate strategy"}</span>
          <div class="tray-card-metrics">
            ${metricCell(s.columns, "columns")}
            ${metricCell(s.beams, "beams")}
            ${metricCell(`${s.maxSpanFt} ft`, "max span")}
            ${metricCell(s.warnings.length, s.warnings.length === 1 ? "warning" : "warnings")}
            ${compare}
          </div>
        </button>
      `;
    })
    .join("");
}

// Sizing-dependent metrics arrive in Agent 4. Until a scheme has been
// sized the tray surfaces "—" rather than fabricating a number —
// non-negotiable product rule.
const PENDING_SIZING = "—";

function fmtTonnage(value) {
  if (!Number.isFinite(value)) return PENDING_SIZING;
  return `${value.toFixed(1)} t`;
}

function fmtDepth(value) {
  if (!Number.isFinite(value)) return PENDING_SIZING;
  return `${value.toFixed(0)} in`;
}

function schemeCardsTray(cached) {
  return `
    <div class="tray-schemes-header">
      <span class="tray-schemes-count">${cached.length} variant${cached.length !== 1 ? "s" : ""}</span>
      <button class="btn btn--ghost btn--sm" data-action="regenerate-schemes">
        ${icon("reset", 12)}<span>Regenerate</span>
      </button>
    </div>
    ${cached.map((s) => {
      const m = s.metrics || {};
      const warningCount = m.warningCount ?? (m.warnings?.length || 0);
      const tone = warningCount <= 2 ? "pass" : warningCount <= 4 ? "warn" : "fail";
      const isActive = state.activeSchemeId === s.id;
      const sizingPh = sizingPhase(s.id);
      const sized = s.sizingStatus === "sized" || Number.isFinite(m.steelTonnage);
      const subParts = [];
      if (isActive) subParts.push("Active strategy");
      else if (s.status === "alternate") subParts.push("Alternate");
      else if (s.status) subParts.push(s.status);
      if (sizingPh === "running") subParts.push("Sizing…");
      else if (sized) subParts.push("Sized");
      else subParts.push("Layout-only");
      const maxSpan = Number.isFinite(m.maxSpan) ? `${m.maxSpan.toFixed(1)} ft` : PENDING_SIZING;
      const avgSpan = Number.isFinite(m.averageSpan) ? `${m.averageSpan.toFixed(1)} ft` : PENDING_SIZING;
      return `
      <button class="tray-card ${isActive ? "is-active" : ""}" data-scheme="${s.id}">
        <div class="tray-card-title">
          <span>Scheme ${s.displayLabel || ""} — ${s.name || s.strategy || ""}</span>
          <span class="status-dot" data-tone="${tone}"></span>
        </div>
        <span class="tray-card-sub">${subParts.join(" · ")}</span>
        <div class="tray-card-metrics">
          ${metricCell(m.columnCount ?? PENDING_SIZING, "columns")}
          ${metricCell(maxSpan, "max span")}
          ${metricCell(avgSpan, "avg span")}
          ${metricCell(m.uniqueBayPatterns ?? PENDING_SIZING, "bay patterns")}
          ${metricCell(fmtTonnage(m.steelTonnage), "steel")}
          ${metricCell(fmtDepth(m.maxBeamDepth), "max depth")}
          ${metricCell(m.uniqueSections ?? PENDING_SIZING, "sections")}
          ${metricCell(warningCount, warningCount === 1 ? "warning" : "warnings")}
        </div>
      </button>`;
    }).join("")}
  `;
}

function schemeGenerateCta() {
  const materialOptions = MATERIAL_SYSTEMS.map((m) =>
    `<option value="${m.value}">${m.label}</option>`,
  ).join("");

  return `
    <div class="tray-generate-panel">
      <div class="tray-generate-info">
        ${icon("wand", 16)}
        <div>
          <strong>No column layouts yet</strong>
          <span>Generate 5 structurally valid variants from the parsed geometry. Each uses a different bay-size strategy — pick the one that best fits the architectural intent.</span>
        </div>
      </div>
      <div class="tray-generate-form">
        <label class="tray-generate-field">
          <span>Material system</span>
          <select data-gen-material>
            ${materialOptions}
          </select>
        </label>
        <label class="tray-generate-field">
          <span>Target bay</span>
          <div class="tray-generate-bay-row">
            <input type="range" data-gen-bay min="16" max="45" value="30" step="1" />
            <span data-gen-bay-label class="tray-generate-bay-val">30 ft</span>
          </div>
        </label>
        <button class="btn btn--primary" data-action="generate-schemes">
          ${icon("wand", 14)}<span>Generate 5 variants</span>
        </button>
      </div>
    </div>
  `;
}

function schemeProgressTray() {
  const steps = generationSteps();
  const stepsHtml = steps.map((s) => `
    <div class="tray-gen-step tray-gen-step--${s.status}">
      <span class="tray-gen-step-icon">${STEP_ICON[s.status] || "○"}</span>
      <span class="tray-gen-step-label">${s.label}</span>
      ${s.detail ? `<span class="tray-gen-step-detail">${s.detail}</span>` : ""}
    </div>
  `).join("");

  const doneCount = steps.filter((s) => s.status === "complete").length;
  const pct = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0;

  return `
    <div class="tray-generate-panel tray-generate-panel--running">
      <div class="tray-generate-header">
        <strong>Generating column layouts…</strong>
        <span class="tray-gen-pct">${pct}%</span>
      </div>
      <div class="tray-gen-progress-bar">
        <div class="tray-gen-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="tray-gen-steps">
        ${stepsHtml}
      </div>
    </div>
  `;
}

function schemeCompleteTray() {
  return `
    <div class="tray-generate-panel tray-generate-panel--complete">
      <div class="tray-generate-header">
        <span class="status-dot" data-tone="pass"></span>
        <strong>Variants generated — loading…</strong>
      </div>
    </div>
  `;
}

function schemeErrorTray() {
  return `
    <div class="tray-generate-panel tray-generate-panel--error">
      <div class="tray-generate-info">
        <span class="status-dot" data-tone="fail"></span>
        <div>
          <strong>Generation failed</strong>
          <span>${generationError()}</span>
        </div>
      </div>
      <div class="tray-generate-form">
        <button class="btn btn--secondary" data-action="reset-generation">
          Dismiss
        </button>
        <button class="btn btn--primary" data-action="generate-schemes">
          ${icon("reset", 14)}<span>Try again</span>
        </button>
      </div>
    </div>
  `;
}

function schemesTray() {
  const phase = generationPhase();

  // Show progress / complete / error overlays first
  if (phase === "running")  return schemeProgressTray();
  if (phase === "complete") return schemeCompleteTray();
  if (phase === "error")    return schemeErrorTray();

  // Idle — show scheme cards or the generate CTA
  const cached = listCachedSchemes();
  return cached.length > 0 ? schemeCardsTray(cached) : schemeGenerateCta();
}

function loadsTray() {
  // Lazily initialize loads state
  if (!state.loads) {
    state.loads = createInitialLoadsState();
  }

  const loads = state.loads;
  const loadCases = loads.loadCases || [];
  const progress = loads.analysisProgress;
  const isAnalyzing = loads.isAnalyzing;
  const stale = loads.analysisStale;

  // Progress / stale banner
  let banner = "";
  if (isAnalyzing) {
    const pct = Math.round((progress.percent || 0) * 100);
    banner = `
      <div class="loads-analysis-banner">
        <span class="loads-analysis-label">${escapeText(progress.label)}</span>
        <span class="loads-analysis-count">${progress.current} / ${progress.total}</span>
        <div class="loads-analysis-bar">
          <div class="loads-analysis-fill" style="width:${pct}%"></div>
        </div>
      </div>`;
  } else if (stale && loads.loadResults?.maxColumnAxialKip > 0) {
    banner = `<div class="loads-stale-banner">Analysis results are stale — re-run to update</div>`;
  }

  const tableRows = loadCases.map((lc) => {
    const isSelected = loads.selectedLoadId === lc.id;
    const maxVal = lc.unit === "psf" ? 130 : lc.unit === "mph" ? 150 : lc.unit === "Sds" ? 1 : 200;
    const barPct = Math.min((lc.value / maxVal) * 100, 100).toFixed(0);
    const statusTone = lc.status === "approved" ? "pass" : lc.status === "draft" ? "warn" : "fail";
    const levelStr =
      !lc.appliesTo?.levels ? "—"
      : lc.appliesTo.levels.length === 6 ? "L1–L6"
      : lc.appliesTo.levels.length === 1 ? `L${lc.appliesTo.levels[0]}`
      : `L${lc.appliesTo.levels[0]}–L${lc.appliesTo.levels[lc.appliesTo.levels.length - 1]}`;
    const zoneStr = (lc.appliesTo?.zones || ["all"])[0];
    const appliesToStr = zoneStr === "all" ? levelStr : `${levelStr} · ${zoneStr}`;
    const isApproved = lc.status === "approved";
    const canDelete = lc.editable && lc.status === "draft";

    return `<div class="loads-table-row${isSelected ? " is-selected" : ""}" data-load-id="${lc.id}">
      <strong class="loads-col-name">${escapeText(lc.name)}</strong>
      <span class="loads-col-type loads-type-${lc.type}">${lc.type}</span>
      <span class="loads-col-value">
        <span class="loads-value-bar" style="width:${barPct}%"></span>
        <span class="loads-value-num">${lc.value} ${lc.unit}</span>
      </span>
      <span class="loads-col-zone">${escapeText(appliesToStr)}</span>
      <span class="status-chip" data-tone="${statusTone}">${lc.status}</span>
      <span class="loads-col-actions" data-stop-propagation>
        ${lc.editable ? `<button class="btn-icon" data-action="edit-load-case" data-load-id="${lc.id}" title="Edit">${icon("wand", 11)}</button>` : ""}
        ${isApproved
          ? `<button class="btn-icon" data-action="unapprove-load" data-load-id="${lc.id}" title="Set draft">${icon("warning", 11)}</button>`
          : `<button class="btn-icon loads-approve-btn" data-action="approve-load" data-load-id="${lc.id}" title="Approve">${icon("check", 11)}</button>`}
        ${canDelete ? `<button class="btn-icon loads-delete-btn" data-action="delete-load-case" data-load-id="${lc.id}" title="Delete">${icon("trash", 11)}</button>` : ""}
      </span>
    </div>`;
  }).join("");

  return `
    <div class="loads-tray-container">
      <div class="loads-tray-toolbar">
        <p class="eyebrow" style="margin:0;flex:1">Load Cases</p>
        ${banner}
        <button class="btn btn-secondary btn-sm" data-action="run-load-analysis-tray"${isAnalyzing ? " disabled" : ""}>
          ${icon("wand", 12)}<span>${isAnalyzing ? "Analyzing…" : "Run analysis"}</span>
        </button>
        <button class="btn btn-secondary btn-sm" data-action="add-load">
          ${icon("plus", 12)}<span>Add load</span>
        </button>
      </div>
      <div class="loads-tray-scroll">
        <div class="loads-table-head">
          <span>Case</span>
          <span>Type</span>
          <span>Value</span>
          <span>Applies To</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        <div class="loads-table-body">
          ${tableRows || '<div class="loads-empty-state">No load cases defined. Click "Add load" to begin.</div>'}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sizing tray (Agent 4)
//
// Shows one of four states for the active scheme:
//   - empty  — no scheme generated yet (kicks the user back to the
//              Schemes page)
//   - idle   — scheme exists but has not been sized yet (Run sizing CTA)
//   - running — live progress steps from the sizing-runner
//   - sized  — issue queue: members ranked by D/C, click to select on canvas
// ---------------------------------------------------------------------------

const STATUS_TONE = {
  fail: "fail",
  "near-capacity": "warn",
  efficient: "warn",
  pass: "pass",
  unsized: "warn",
};

function sizingRunningTray(schemeId) {
  const steps = sizingSteps(schemeId);
  const doneCount = steps.filter((s) => s.status === "complete").length;
  const totalCount = steps.length || 1;
  const fracFromSteps = doneCount / totalCount;
  const reportedFrac = sizingProgress(schemeId);
  const pct = Math.round(Math.max(fracFromSteps, reportedFrac) * 100);

  const stepsHtml = steps.map((s) => `
    <div class="tray-gen-step tray-gen-step--${s.status}">
      <span class="tray-gen-step-icon">${STEP_ICON[s.status] || "○"}</span>
      <span class="tray-gen-step-label">${s.label}</span>
      ${s.detail ? `<span class="tray-gen-step-detail">${s.detail}</span>` : ""}
    </div>
  `).join("");

  return `
    <div class="tray-generate-panel tray-generate-panel--running">
      <div class="tray-generate-header">
        <strong>Sizing scheme members…</strong>
        <span class="tray-gen-pct">${pct}%</span>
      </div>
      <div class="tray-gen-progress-bar">
        <div class="tray-gen-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="tray-gen-steps">
        ${stepsHtml}
      </div>
    </div>
  `;
}

function sizingErrorTray(schemeId) {
  return `
    <div class="tray-generate-panel tray-generate-panel--error">
      <div class="tray-generate-info">
        <span class="status-dot" data-tone="fail"></span>
        <div>
          <strong>Sizing failed</strong>
          <span>${sizingError(schemeId) || "Worker reported a calculation error."}</span>
        </div>
      </div>
      <div class="tray-generate-form">
        <button class="btn btn--secondary" data-action="reset-sizing">
          Dismiss
        </button>
        <button class="btn btn--primary" data-action="run-sizing">
          ${icon("reset", 14)}<span>Try again</span>
        </button>
      </div>
    </div>
  `;
}

function sizingIdleTray(scheme) {
  const m = scheme?.metrics || {};
  const beamCount = m.beamCount ?? "—";
  const columnCount = m.columnCount ?? "—";
  return `
    <div class="tray-generate-panel">
      <div class="tray-generate-info">
        ${icon("wand", 16)}
        <div>
          <strong>Run gravity load + member sizing</strong>
          <span>Compute D/C ratios for ${beamCount} beams and ${columnCount} columns under ASCE 7 / AISC LRFD. Uses project assumptions or hard-coded defaults.</span>
        </div>
      </div>
      <div class="tray-generate-form">
        <button class="btn btn--primary" data-action="run-sizing">
          ${icon("wand", 14)}<span>Run sizing analysis</span>
        </button>
      </div>
    </div>
  `;
}

function sizingResultsTray(schemeId) {
  const env = getCachedSizing(schemeId);
  const members = (env?.members || []).slice();
  if (members.length === 0) {
    return `
      <div class="tray-generate-panel">
        <div class="tray-generate-info">
          <span class="status-dot" data-tone="warn"></span>
          <div>
            <strong>No member data</strong>
            <span>The last sizing run produced no member checks. Re-run sizing to repopulate.</span>
          </div>
        </div>
        <div class="tray-generate-form">
          <button class="btn btn--primary" data-action="run-sizing">
            ${icon("reset", 14)}<span>Re-run sizing</span>
          </button>
        </div>
      </div>
    `;
  }

  // Highest-DCR first — these are the failing/near-capacity members the
  // engineer needs to triage first.
  members.sort((a, b) => (b?.dcr ?? 0) - (a?.dcr ?? 0));
  const top = members.slice(0, 12);

  const passCount  = members.filter((m) => m.status === "pass" || m.status === "efficient").length;
  const nearCount  = members.filter((m) => m.status === "near-capacity").length;
  const failCount  = members.filter((m) => m.status === "fail").length;
  const totalCount = members.length;

  const summary = `
    <div class="tray-schemes-header">
      <span class="tray-schemes-count">
        ${totalCount} sized · <span style="color:var(--text-secondary)">${passCount} pass · ${nearCount} near capacity · ${failCount} failing</span>
      </span>
      <button class="btn btn--ghost btn--sm" data-action="run-sizing">
        ${icon("reset", 12)}<span>Re-run sizing</span>
      </button>
    </div>
  `;

  const rows = top.map((m) => {
    const tone = STATUS_TONE[m.status] || (m.status === "fail" ? "fail" : "pass");
    const dcrFmt = Number.isFinite(m.dcr) ? m.dcr.toFixed(2) : "—";
    const govern = (m.governingCheck || "").replace(/_/g, " ");
    const size = m.selectedSize || "—";
    const action =
      m.status === "fail"          ? "Upsize section"
      : m.status === "near-capacity" ? "Review near-capacity"
      : m.status === "efficient"     ? "OK — efficient"
      : "OK";
    return `<button class="issue-row" data-select-type="${m.memberType}" data-select-id="${m.memberId}">
      <span class="status-dot" data-tone="${tone}"></span>
      <strong>${m.memberId}</strong>
      <span class="dcr">${dcrFmt}</span>
      <span>${size} · ${govern || "—"}</span>
      <span style="font-size:var(--text-xs);color:var(--text-secondary)">${action}</span>
    </button>`;
  }).join("");

  return `
    ${summary}
    <div class="issue-queue" style="width:100%">
      <div class="issue-row issue-head">
        <span></span>
        <strong>Member</strong>
        <span class="dcr">D/C</span>
        <span>Section · governing</span>
        <span>Suggested action</span>
      </div>
      ${rows}
    </div>
  `;
}

function sizingTray() {
  const cached = listCachedSchemes();
  if (cached.length === 0) {
    return `
      <div class="tray-generate-panel">
        <div class="tray-generate-info">
          ${icon("warning", 16)}
          <div>
            <strong>No schemes yet</strong>
            <span>Generate column-grid variants on the Schemes page before running sizing.</span>
          </div>
        </div>
      </div>
    `;
  }

  const schemeId = state.activeSchemeId || cached[0]?.id;
  const scheme = getCachedScheme(schemeId);
  const phase = sizingPhase(schemeId);

  if (phase === "running")  return sizingRunningTray(schemeId);
  if (phase === "error")    return sizingErrorTray(schemeId);

  // Idle / complete with cached results — show the issue queue if we
  // have data; otherwise show the run CTA.
  const hasData = !!getCachedSizing(schemeId);
  if (hasData) return sizingResultsTray(schemeId);
  return sizingIdleTray(scheme);
}

function trayContent() {
  const map = {
    geometry: geometryTray,
    placement: placementTray,
    loads: loadsTray,
    schemes: schemesTray,
    sizing: sizingTray,
  };
  const fn = map[state.page];
  return fn ? fn() : "";
}

function trayLabel() {
  return {
    geometry: "Geometry",
    placement: "Placement",
    loads: "Loads",
    schemes: "Schemes",
    sizing: "Sizing issues",
  }[state.page] || "Tray";
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(host) {
  if (!PAGES_WITH_TRAY.has(state.page)) {
    patch(host, "");
    host.style.display = "none";
    return;
  }
  host.style.display = "";

  if (!state.trayOpen) {
    patch(host, `<button class="tray-collapsed" data-action="toggle-tray">${icon("chevron_down", 12)}<span style="margin-left:6px">Open ${trayLabel().toLowerCase()} tray</span></button>`);
    return;
  }

  const isLoads = state.page === "loads";
  const markup = `
    <div class="tray${isLoads ? " tray--loads" : ""}">
      <div class="tray-head">
        <p class="eyebrow" style="margin:0">${trayLabel()}</p>
        ${iconBtn("chevron_down", { label: "Collapse tray", data: { action: "toggle-tray" } })}
      </div>
      <div class="tray-body${isLoads ? " tray-body--loads" : ""}">${trayContent()}</div>
    </div>
  `;
  patch(host, markup);
}

// ---------------------------------------------------------------------------
// Add / Edit load case modal
// ---------------------------------------------------------------------------

const LOAD_TYPES = ["dead", "live", "equipment", "wind", "seismic", "custom"];
const LOAD_UNITS = ["psf", "plf", "kip", "kip-ft", "mph", "Sds"];
const LOAD_CATEGORIES = ["gravity", "lateral", "point", "line", "area"];

function _loadCaseFormHtml(lc) {
  const typeOptions = LOAD_TYPES.map(
    (t) => `<option value="${t}"${lc?.type === t ? " selected" : ""}>${t}</option>`,
  ).join("");
  const unitOptions = LOAD_UNITS.map(
    (u) => `<option value="${u}"${lc?.unit === u ? " selected" : ""}>${u}</option>`,
  ).join("");
  const catOptions = LOAD_CATEGORIES.map(
    (c) => `<option value="${c}"${lc?.category === c ? " selected" : ""}>${c}</option>`,
  ).join("");

  return `
    <div class="loads-modal-form">
      <label class="field">
        <span class="field-label">Load name</span>
        <input class="input" name="name" value="${escapeText(lc?.name || "")}" placeholder="e.g. Dead Load" required />
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label class="field">
          <span class="field-label">Type</span>
          <select class="select" name="type">${typeOptions}</select>
        </label>
        <label class="field">
          <span class="field-label">Category</span>
          <select class="select" name="category">${catOptions}</select>
        </label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label class="field">
          <span class="field-label">Value</span>
          <input class="input" name="value" type="number" step="any" value="${lc?.value ?? ""}" placeholder="e.g. 50" required />
        </label>
        <label class="field">
          <span class="field-label">Unit</span>
          <select class="select" name="unit">${unitOptions}</select>
        </label>
      </div>
      <label class="field">
        <span class="field-label">Source</span>
        <input class="input" name="source" value="${escapeText(lc?.source || "")}" placeholder="e.g. IBC 2021 Table 1607.1" />
      </label>
      <label class="field">
        <span class="field-label">Applies to levels</span>
        <select class="select" name="levels">
          <option value="all"${(!lc || lc.appliesTo?.levels?.length === 6) ? " selected" : ""}>All levels (L1–L6)</option>
          <option value="roof"${lc?.appliesTo?.levels?.includes(6) && lc.appliesTo.levels.length === 1 ? " selected" : ""}>Roof only (L6)</option>
          <option value="ground"${lc?.appliesTo?.levels?.includes(1) && lc.appliesTo.levels.length === 1 ? " selected" : ""}>Ground only (L1)</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">Status</span>
        <select class="select" name="status">
          <option value="draft"${lc?.status === "draft" || !lc ? " selected" : ""}>Draft</option>
          <option value="approved"${lc?.status === "approved" ? " selected" : ""}>Approved</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <input class="input" name="description" value="${escapeText(lc?.description || "")}" placeholder="Optional note" />
      </label>
    </div>
  `;
}

function _saveLoadCaseFromForm(form, existingId) {
  const data = new FormData(form);
  const name = (data.get("name") || "").trim();
  const value = parseFloat(data.get("value"));
  if (!name || isNaN(value)) {
    toast("Name and value are required", { tone: "warn" });
    return false;
  }

  const levelsRaw = data.get("levels");
  const levels = levelsRaw === "roof" ? [6] : levelsRaw === "ground" ? [1] : [1, 2, 3, 4, 5, 6];

  const loadCase = {
    id: existingId || `custom-${Date.now()}`,
    name,
    type: data.get("type") || "dead",
    category: data.get("category") || "gravity",
    value,
    unit: data.get("unit") || "psf",
    source: data.get("source") || "",
    status: data.get("status") || "draft",
    editable: true,
    appliesTo: { levels, zones: ["all"] },
    description: data.get("description") || "",
  };

  if (!state.loads) state.loads = createInitialLoadsState();

  if (existingId) {
    const idx = state.loads.loadCases.findIndex((lc) => lc.id === existingId);
    if (idx >= 0) state.loads.loadCases[idx] = loadCase;
  } else {
    state.loads.loadCases.push(loadCase);
  }
  state.loads.analysisStale = true;
  emit("loads", state.loads, state.loads);
  toast(existingId ? `${name} updated` : `${name} added`);
  return true;
}

function _openAddLoadModal(existingId) {
  const existingLc = existingId && state.loads
    ? state.loads.loadCases.find((lc) => lc.id === existingId)
    : null;

  const modalTitle = existingLc ? `Edit — ${existingLc.name}` : "Add Load Case";
  const formId = "loads-modal-form";

  import("./modal.js").then(({ openModal, closeModal }) => {
    openModal({
      title: modalTitle,
      body: `<form id="${formId}">${_loadCaseFormHtml(existingLc)}</form>`,
      footer: `
        <button class="btn btn-secondary" id="loads-modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="loads-modal-save">${existingLc ? "Save changes" : "Add load case"}</button>
      `,
    });

    const saveBtn = document.getElementById("loads-modal-save");
    const cancelBtn = document.getElementById("loads-modal-cancel");
    const form = document.getElementById(formId);

    if (saveBtn && form) {
      saveBtn.addEventListener("click", () => {
        if (_saveLoadCaseFromForm(form, existingId)) closeModal();
      });
    }
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  });
}

// Expose for inspector to use
export { _openAddLoadModal as openAddLoadModal };

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const boundHosts = new WeakSet();

export function mountBottomTray(host) {
  if (!boundHosts.has(host)) {
    boundHosts.add(host);

    // Toggle tray open/close
    delegate(host, "click", "[data-action='toggle-tray']", () => {
      state.trayOpen = !state.trayOpen;
    });

    // Select a scheme from the card list
    delegate(host, "click", "[data-scheme]", (_e, target) => {
      const id = target.dataset.scheme;
      state.activeSchemeId = id;
      const cached = listCachedSchemes().find((s) => s.id === id);
      const label = cached?.displayLabel || cached?.name || "selected";
      toast(`Scheme ${label} selected`);
    });

    // Kick off scheme generation (from CTA or retry button)
    delegate(host, "click", "[data-action='generate-schemes']", (e) => {
      e.stopPropagation();
      if (generationPhase() === "running") return;
      // Read form values if the CTA form is visible
      const panel = host.querySelector(".tray-generate-panel");
      const matSel = panel?.querySelector("[data-gen-material]");
      const bayInput = panel?.querySelector("[data-gen-bay]");
      const constraints = matSel ? {
        materialSystem: matSel.value,
        targetBay: bayInput ? Number(bayInput.value) : 30,
      } : null;
      startGeneration(constraints);
      if (!isOptimizationRunning()) triggerOptimization("schemes");
    });

    // Regenerate (re-run from schemes card list)
    delegate(host, "click", "[data-action='regenerate-schemes']", (e) => {
      e.stopPropagation();
      if (generationPhase() === "running") return;
      startGeneration(null);  // use default constraints
      if (!isOptimizationRunning()) triggerOptimization("schemes");
    });

    // Dismiss error
    delegate(host, "click", "[data-action='reset-generation']", () => {
      resetGeneration();
    });

    // Trigger sizing for the active scheme
    delegate(host, "click", "[data-action='run-sizing']", (e) => {
      e.stopPropagation();
      const schemeId = state.activeSchemeId;
      if (!schemeId) {
        // Without a scheme we can't run real sizing, but we still fire
        // the visual optimization so the user sees the AI think.
        if (!isOptimizationRunning()) triggerOptimization("sizing");
        return;
      }
      if (sizingPhase(schemeId) === "running") return;
      startSizing(schemeId);
      if (!isOptimizationRunning()) triggerOptimization("sizing");
    });

    // Dismiss a sizing error
    delegate(host, "click", "[data-action='reset-sizing']", (e) => {
      e.stopPropagation();
      const schemeId = state.activeSchemeId;
      if (schemeId) resetSizing(schemeId);
    });

    // ── Placement strategy switching ───────────────────────────
    // The card itself switches the active strategy; the inner Compare
    // button is intercepted first so a "compare" click never silently
    // promotes the alternate strategy.
    delegate(host, "click", "[data-action='placement-compare']", (e, target) => {
      e.stopPropagation();
      e.preventDefault();
      const id = target.dataset.placementStrategyId;
      if (id) openPlacementCompare(id);
    });
    delegate(host, "click", "[data-placement-strategy-id]", (e, target) => {
      // If the click came from the inner Compare button, the listener
      // above already handled it (and stopped propagation).
      if (target.matches("[data-action='placement-compare']")) return;
      const id = target.dataset.placementStrategyId;
      if (id) selectPlacementStrategy(id);
    });

    // Issue queue row → select member on canvas
    delegate(host, "click", "[data-select-type]", (_e, target) => {
      state.selectedObject = {
        type: target.dataset.selectType,
        id: target.dataset.selectId,
      };
    });

    // Live-update the bay label as the slider moves
    delegate(host, "input", "[data-gen-bay]", (e) => {
      const lbl = host.querySelector("[data-gen-bay-label]");
      if (lbl) lbl.textContent = `${e.target.value} ft`;
    });
  }

  // ── Loads tray interactions ─────────────────────────────────────────

  // Run analysis from tray button
  delegate(host, "click", "[data-action='run-load-analysis-tray']", (e) => {
    e.stopPropagation();
    if (isAnalysisRunning()) return;
    if (!state.loads) state.loads = createInitialLoadsState();
    startAnalysis();
    // Also fire the optimization overlay
    import("../canvas/optimization-presets.js").then(({ triggerOptimization }) => {
      import("../canvas/optimization-animation.js").then(({ isOptimizationRunning }) => {
        if (!isOptimizationRunning()) triggerOptimization("loads");
      });
    });
  });

  // Select a load case row
  delegate(host, "click", ".loads-table-row", (e, target) => {
    // Prevent click bubbling from inner action buttons
    if (e.target.closest("[data-stop-propagation]")) return;
    if (e.target.closest("button")) return;
    const id = target.dataset.loadId;
    if (!id || !state.loads) return;
    state.loads.selectedLoadId = id === state.loads.selectedLoadId ? null : id;
    emit("loads", state.loads, state.loads);
    // Also set selectedObject so inspector reacts
    if (state.loads.selectedLoadId) {
      state.selectedObject = { type: "load", id };
    } else {
      state.selectedObject = null;
    }
  });

  // Approve a load case
  delegate(host, "click", "[data-action='approve-load']", (e, target) => {
    e.stopPropagation();
    const id = target.dataset.loadId;
    if (!id || !state.loads) return;
    const lc = state.loads.loadCases.find((c) => c.id === id);
    if (lc) {
      lc.status = "approved";
      state.loads.analysisStale = true;
      emit("loads", state.loads, state.loads);
      toast(`${lc.name} approved`);
    }
  });

  // Unapprove / set back to draft
  delegate(host, "click", "[data-action='unapprove-load']", (e, target) => {
    e.stopPropagation();
    const id = target.dataset.loadId;
    if (!id || !state.loads) return;
    const lc = state.loads.loadCases.find((c) => c.id === id);
    if (lc) {
      lc.status = "draft";
      state.loads.analysisStale = true;
      emit("loads", state.loads, state.loads);
      toast(`${lc.name} set to draft`);
    }
  });

  // Delete a load case
  delegate(host, "click", "[data-action='delete-load-case']", (e, target) => {
    e.stopPropagation();
    const id = target.dataset.loadId;
    if (!id || !state.loads) return;
    const idx = state.loads.loadCases.findIndex((c) => c.id === id);
    if (idx >= 0) {
      const name = state.loads.loadCases[idx].name;
      state.loads.loadCases.splice(idx, 1);
      if (state.loads.selectedLoadId === id) {
        state.loads.selectedLoadId = null;
        state.selectedObject = null;
      }
      state.loads.analysisStale = true;
      emit("loads", state.loads, state.loads);
      toast(`${name} removed`);
    }
  });

  // Edit load case — open modal
  delegate(host, "click", "[data-action='edit-load-case']", (e, target) => {
    e.stopPropagation();
    const id = target.dataset.loadId;
    if (!id || !state.loads) return;
    state.loads.selectedLoadId = id;
    state.selectedObject = { type: "load", id };
    emit("loads", state.loads, state.loads);
    _openAddLoadModal(id);
  });

  // Add load — trigger from tray
  delegate(host, "click", "[data-action='add-load']", (e) => {
    e.stopPropagation();
    if (!state.loads) state.loads = createInitialLoadsState();
    _openAddLoadModal();
  });

  const update = () => render(host);
  const unsubs = [];
  unsubs.push(on("page", update));
  unsubs.push(on("trayOpen", update));
  unsubs.push(on("activeSchemeId", update));
  unsubs.push(on("selectedObject", update));
  unsubs.push(on("placement", update));
  unsubs.push(on("loads", update));
  // Re-render tray when generation state changes (progress, complete, error)
  unsubs.push(onGenerationStateChange(update));
  // Re-render when any scheme's sizing run advances or finishes
  unsubs.push(onSizingStateChange(update));
  // Re-render when parsed geometry resolves so the geometry tab
  // surfaces real counts + warnings.
  unsubs.push(onGeometryChange(update));
  // Re-render when analysis state changes
  unsubs.push(onAnalysisStateChange(update));

  update();

  return {
    update,
    dispose: () => unsubs.forEach((fn) => fn()),
  };
}
