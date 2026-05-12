import { state, on, emit, ensurePlacementState } from "../state.js";
import { patch, on as delegate } from "../utils/dom.js";
import { icon } from "../utils/icons.js";
import { btn, detailRow } from "../utils/helpers.js";
import { createInitialLoadsState } from "../loads/load-engine.js";
import { startAnalysis, isAnalysisRunning, onAnalysisStateChange } from "../loads/load-runner.js";
import { openAddLoadModal } from "./bottom-tray.js";
import { columns, beams, shearWalls, braces } from "../data/mock-members.js";
import {
  cores as mockCores,
  noColumnZones as mockNoColumnZones,
  gridLines as mockGridLines,
  slabZones as mockSlabZones,
} from "../data/mock-project.js";
import {
  getCachedScheme,
  getCachedSizing,
  getMemberSizingSummary,
  listCachedSchemes,
  setActiveScheme,
} from "../canvas/scheme-adapter.js";
import {
  getCachedNormalizedGeometry,
  getCachedEnvelope,
  getPlanGeometry,
  acceptGeometry,
  onGeometryChange,
} from "../canvas/parsed-geometry-cache.js";
import { dcrToStatus } from "../data/constants.js";
import {
  onSizingStateChange,
  startSizing,
  sizingPhase,
} from "./sizing-runner.js";
import { toast } from "./toast.js";
import { triggerOptimization } from "../canvas/optimization-presets.js";
import { isOptimizationRunning } from "../canvas/optimization-animation.js";
import {
  getActiveStrategy as getPlacementActiveStrategy,
  selectStrategy as selectPlacementStrategy,
  toggleTool as togglePlacementTool,
  regenerateActiveStrategy as regeneratePlacementStrategy,
  clearManualOverrides as clearPlacementManualOverrides,
  deleteManualElement as deletePlacementManualElement,
  selectPlacementElement,
} from "../placement/placement-binding.js";

// Sizing-dependent metrics arrive in Agent 4. Until then the inspector
// surfaces "—" rather than fabricating a number.
const PENDING = "—";

function fmtNum(value, suffix = "") {
  if (value == null || !Number.isFinite(value)) return PENDING;
  return `${value}${suffix}`;
}

function fmtMetric(metric, key, suffix = "") {
  if (!metric) return PENDING;
  return fmtNum(metric[key], suffix);
}

const TITLES = {
  overview: "Project overview",
  geometry: "Geometry summary",
  placement: "Placement strategy",
  loads: "Load path",
  schemes: "Scheme",
  sizing: "Member checks",
};

/**
 * Map sizing/scheme statuses → tone keys the legacy CSS recognises.
 * Backend can emit any of: pass | efficient | near-capacity | fail | unsized.
 * The detailRow tone vocabulary is just pass | warn | fail.
 */
function statusTone(status) {
  if (status === "fail") return "fail";
  if (status === "near-capacity" || status === "warn") return "warn";
  if (status === "efficient") return "warn";
  if (status === "pass") return "pass";
  return "warn"; // unsized / unknown — neutral
}

/**
 * Resolve the selected object. Resolution order:
 *
 *   1. Real scheme + sizing caches (Agent 3 + Agent 4 source of truth)
 *      for column / beam selections.
 *   2. Parsed-geometry cache for cores / grids / NCZs / slabs — we
 *      adapt the cache shape into the legacy detailRow vocabulary so
 *      `coreInspector`, `gridInspector`, etc. don't need rewriting.
 *   3. Bundled mocks as a fallback so legacy demo projects still
 *      surface meaningful data when no API is available.
 */
function findObject(type, id) {
  // Load case selection — look up from state.loads
  if (type === "load") {
    return state.loads?.loadCases?.find((lc) => lc.id === id) ?? null;
  }

  if (type === "column" || type === "beam") {
    const real = findRealMember(type, id);
    if (real) return real;
  }

  const fromCache = findRealGeometry(type, id);
  if (fromCache) return fromCache;

  const sources = {
    column: columns,
    beam: beams,
    shearWall: shearWalls,
    brace: braces,
    core: mockCores,
    noColumnZone: mockNoColumnZones,
    grid: mockGridLines,
    slab: mockSlabZones,
  };
  return (sources[type] || []).find((o) => o.id === id);
}

/**
 * Resolve cores / grids / NCZs / slabs from the parsed-geometry
 * cache and adapt them into the field shapes the legacy inspector
 * subviews already render (`coreInspector`, `gridInspector`, etc.).
 *
 * Returns `null` when:
 *   - the cache is empty (no parsed geometry yet), or
 *   - the requested id isn't in the cache (fall back to mocks).
 */
function findRealGeometry(type, id) {
  const plan = getPlanGeometry();
  if (!plan) return null;

  if (type === "core") {
    const c = plan.cores.find((x) => x.id === id);
    if (!c) return null;
    return {
      id: c.id,
      type: c.type || "—",
      levels: c.levelIds?.length ? c.levelIds.join(", ") : "—",
      conflicts: "None",
      __real: true,
    };
  }
  if (type === "noColumnZone") {
    const z = plan.noColumnZones.find((x) => x.id === id);
    if (!z) return null;
    return {
      id: z.id,
      name: z.name,
      reason: z.reason || "—",
      source: z.source || "ifc",
      __real: true,
    };
  }
  if (type === "grid") {
    const g = plan.gridLines.find((x) => x.id === id);
    if (!g) return null;
    return {
      id: g.id,
      label: g.label,
      axis: g.axis,
      coordinate: typeof g.coordinate === "number"
        ? `${g.coordinate.toFixed(1)} ft`
        : g.coordinate,
      confidence: Number.isFinite(g.confidence)
        ? `${Math.round(g.confidence * 100)}%`
        : "—",
      locked: false,
      __real: true,
    };
  }
  if (type === "slab") {
    const s = plan.slabZones.find((x) => x.id === id);
    if (!s) return null;
    return {
      id: s.id,
      system: "Floor plate",
      thickness: "—",
      loadPsf: "—",
      status: "pass",
      __real: true,
    };
  }
  return null;
}

/**
 * Build the inspector's beam/column row from real scheme data. Returns
 * `null` when the scheme cache doesn't have a member with that id —
 * lets the legacy mock lookup take over.
 *
 * The returned shape matches what `beamInspector()` / `columnInspector()`
 * already consume so we don't have to fork the renderers.
 */
function findRealMember(type, id) {
  const schemeId = state.activeSchemeId;
  if (!schemeId) return null;
  const scheme = getCachedScheme(schemeId);
  if (!scheme) return null;

  const collection = type === "column" ? scheme.columns : scheme.beams;
  const member = (collection || []).find((m) => m.id === id);
  if (!member) return null;

  const sized = getMemberSizingSummary(schemeId, id);
  // Pull governing/all checks for richer detail rendering.
  const status = sized?.status || dcrToStatus(sized?.dcr ?? null);

  if (type === "beam") {
    const span = Number.isFinite(member.span) ? `${member.span.toFixed(1)} ft` : "—";
    const fmtCheck = (suffix, fallback) => {
      const c = sized?.allChecks?.find((x) => x.checkType === suffix);
      if (!c) return fallback;
      const unit = c.demandUnit ? ` ${c.demandUnit}` : "";
      return `${c.demand.toFixed(c.demandUnit === "in" ? 2 : 0)}${unit}`;
    };
    return {
      id: member.id,
      __real: true,
      __memberType: "beam",
      __sized: sized || null,
      span,
      tributaryWidth: "—", // engine doesn't echo trib width on the summary; details endpoint exposes it
      uniformLoad: "—",
      momentDemand: fmtCheck("flexure", "—"),
      shearDemand: fmtCheck("shear", "—"),
      governingCheck: sized?.governingCheck ? sized.governingCheck.replace(/_/g, " ") : "Not sized",
      size: sized?.selectedSize || member.size || "—",
      dcr: typeof sized?.dcr === "number" ? sized.dcr : 0,
      status,
    };
  }

  // Column
  return {
    id: member.id,
    __real: true,
    __memberType: "column",
    __sized: sized || null,
    gridLabel: member.gridLabel || "—",
    startLevel: member.startLevel,
    endLevel: member.endLevel,
    size: sized?.selectedSize || member.size || "—",
    tributaryArea: "—", // populated from the takedown; rendered below if available
    axialLoad: "—",
    dcr: typeof sized?.dcr === "number" ? sized.dcr : 0,
    status,
    source: member.source || "generated",
    locked: !!member.locked,
  };
}

function selectedObjectInspector(type, obj) {
  if (type === "beam") return beamInspector(obj);
  if (type === "column") return columnInspector(obj);
  if (type === "shearWall") return wallInspector(obj);
  if (type === "core") return coreInspector(obj);
  if (type === "grid") return gridInspector(obj);
  if (type === "slab") return slabInspector(obj);
  if (type === "noColumnZone") return zoneInspector(obj);
  if (type === "load") return emptyInspector(); // handled via loadsPageInspector on loads page
  return `<pre>${JSON.stringify(obj, null, 2)}</pre>`;
}

function beamInspector(b) {
  if (b.__real) return realBeamInspector(b);
  const tone = b.status === "fail" ? "fail" : b.status === "warn" ? "warn" : "pass";

  const resolutions = state.page === "sizing"
    ? `
      <p class="eyebrow" style="margin:16px 0 8px">Suggested actions</p>
      <div class="resolution-list">
        <button class="resolution-row" data-action="apply-resolution" data-resolution="upsize">
          <strong>Increase to W21x57</strong>
          <span>Brings D/C to 0.78 · +13 lb/ft</span>
        </button>
        <button class="resolution-row" data-action="apply-resolution" data-resolution="midspan">
          <strong>Add support at midspan</strong>
          <span>Reduces effective span to 15.9 ft</span>
        </button>
        <button class="resolution-row" data-action="apply-resolution" data-resolution="deeper">
          <strong>Allow deeper beam</strong>
          <span>W24x55 at D/C 0.71 · +3 in depth</span>
        </button>
        <button class="resolution-row" data-action="apply-resolution" data-resolution="reframe">
          <strong>Change framing direction</strong>
          <span>Reframe N–S, span drops to 28 ft</span>
        </button>
      </div>`
    : "";

  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Selected size", b.size)}
        ${detailRow("Span", b.span)}
        ${detailRow("Tributary width", b.tributaryWidth)}
        ${detailRow("Uniform load", b.uniformLoad)}
        ${detailRow("Moment demand", b.momentDemand)}
        ${detailRow("Shear demand", b.shearDemand)}
        ${detailRow("Governing check", b.governingCheck)}
        ${detailRow("D/C ratio", b.dcr.toFixed(2), { tone })}
        ${detailRow("Status", b.status, { tone })}
      </div>
      ${resolutions}
    </section>
    <div class="reasoning-note"><strong>${b.id}</strong> is governed by ${b.governingCheck.toLowerCase()} on a ${b.span} span. Result is tied to active Scheme ${state.activeSchemeId}, Assumption ${state.assumptionSetId}, and the load case stack.</div>
    <div class="inspector-actions">
      ${state.page === "sizing"
        ? btn("Apply best resolution", { variant: "primary", block: true, data: { action: "apply-size" } })
        : btn("Open calculation", { variant: "primary", block: true, data: { action: "open-calc" } })}
      ${btn("Show tributary area", { variant: "secondary", block: true, data: { action: "show-tributary" } })}
      ${btn("Ask CivilAgent why", { variant: "ghost", block: true, data: { action: "open-assistant" } })}
    </div>
  `;
}

/**
 * Inspector for a beam backed by real scheme + sizing data.
 *
 * Shows the full chain of checks emitted by the engine. When the
 * scheme has not been sized yet, falls back to a "Run sizing" CTA.
 */
function realBeamInspector(b) {
  const sized = b.__sized;
  const tone = statusTone(b.status);
  if (!sized) return notSizedInspector(b, "beam");

  const checks = sized.allChecks || [];
  const governingId = sized.governingCheck;

  const checkRows = checks.map((c) => {
    const t = statusTone(c.status);
    const tag = c.checkType === governingId ? " · governing" : "";
    const demandUnit = c.demandUnit ? ` ${c.demandUnit}` : "";
    const dcrFmt = Number.isFinite(c.dcr) ? c.dcr.toFixed(2) : "—";
    return `
      <div class="detail-row">
        <span class="detail-row-label">${prettyCheckType(c.checkType)}${tag}</span>
        <span class="detail-row-value">
          <span class="status-chip" data-tone="${t}">${dcrFmt}</span>
          <span style="font-size:var(--text-xs);color:var(--text-tertiary);margin-left:8px">
            D=${c.demand.toFixed(c.demandUnit === "in" ? 2 : 0)}${demandUnit} · C=${c.capacity.toFixed(c.capacityUnit === "in" ? 2 : 0)}
          </span>
        </span>
      </div>`;
  }).join("");

  const governingCheckRow = checks.find((c) => c.checkType === governingId) || checks[0];
  const govExplain = governingCheckRow?.explanation || "";

  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Selected size", b.size)}
        ${detailRow("Weight", Number.isFinite(sized.weightPlf) ? `${sized.weightPlf.toFixed(0)} plf` : "—")}
        ${detailRow("Span", b.span)}
        ${detailRow("Governing check", prettyCheckType(governingId))}
        ${detailRow("D/C ratio", b.dcr.toFixed(2), { tone })}
        ${detailRow("Status", b.status, { tone })}
      </div>
      <p class="eyebrow" style="margin:16px 0 8px">All checks</p>
      <div class="detail-list">
        ${checkRows || '<p style="color:var(--text-tertiary);font-size:var(--text-sm)">No checks recorded.</p>'}
      </div>
      ${govExplain ? `<div class="reasoning-note">${escapeHtml(govExplain)}</div>` : ""}
    </section>
    <div class="inspector-actions">
      ${btn("Re-run sizing", { variant: "primary", block: true, data: { action: "run-sizing" } })}
      ${btn("Show tributary area", { variant: "secondary", block: true, data: { action: "show-tributary" } })}
      ${btn("Ask CivilAgent why", { variant: "ghost", block: true, data: { action: "open-assistant" } })}
    </div>
  `;
}

function prettyCheckType(checkType) {
  return ({
    flexure: "Flexure",
    shear: "Shear",
    deflection_live: "Deflection (live)",
    deflection_total: "Deflection (total)",
    axial_compression: "Axial compression",
    slenderness: "Slenderness",
  })[checkType] || (checkType || "").replace(/_/g, " ");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Empty-state inspector for an un-sized real member. */
function notSizedInspector(member, kind) {
  const schemeId = state.activeSchemeId;
  const phase = sizingPhase(schemeId);
  const running = phase === "running";
  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Member id", member.id)}
        ${kind === "column"
          ? detailRow("Grid intersection", member.gridLabel || "—")
          : detailRow("Span", member.span || "—")}
        ${detailRow("Selected size", member.size || "—")}
        ${detailRow("D/C ratio", "—", { tone: "warn" })}
        ${detailRow("Status", running ? "Sizing in progress…" : "Not sized", { tone: "warn" })}
      </div>
    </section>
    <div class="reasoning-note">
      ${running
        ? "The sizing worker is currently calculating member checks. The inspector will refresh automatically when results are available."
        : "This member has not been sized yet. Run the sizing analysis to compute D/C ratios for every beam and column on the active scheme."}
    </div>
    <div class="inspector-actions">
      ${btn(running ? "Sizing…" : "Run sizing analysis", {
        variant: "primary",
        block: true,
        data: running ? {} : { action: "run-sizing" },
      })}
    </div>
  `;
}

function columnInspector(c) {
  if (c.__real) return realColumnInspector(c);
  const tone = c.status === "fail" ? "fail" : c.status === "warn" ? "warn" : "pass";
  // Mock per-level load takedown for the mini chart (cumulative axial)
  const bars = [c.dcr * 0.35, c.dcr * 0.55, c.dcr * 0.75, c.dcr * 0.88, c.dcr]
    .map((h, i) => `<div class="mini-chart-bar" style="height:${Math.min(h * 92, 92)}%" title="L${8 - i}"></div>`)
    .join("");

  const loadDetail = state.page === "loads"
    ? `
      <p class="eyebrow" style="margin:16px 0 8px">Load takedown</p>
      <div class="mini-chart" aria-label="Axial load by level">${bars}</div>
      <span style="display:block;margin-top:6px;color:var(--text-tertiary);font-size:var(--text-xs);font-family:var(--font-mono)">
        Roof → L1, cumulative kip
      </span>
    `
    : "";

  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Grid intersection", c.gridLabel)}
        ${detailRow("Levels", `${c.startLevel}–${c.endLevel}`)}
        ${detailRow("Size", c.size)}
        ${detailRow("Tributary area", c.tributaryArea)}
        ${detailRow("Axial load", c.axialLoad)}
        ${detailRow("D/C ratio", c.dcr.toFixed(2), { tone })}
        ${detailRow("Source", c.source)}
        ${detailRow("Locked", c.locked ? "Yes" : "No")}
      </div>
      ${loadDetail}
    </section>
    <div class="inspector-actions">
      ${btn(c.locked ? "Unlock column" : "Lock column", { variant: "primary", block: true, data: { action: "toggle-lock" } })}
      ${btn("Show load takedown", { variant: "secondary", block: true, data: { action: "show-load-path" } })}
      ${btn("Show tributary area", { variant: "secondary", block: true, data: { action: "show-tributary" } })}
      ${btn("Inspect sizing", { variant: "secondary", block: true, data: { page: "sizing" } })}
    </div>
  `;
}

/**
 * Inspector for a column backed by real scheme + sizing data + load
 * takedown. The takedown chart shows cumulative factored axial by
 * level; bars are scaled relative to the base value so the visual
 * is meaningful regardless of building height.
 */
function realColumnInspector(c) {
  const sized = c.__sized;
  const tone = statusTone(c.status);
  if (!sized) return notSizedInspector(c, "column");

  const checks = sized.allChecks || [];
  const governingId = sized.governingCheck;

  // Pull the takedown rows for this column out of the cached sizing
  // envelope. The /members endpoint doesn't include the takedown, but
  // we surfaced it in the snapshot via getCachedSizing.takedown is
  // not a field on the API response — we'll compute peak demand from
  // the axial check.
  const peak = checks.find((x) => x.checkType === "axial_compression");
  const peakDemand = peak ? `${peak.demand.toFixed(0)} kip` : "—";
  const peakCapacity = peak ? `${peak.capacity.toFixed(0)} kip` : "—";

  const checkRows = checks.map((x) => {
    const t = statusTone(x.status);
    const tag = x.checkType === governingId ? " · governing" : "";
    const dcrFmt = Number.isFinite(x.dcr) ? x.dcr.toFixed(2) : "—";
    return `
      <div class="detail-row">
        <span class="detail-row-label">${prettyCheckType(x.checkType)}${tag}</span>
        <span class="detail-row-value">
          <span class="status-chip" data-tone="${t}">${dcrFmt}</span>
          <span style="font-size:var(--text-xs);color:var(--text-tertiary);margin-left:8px">
            D=${x.demand.toFixed(0)} ${x.demandUnit || ""} · C=${x.capacity.toFixed(0)} ${x.capacityUnit || ""}
          </span>
        </span>
      </div>`;
  }).join("");

  const govExplain = checks.find((x) => x.checkType === governingId)?.explanation || "";

  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Grid intersection", c.gridLabel)}
        ${detailRow("Levels", `${c.startLevel}–${c.endLevel}`)}
        ${detailRow("Selected size", c.size)}
        ${detailRow("Weight", Number.isFinite(sized.weightPlf) ? `${sized.weightPlf.toFixed(0)} plf` : "—")}
        ${detailRow("Peak axial demand", peakDemand)}
        ${detailRow("Capacity (φPn)", peakCapacity)}
        ${detailRow("Governing check", prettyCheckType(governingId))}
        ${detailRow("D/C ratio", c.dcr.toFixed(2), { tone })}
        ${detailRow("Status", c.status, { tone })}
      </div>
      <p class="eyebrow" style="margin:16px 0 8px">All checks</p>
      <div class="detail-list">
        ${checkRows || '<p style="color:var(--text-tertiary);font-size:var(--text-sm)">No checks recorded.</p>'}
      </div>
      ${govExplain ? `<div class="reasoning-note">${escapeHtml(govExplain)}</div>` : ""}
    </section>
    <div class="inspector-actions">
      ${btn("Re-run sizing", { variant: "primary", block: true, data: { action: "run-sizing" } })}
      ${btn("Show load takedown", { variant: "secondary", block: true, data: { action: "show-load-path" } })}
      ${btn("Show tributary area", { variant: "secondary", block: true, data: { action: "show-tributary" } })}
      ${btn("Ask CivilAgent why", { variant: "ghost", block: true, data: { action: "open-assistant" } })}
    </div>
  `;
}

function wallInspector(w) {
  const tone = w.status === "fail" ? "fail" : w.status === "warn" ? "warn" : "pass";
  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Direction", w.direction)}
        ${detailRow("Length", w.length)}
        ${detailRow("Thickness", `${w.thickness} in`)}
        ${detailRow("Levels", w.levels)}
        ${detailRow("Drift contribution", w.driftContribution)}
        ${detailRow("D/C ratio", w.dcr.toFixed(2), { tone })}
        ${detailRow("Status", w.status, { tone })}
      </div>
    </section>
    <div class="reasoning-note">${w.id} is ${w.status === "fail" ? "failing shear under E-W seismic" : "passing"}. Resolution options are deterministic: thicken, extend, or pair with a parallel wall.</div>
    <div class="inspector-actions">
      ${btn(w.locked ? "Unlock wall" : "Lock wall", { variant: "secondary", block: true, data: { action: "toggle-lock" } })}
      ${btn("Thicken wall", { variant: "secondary", block: true, data: { action: "mock-thicken" } })}
      ${btn("Extend wall", { variant: "secondary", block: true, data: { action: "mock-extend" } })}
    </div>
  `;
}

function coreInspector(c) {
  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Type", c.type)}
        ${detailRow("Levels affected", c.levels)}
        ${detailRow("Conflicts", c.conflicts)}
      </div>
    </section>
  `;
}

function gridInspector(g) {
  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Grid label", g.label)}
        ${detailRow("Axis", g.axis)}
        ${detailRow("Coordinate", g.coordinate)}
        ${detailRow("Confidence", g.confidence)}
        ${detailRow("Locked", g.locked ? "Yes" : "No")}
      </div>
    </section>
  `;
}

function slabInspector(s) {
  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("System", s.system)}
        ${detailRow("Thickness", s.thickness)}
        ${detailRow("Load", s.loadPsf)}
        ${detailRow("Status", s.status)}
      </div>
    </section>
  `;
}

function zoneInspector(z) {
  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Reason", z.reason)}
        ${detailRow("Source", z.source)}
      </div>
    </section>
    <div class="reasoning-note">Placement generation avoids this zone unless the engineer explicitly allows a support exception.</div>
  `;
}

/**
 * Inspector content for the Geometry page when nothing is selected.
 * Sources every metric from the parsed-geometry cache so the user
 * sees real counts + confidence + review status from the IFC parse.
 *
 * The Accept Geometry button is enabled exactly when:
 *   - the cache holds a geometry envelope (we know what to accept),
 *   - the parse completed, and
 *   - review status is still `pending`.
 *
 * In every other state the button degrades to a labelled disabled
 * affordance so the user understands *why* it can't be clicked.
 */
function geometryEmptyInspector() {
  const geom = getCachedNormalizedGeometry();
  const env = getCachedEnvelope();

  if (!geom) {
    const status = env?.parseStatus || "idle";
    const note = status === "processing"
      ? "Parser is still running — geometry counts will populate when the parse terminal event arrives."
      : status === "failed"
        ? "Parse failed for the most recent upload. Retry the upload or pick a different file in the Vault."
        : "No parsed geometry on file for this project yet. Upload an IFC or model in the New Project flow to populate this view.";
    return `
      <section class="inspector-section">
        <div class="detail-list">
          ${detailRow("Levels detected", PENDING)}
          ${detailRow("Grids detected", PENDING)}
          ${detailRow("Cores detected", PENDING)}
          ${detailRow("Openings detected", PENDING)}
          ${detailRow("Review status", env?.reviewStatus || "—", { tone: "warn" })}
        </div>
      </section>
      <div class="reasoning-note">${note}</div>
      <div class="inspector-actions">
        ${btn("Accept geometry", { variant: "primary", block: true, disabled: true })}
        ${btn("Send to placement", { variant: "secondary", block: true, data: { page: "placement" } })}
      </div>
    `;
  }

  const overall = Number.isFinite(env?.overallConfidence)
    ? `${Math.round(env.overallConfidence * 100)}%`
    : null;

  const meanConf = (items) => {
    if (!Array.isArray(items) || items.length === 0) return null;
    let sum = 0, n = 0;
    for (const it of items) {
      if (Number.isFinite(it?.confidence)) { sum += it.confidence; n += 1; }
    }
    return n > 0 ? `${Math.round((sum / n) * 100)}%` : null;
  };

  const lvlText = overall
    ? `${geom.levels.length} / ${overall}`
    : String(geom.levels.length);
  const gridConf = meanConf(geom.gridLines);
  const gridsText = gridConf
    ? `${geom.gridLines.length} / ${gridConf}`
    : String(geom.gridLines.length);
  const coreConf = meanConf(geom.cores);
  const coresText = coreConf
    ? `${geom.cores.length} / ${coreConf}`
    : String(geom.cores.length);
  const openingConf = meanConf(geom.openings);
  const openingsText = openingConf
    ? `${geom.openings.length} / ${openingConf}`
    : String(geom.openings.length);

  const totalWarnings = (env?.apiWarnings?.length ?? 0) + (env?.adapterWarnings?.length ?? 0);
  const reviewStatus = env?.reviewStatus || "pending";
  const reviewLabel = reviewStatus === "accepted"
    ? "Accepted"
    : reviewStatus === "superseded"
      ? "Superseded"
      : totalWarnings > 0
        ? `${totalWarnings} to review`
        : "Pending review";
  const reviewTone = reviewStatus === "accepted"
    ? "pass"
    : reviewStatus === "superseded"
      ? "warn"
      : totalWarnings > 0
        ? "warn"
        : "pass";

  const canAccept = !!env?.geometryId
    && env.parseStatus === "completed"
    && reviewStatus === "pending";

  const note = reviewStatus === "accepted"
    ? "Geometry has been accepted. Subsequent placement, load, and sizing runs will use this version."
    : reviewStatus === "superseded"
      ? "A newer parse has superseded this geometry. Reload the project to view the active version."
      : env?.parseStatus === "partial"
        ? "Parser completed with warnings — review highlighted items before acceptance."
        : "CivilAgent extracted geometry from the uploaded model. Confirm the understanding before placement decisions are final.";

  return `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Levels detected", lvlText)}
        ${detailRow("Grids detected", gridsText)}
        ${detailRow("Cores detected", coresText)}
        ${detailRow("Openings detected", openingsText)}
        ${detailRow("Review status", reviewLabel, { tone: reviewTone })}
      </div>
    </section>
    <div class="reasoning-note">${note}</div>
    <div class="inspector-actions">
      ${btn(
        reviewStatus === "accepted" ? "Geometry accepted" : "Accept geometry",
        { variant: "primary", block: true,
          disabled: !canAccept,
          data: canAccept ? { action: "accept-geometry" } : {} },
      )}
      ${btn("Send to placement", { variant: "secondary", block: true, data: { page: "placement" } })}
    </div>
  `;
}

// ─── Placement page inspector ─────────────────────────────────────
// Fully driven by state.placement + the placement-binding facade.

function placementInspector() {
  const placement = ensurePlacementState();
  const sel = placement.selectedElementId;
  if (sel) {
    const view = placementSelectionInspector(sel);
    if (view) return view;
  }

  const strategy = getPlacementActiveStrategy();
  if (!strategy) {
    return `
      <section class="inspector-section">
        <p style="color:var(--text-tertiary);font-size:var(--text-sm);">
          Generating placement strategies…
        </p>
      </section>
    `;
  }

  const c = placement.constraints;
  const tool = placement.activeTool;
  const isOpt = placement.isOptimizing;
  const opt = placement.optimizationProgress || { current: 0, total: 847 };
  const manualCount =
    placement.manualOverrides.columns.length +
    placement.manualOverrides.shearWalls.length +
    placement.manualOverrides.beams.length;
  const lockedGenerated = strategy.elements.columns.filter((x) => x.locked && x.source === "generated").length;
  const lockedTotal = lockedGenerated + manualCount;

  // ── Active strategy header
  const header = `
    <section class="inspector-section placement-strategy-head">
      <div class="placement-strategy-name">
        <span class="status-dot" data-tone="${strategy.warnings.length <= 2 ? "pass" : strategy.warnings.length <= 4 ? "warn" : "fail"}"></span>
        <strong>${strategy.name}</strong>
        <span class="placement-strategy-score">Score ${strategy.score}</span>
      </div>
      <p class="placement-strategy-desc">${strategy.description}</p>
    </section>
  `;

  // ── Constraint + metric block
  const metrics = `
    <section class="inspector-section">
      <h4 class="inspector-subhead">Constraints</h4>
      <div class="detail-list">
        ${detailRow("Bay size target", `${c.baySizeMinFt}–${c.baySizeMaxFt} ft`)}
        ${detailRow("No-column zones", String((c.noColumnZones || []).length))}
        ${detailRow("Max span limit", `${c.maxSpanFt} ft`)}
        ${detailRow("Max beam depth limit", `${c.maxBeamDepthIn} in`)}
        ${detailRow("Lateral preference", c.lateralPreference)}
      </div>
      <h4 class="inspector-subhead" style="margin-top:14px;">Live metrics</h4>
      <div class="detail-list">
        ${detailRow("Total columns", String(strategy.columns))}
        ${detailRow("Total beams", String(strategy.beams))}
        ${detailRow("Shear walls", String(strategy.shearWalls))}
        ${detailRow("Max span", `${strategy.maxSpanFt} ft`,
          { tone: strategy.maxSpanFt > c.maxSpanFt ? "warn" : "pass" })}
        ${detailRow("Max beam depth", `${strategy.maxBeamDepthIn} in`,
          { tone: strategy.maxBeamDepthIn > c.maxBeamDepthIn ? "warn" : "pass" })}
        ${detailRow("Avg bay span", `${strategy.avgBayFt} ft`)}
        ${detailRow("Estimated steel", `${strategy.steelWeightTons} t`)}
        ${detailRow("Estimated cost", `$${strategy.estimatedCostM.toFixed(2)} M`)}
        ${detailRow("Carbon", `${strategy.carbonTCO2} tCO₂`,
          { tone: strategy.carbonTCO2 > 360 ? "warn" : "pass" })}
        ${detailRow("Locked elements", `${lockedTotal} (${manualCount} manual)`)}
      </div>
    </section>
  `;

  // ── Warnings
  const warningsHtml = strategy.warnings.length
    ? `<div class="reasoning-note placement-warnings">
        <strong>Warnings</strong><br/>
        ${strategy.warnings.map(escapeHtmlSafe).join("<br/>")}
       </div>`
    : `<div class="reasoning-note">No outstanding warnings — this strategy is within all configured constraints.</div>`;

  // ── Optimization progress banner (active only while regenerating)
  const optBanner = isOpt
    ? `<section class="inspector-section">
         <div class="placement-optim">
           <div class="placement-optim-row">
             <span class="status-dot" data-tone="warn"></span>
             <span class="placement-optim-label">${opt.label || "Optimizing…"}</span>
           </div>
           <div class="placement-optim-bar">
             <div class="placement-optim-fill" style="width:${Math.min(100, (opt.current / opt.total) * 100)}%"></div>
           </div>
           <div class="placement-optim-count">${opt.current.toLocaleString()} of ${opt.total.toLocaleString()}</div>
         </div>
       </section>`
    : "";

  // ── Tool buttons (Add column / Add shear wall / Add beam / Delete / Clear)
  const tools = `
    <div class="inspector-actions">
      ${btn(isOpt ? "Optimizing…" : "Regenerate", {
        variant: "primary", block: true,
        data: isOpt ? {} : { action: "regenerate" },
        disabled: isOpt,
      })}
      ${btn("Add column", {
        variant: tool === "add-column" ? "primary" : "secondary",
        block: true,
        data: { action: "placement-tool", "placement-tool": "add-column" },
      })}
      ${btn("Add shear wall", {
        variant: tool === "add-shear-wall" ? "primary" : "secondary",
        block: true,
        data: { action: "placement-tool", "placement-tool": "add-shear-wall" },
      })}
      ${btn("Add beam", {
        variant: tool === "add-beam" ? "primary" : "secondary",
        block: true,
        data: { action: "placement-tool", "placement-tool": "add-beam" },
      })}
      ${manualCount > 0
        ? btn(`Clear manual edits (${manualCount})`, {
            variant: "ghost", block: true,
            data: { action: "placement-clear-manual" },
          })
        : ""}
    </div>
  `;

  return header + optBanner + metrics + warningsHtml + tools;
}

function placementSelectionInspector(id) {
  // Look up the element across active-strategy elements + manualOverrides.
  const strategy = getPlacementActiveStrategy();
  if (!strategy) return null;
  const el = [
    ...strategy.elements.columns,
    ...strategy.elements.beams,
    ...strategy.elements.shearWalls,
  ].find((x) => x.id === id);
  if (!el) return null;

  const isManual = el.source === "manual";
  const dimsLabel = el.type === "column"
    ? `${(el.width ?? 0).toFixed(2)} × ${(el.depth ?? 0).toFixed(2)} ft`
    : el.type === "beam"
      ? `${(el.depth ?? 0).toFixed(2)} ft × ${(el.width ?? 0).toFixed(2)} ft`
      : el.type === "shearWall"
        ? `t = ${(el.thickness ?? 0).toFixed(2)} ft`
        : "—";
  const span = el.type === "beam" && el.spanFt ? `${el.spanFt.toFixed(1)} ft` : null;
  const depthIn = el.type === "beam" && el.depthIn ? `${Math.round(el.depthIn)} in` : null;
  const levelRange = el.levelStart != null && el.levelEnd != null
    ? `L${(el.levelStart || 0) + 1} – L${el.levelEnd}`
    : (el.level || "—");

  const head = `
    <section class="inspector-section placement-strategy-head">
      <div class="placement-strategy-name">
        <span class="status-dot" data-tone="${isManual ? "pass" : "warn"}"></span>
        <strong>${el.label || el.id}</strong>
        <span class="placement-strategy-score">${isManual ? "Manual" : "Generated"}${el.locked ? " · Locked" : ""}</span>
      </div>
      <p class="placement-strategy-desc">${typeLabel(el.type)} on ${strategy.name}.</p>
    </section>
  `;

  const details = `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Type", typeLabel(el.type))}
        ${detailRow("Identifier", el.label || el.id)}
        ${detailRow("Source", isManual ? "Manual override" : "Generated")}
        ${detailRow("Locked", el.locked ? "Yes" : "No")}
        ${span ? detailRow("Span", span) : ""}
        ${depthIn ? detailRow("Beam depth", depthIn) : ""}
        ${detailRow("Level range", String(levelRange))}
        ${detailRow("Dimensions", dimsLabel)}
      </div>
    </section>
  `;

  const actions = `
    <div class="inspector-actions">
      ${isManual
        ? btn("Delete manual element", {
            variant: "secondary", block: true,
            data: { action: "placement-delete-element" },
          })
        : btn("Clear selection", {
            variant: "secondary", block: true,
            data: { action: "placement-clear-selection" },
          })}
    </div>
    ${isManual
      ? ""
      : `<div class="reasoning-note">Generated element. Lock it before editing.</div>`}
  `;

  return head + details + actions;
}

function typeLabel(t) {
  return { column: "Column", beam: "Beam", shearWall: "Shear wall" }[t] || "Element";
}

function escapeHtmlSafe(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Loads page inspector
// ---------------------------------------------------------------------------

function fmt(n, suffix = "") {
  if (n == null || !Number.isFinite(n) || n === 0) return "—";
  return `${n.toLocaleString()}${suffix}`;
}

function loadsPageInspector() {
  if (!state.loads) {
    state.loads = createInitialLoadsState();
  }
  const loads = state.loads;

  // If a specific load case is selected, show its details
  if (loads.selectedLoadId) {
    const lc = loads.loadCases.find((c) => c.id === loads.selectedLoadId);
    if (lc) return loadsLoadCaseInspector(lc, loads);
  }

  const isAnalyzing = loads.isAnalyzing;
  const progress = loads.analysisProgress;
  const results = loads.loadResults;
  const activeCombination = loads.loadCombinations.find(
    (c) => c.id === loads.activeCombinationId,
  );
  const unapproved = loads.loadCases.filter(
    (lc) => lc.status !== "approved",
  ).length;
  const hasResults = results.maxColumnAxialKip > 0;

  if (isAnalyzing) {
    const pct = Math.round((progress.percent || 0) * 100);
    return `
      <section class="inspector-section">
        <div class="loads-optim">
          <div class="loads-optim-row">
            <span class="status-dot" data-tone="warn"></span>
            <span class="loads-optim-label">${escapeHtml(progress.label)}</span>
          </div>
          <div class="loads-optim-bar">
            <div class="loads-optim-fill" style="width:${pct}%"></div>
          </div>
          <div class="loads-optim-count">${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}</div>
        </div>
      </section>
      <section class="inspector-section">
        <div class="detail-list">
          ${detailRow("Stage", escapeHtml(progress.label))}
          ${detailRow("Progress", `${pct}%`)}
          ${detailRow("Active cases", String(loads.loadCases.filter((lc) => lc.status === "approved").length))}
        </div>
      </section>
    `;
  }

  const metricsSection = `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Active load cases", String(loads.loadCases.filter((lc) => lc.status === "approved").length))}
        ${hasResults ? detailRow("Total floor load", `${fmt(results.totalFloorLoadKip)} kip`) : detailRow("Total floor load", "—")}
        ${hasResults ? detailRow("Max column axial", `${fmt(results.maxColumnAxialKip)} kip`) : detailRow("Max column axial", "—")}
        ${hasResults ? detailRow("Max beam reaction", `${fmt(results.maxBeamReactionKip)} kip`) : detailRow("Max beam reaction", "—")}
        ${detailRow("Active combination", escapeHtml(activeCombination?.expression || "—"))}
        ${detailRow("Unapproved cases", String(unapproved), { tone: unapproved > 0 ? "warn" : "pass" })}
      </div>
    </section>
  `;

  const warningsSection = loads.warnings.length > 0
    ? `<div class="reasoning-note loads-warnings-note">
        <strong>Warnings (${loads.warnings.length})</strong><br/>
        ${loads.warnings.map((w) => `<span class="loads-warning-item" data-severity="${w.severity}">${escapeHtml(w.message)}</span>`).join("")}
      </div>`
    : hasResults
      ? `<div class="reasoning-note">Load visualization is based on approved assumptions. Click any load case in the table below to inspect details.</div>`
      : `<div class="reasoning-note">Run load analysis to calculate column axials, beam reactions, and load takedown results.</div>`;

  const staleNote = loads.analysisStale && hasResults
    ? `<div class="reasoning-note" style="color:var(--status-warn)">Results are stale — re-run analysis after editing load cases.</div>`
    : "";

  const actions = `
    <div class="inspector-actions">
      ${btn(isAnalysisRunning() ? "Analyzing…" : "Run load analysis", {
        variant: "primary",
        block: true,
        data: isAnalysisRunning() ? {} : { action: "run-load-analysis" },
        disabled: isAnalysisRunning(),
      })}
      ${btn("Show load combinations", {
        variant: "secondary",
        block: true,
        data: { action: "show-load-combinations" },
      })}
      ${btn("Add load case", {
        variant: "secondary",
        block: true,
        data: { action: "add-load" },
      })}
      ${btn("Export load summary", {
        variant: "ghost",
        block: true,
        data: { action: "export-load-summary" },
      })}
    </div>
  `;

  return metricsSection + warningsSection + staleNote + actions;
}

function loadsLoadCaseInspector(lc, loads) {
  const statusTone = lc.status === "approved" ? "pass" : lc.status === "draft" ? "warn" : "fail";
  const levelStr = lc.appliesTo?.levels?.length === 6
    ? "All levels (L1–L6)"
    : lc.appliesTo?.levels?.map((l) => `L${l}`).join(", ") || "—";

  // Find element result for any element related to this load case
  const relatedWarnings = loads.warnings.filter((w) => w.relatedLoadCaseId === lc.id);

  const head = `
    <section class="inspector-section">
      <div class="placement-strategy-name">
        <span class="status-dot" data-tone="${statusTone}"></span>
        <strong>${escapeHtml(lc.name)}</strong>
        <span class="placement-strategy-score">${lc.type}</span>
      </div>
      <p class="placement-strategy-desc">${escapeHtml(lc.description || "")}</p>
    </section>
  `;

  const details = `
    <section class="inspector-section">
      <div class="detail-list">
        ${detailRow("Type", lc.type)}
        ${detailRow("Category", lc.category || "—")}
        ${detailRow("Value", `${lc.value} ${lc.unit}`)}
        ${detailRow("Source", escapeHtml(lc.source || "—"))}
        ${detailRow("Applies to", levelStr)}
        ${detailRow("Zones", (lc.appliesTo?.zones || ["all"]).join(", "))}
        ${detailRow("Status", lc.status, { tone: statusTone })}
      </div>
    </section>
  `;

  const warningsHtml = relatedWarnings.length > 0
    ? `<div class="reasoning-note">${relatedWarnings.map((w) => escapeHtml(w.message)).join("<br/>")}</div>`
    : "";

  const actions = `
    <div class="inspector-actions">
      ${lc.editable ? btn("Edit load case", { variant: "secondary", block: true, data: { action: "edit-load-inspector", "load-id": lc.id } }) : ""}
      ${lc.status === "approved"
        ? btn("Set to draft", { variant: "secondary", block: true, data: { action: "unapprove-load-inspector", "load-id": lc.id } })
        : btn("Approve", { variant: "primary", block: true, data: { action: "approve-load-inspector", "load-id": lc.id } })
      }
      ${lc.editable && lc.status !== "approved" ? btn("Delete", { variant: "secondary", block: true, data: { action: "delete-load-inspector", "load-id": lc.id } }) : ""}
      ${btn("Clear selection", { variant: "ghost", block: true, data: { action: "clear-load-selection" } })}
    </div>
  `;

  return head + details + warningsHtml + actions;
}

function emptyInspector() {
  if (state.page === "geometry") {
    return geometryEmptyInspector();
  }
  if (state.page === "placement") {
    return placementInspector();
  }
  if (state.page === "loads") {
    return loadsPageInspector();
  }
  if (state.page === "schemes") {
    const s = getCachedScheme(state.activeSchemeId) || listCachedSchemes()[0];
    if (!s) {
      return `
        <section class="inspector-section">
          <p style="color:var(--text-tertiary);font-size:var(--text-sm);">
            No schemes generated yet. Generate column-grid variants to see strategy details here.
          </p>
        </section>
      `;
    }
    const m = s.metrics || {};
    const warningCount = m.warningCount ?? (m.warnings?.length || 0);
    const sized = s.sizingStatus === "sized" || Number.isFinite(m.steelTonnage);
    const tonnage = Number.isFinite(m.steelTonnage) ? `${m.steelTonnage.toFixed(1)} t` : PENDING;
    const cost = Number.isFinite(m.costIndex) ? m.costIndex.toFixed(2) : PENDING;
    const depth = Number.isFinite(m.maxBeamDepth) ? `${m.maxBeamDepth.toFixed(0)} in` : PENDING;
    const sections = Number.isFinite(m.uniqueSections) ? String(m.uniqueSections) : PENDING;
    return `
      <section class="inspector-section">
        <div class="detail-list">
          ${detailRow("Strategy", s.strategy || PENDING)}
          ${detailRow("Description", s.description || "—")}
          ${detailRow("Column count", fmtNum(m.columnCount))}
          ${detailRow("Max span", fmtMetric(m, "maxSpan", " ft"))}
          ${detailRow("Average span", fmtMetric(m, "averageSpan", " ft"))}
          ${detailRow("Unique bay patterns", fmtNum(m.uniqueBayPatterns))}
          ${detailRow("Steel tonnage", tonnage)}
          ${detailRow("Cost index", cost)}
          ${detailRow("Max beam depth", depth)}
          ${detailRow("Unique sections", sections)}
          ${detailRow("Concrete volume", PENDING)}
          ${detailRow("Max drift", PENDING)}
          ${detailRow("Warnings", String(warningCount), { tone: warningCount <= 2 ? "pass" : "warn" })}
        </div>
      </section>
      <div class="reasoning-note">
        ${sized
          ? "Sizing metrics above were computed by the gravity-load + member-sizing engine (ASCE 7 / AISC LRFD). Drift and concrete volume require lateral analysis and a concrete agent — out of scope for v1."
          : "Layout-only metrics above come from the column-layout generator. Run sizing analysis to populate steel tonnage, cost index, and per-member D/C ratios."}
      </div>
      <div class="inspector-actions">
        ${btn("Set as active", { variant: "primary", block: true, data: { action: "set-active-scheme" } })}
        ${sized
          ? btn("Re-run sizing", { variant: "secondary", block: true, data: { action: "run-sizing" } })
          : btn("Run sizing analysis", { variant: "secondary", block: true, data: { action: "run-sizing" } })}
        ${btn("Compare schemes", { variant: "ghost", block: true, data: { action: "compare-schemes" } })}
      </div>
    `;
  }
  if (state.page === "sizing") {
    const schemeId = state.activeSchemeId;
    const env = schemeId ? getCachedSizing(schemeId) : null;
    const phase = sizingPhase(schemeId);
    const running = phase === "running";

    if (env?.members?.length) {
      // Sized — show the rolled-up summary.
      const members = env.members;
      const passCount = members.filter((m) => m.status === "pass" || m.status === "efficient").length;
      const nearCount = members.filter((m) => m.status === "near-capacity").length;
      const failCount = members.filter((m) => m.status === "fail").length;
      const top = members.slice().sort((a, b) => (b?.dcr ?? 0) - (a?.dcr ?? 0))[0];
      const topLabel = top
        ? `${top.memberId} (D/C ${(top.dcr ?? 0).toFixed(2)})`
        : "—";

      const warnings = (env.warnings || []).slice(0, 3);
      const sizedAt = env.sizedAt ? new Date(env.sizedAt).toLocaleString() : "—";

      return `
        <section class="inspector-section">
          <div class="detail-list">
            ${detailRow("Passing", String(passCount), { tone: "pass" })}
            ${detailRow("Near capacity", String(nearCount), { tone: "warn" })}
            ${detailRow("Failing", String(failCount), { tone: failCount > 0 ? "fail" : "pass" })}
            ${detailRow("Top issue", topLabel)}
            ${detailRow("Last sized", sizedAt)}
          </div>
        </section>
        ${warnings.length > 0
          ? `<div class="reasoning-note"><strong>Warnings</strong><br/>${warnings.map(escapeHtml).join("<br/>")}</div>`
          : `<div class="reasoning-note">Click any member on the canvas to inspect its full check trace (flexure, shear, deflection or axial / slenderness).</div>`}
        <div class="inspector-actions">
          ${btn("Re-run sizing", { variant: "primary", block: true, data: { action: "run-sizing" } })}
          ${btn("View issue queue", { variant: "secondary", block: true, data: { action: "open-tray" } })}
        </div>
      `;
    }

    return `
      <section class="inspector-section">
        <div class="detail-list">
          ${detailRow("Passing", PENDING)}
          ${detailRow("Near capacity", PENDING)}
          ${detailRow("Failing", PENDING)}
          ${detailRow("Top issue", PENDING)}
        </div>
      </section>
      <div class="reasoning-note">
        ${running
          ? "Sizing in progress — D/C colors and member checks will populate when the worker finishes."
          : "Run sizing analysis to see member checks. Until the sizing agent runs, members render in neutral colors and no D/C ratios are reported — Agent 3 outputs layout-only schemes."}
      </div>
      <div class="inspector-actions">
        ${btn(running ? "Sizing…" : "Run sizing analysis", {
          variant: "primary",
          block: true,
          data: running ? {} : { action: "run-sizing" },
        })}
        ${btn("View issue queue", { variant: "secondary", block: true, data: { action: "open-tray" } })}
      </div>
    `;
  }
  return `
    <section class="inspector-section">
      <p style="color:var(--text-tertiary);font-size:var(--text-sm);">Select an element on the canvas to inspect its details.</p>
    </section>
  `;
}

function render(host) {
  const sel = state.selectedObject;
  const obj = sel ? findObject(sel.type, sel.id) : null;

  const title = obj ? (obj.id || obj.name) : TITLES[state.page] || "Inspector";
  const PAGE_EYEBROW = {
    overview: "OVERVIEW",
    geometry: "GEOMETRY",
    placement: "PLACEMENT",
    loads: "LOADS",
    schemes: "SCHEMES",
    sizing: "SIZING",
  };
  const eyebrow = obj
    ? labelForType(sel.type)
    : PAGE_EYEBROW[state.page] || "WORKSPACE";

  // For schemes with no selection, show the active scheme name as title
  let displayTitle = title;
  if (!obj && state.page === "schemes") {
    const s = getCachedScheme(state.activeSchemeId) || listCachedSchemes()[0];
    if (s) displayTitle = `Scheme ${s.displayLabel || s.name || ""} — ${s.name || s.strategy || ""}`;
  }

  // On loads page: if a load case is selected, show it through loadsPageInspector
  // (which dispatches internally), so clear-selection still works.
  let body;
  if (state.page === "loads") {
    body = loadsPageInspector();
    displayTitle = state.loads?.selectedLoadId
      ? (state.loads.loadCases.find((lc) => lc.id === state.loads.selectedLoadId)?.name ?? "Load Case")
      : "Load path";
  } else {
    body = obj ? selectedObjectInspector(sel.type, obj) : emptyInspector();
  }

  const showClose = state.page === "loads"
    ? !!state.loads?.selectedLoadId
    : !!obj;

  const markup = `
    <div class="inspector-head">
      <div style="min-width:0">
        <p class="eyebrow">${eyebrow}</p>
        <h2 class="inspector-title">${escapeHtml(displayTitle)}</h2>
      </div>
      ${showClose ? `<button class="btn-icon" data-action="clear-selection" aria-label="Clear selection">${icon("close", 14)}</button>` : ""}
    </div>
    <div class="inspector-body">${body}</div>
  `;
  patch(host, markup);
}

/**
 * Move the current geometry from `pending` → `accepted` via the API,
 * with optimistic UI applied through the cache. The cache notifier
 * re-renders the inspector / tray automatically; we only own toast
 * + error reporting here.
 *
 * Guards:
 *   - no-op when there is nothing to accept (cache empty / wrong
 *     project / already accepted).
 *   - guards against double-click while the request is in flight.
 */
let _acceptInFlight = false;
async function handleAcceptGeometry() {
  if (_acceptInFlight) return;

  const env = getCachedEnvelope();
  const projectId = state.projectId || state.newProject?.projectId;
  if (!env?.geometryId || !projectId) {
    toast("No geometry available to accept", { tone: "warn" });
    return;
  }
  if (env.reviewStatus === "accepted") {
    toast("Geometry already accepted");
    return;
  }
  if (env.parseStatus !== "completed") {
    toast("Parse must finish before accepting", { tone: "warn" });
    return;
  }

  _acceptInFlight = true;
  try {
    await acceptGeometry(projectId, env.geometryId);
    toast("Geometry accepted");
  } catch (err) {
    const msg = err?.message || "Failed to accept geometry";
    toast(msg, { tone: "fail" });
  } finally {
    _acceptInFlight = false;
  }
}

function labelForType(type) {
  return {
    beam: "Beam",
    column: "Column",
    shearWall: "Shear wall",
    core: "Core",
    grid: "Grid",
    slab: "Slab",
    noColumnZone: "No-column zone",
    brace: "Brace",
    load: "Load Case",
  }[type] || "Object";
}

const boundInspectorHosts = new WeakSet();

export function mountInspector(host) {
  host.classList.add("inspector");

  if (boundInspectorHosts.has(host)) {
    // Already wired — just re-render
    const update = () => render(host);
    const unsubs = [];
    unsubs.push(on("page", update));
    unsubs.push(on("selectedObject", update));
    unsubs.push(on("activeSchemeId", update));
    unsubs.push(on("compareMode", update));
    unsubs.push(on("placement", update));
    unsubs.push(onSizingStateChange(update));
    unsubs.push(onGeometryChange(update));
    update();
    return { update, dispose: () => unsubs.forEach((fn) => fn()) };
  }
  boundInspectorHosts.add(host);

  delegate(host, "click", "[data-action], [data-page]", (_e, target) => {
    if (target.dataset.page) return; // bubbles to global handler
    const action = target.dataset.action;
    if (action === "clear-selection") {
      state.selectedObject = null;
      if (state.loads) {
        state.loads.selectedLoadId = null;
        emit("loads", state.loads, state.loads);
      }
    } else if (action === "open-assistant") {
      state.assistantOpen = true;
    } else if (action === "show-tributary") {
      state.layers = { ...state.layers, tributary: true };
      toast("Tributary area displayed");
    } else if (action === "toggle-lock") {
      const sel = state.selectedObject;
      const obj = sel ? findObject(sel.type, sel.id) : null;
      if (obj && "locked" in obj) {
        obj.locked = !obj.locked;
        state.selectedObject = { ...sel };
        toast(`${obj.id} ${obj.locked ? "locked" : "unlocked"}`);
      }
    } else if (action === "accept-geometry") {
      handleAcceptGeometry().catch((err) => {
        console.error("[CivilAgent] accept-geometry failed:", err);
      });
    } else if (action === "regenerate") {
      // Visual optimization animation + real engine regeneration in parallel.
      if (!isOptimizationRunning()) triggerOptimization("placement");
      regeneratePlacementStrategy();
    } else if (action === "placement-tool") {
      togglePlacementTool(target.dataset.placementTool);
    } else if (action === "placement-clear-manual") {
      clearPlacementManualOverrides();
    } else if (action === "placement-delete-element") {
      const id = ensurePlacementState().selectedElementId;
      if (id) deletePlacementManualElement(id);
    } else if (action === "placement-clear-selection") {
      selectPlacementElement(ensurePlacementState().selectedElementId);
    } else if (action === "run-load-analysis") {
      if (!state.loads) state.loads = createInitialLoadsState();
      if (isAnalysisRunning()) {
        toast("Analysis already in progress");
        return;
      }
      startAnalysis();
      if (!isOptimizationRunning()) triggerOptimization("loads");
    } else if (action === "show-load-combinations") {
      _showLoadCombinationsModal();
    } else if (action === "add-load") {
      openAddLoadModal(null);
    } else if (action === "export-load-summary") {
      _exportLoadSummary();
    } else if (action === "clear-load-selection") {
      if (state.loads) state.loads.selectedLoadId = null;
      state.selectedObject = null;
      emit("loads", state.loads, state.loads);
    } else if (action === "approve-load-inspector") {
      const id = target.dataset.loadId;
      const lc = state.loads?.loadCases?.find((c) => c.id === id);
      if (lc) {
        lc.status = "approved";
        if (state.loads) state.loads.analysisStale = true;
        emit("loads", state.loads, state.loads);
        toast(`${lc.name} approved`);
      }
    } else if (action === "unapprove-load-inspector") {
      const id = target.dataset.loadId;
      const lc = state.loads?.loadCases?.find((c) => c.id === id);
      if (lc) {
        lc.status = "draft";
        if (state.loads) state.loads.analysisStale = true;
        emit("loads", state.loads, state.loads);
        toast(`${lc.name} set to draft`);
      }
    } else if (action === "delete-load-inspector") {
      const id = target.dataset.loadId;
      if (state.loads) {
        const idx = state.loads.loadCases.findIndex((c) => c.id === id);
        if (idx >= 0) {
          const name = state.loads.loadCases[idx].name;
          state.loads.loadCases.splice(idx, 1);
          state.loads.selectedLoadId = null;
          state.selectedObject = null;
          state.loads.analysisStale = true;
          emit("loads", state.loads, state.loads);
          toast(`${name} removed`);
        }
      }
    } else if (action === "edit-load-inspector") {
      const id = target.dataset.loadId;
      openAddLoadModal(id);
    } else if (action === "set-active-scheme") {
      const schemeId = state.activeSchemeId;
      const cached = getCachedScheme(schemeId) || listCachedSchemes()[0];
      const label = cached?.displayLabel || cached?.name || "selected";
      const projectId = state.projectId;
      if (projectId && schemeId) {
        setActiveScheme(projectId, schemeId)
          .then(() => toast(`Scheme ${label} set as active`))
          .catch(() => toast(`Scheme ${label} marked active (offline)`));
      } else {
        toast(`Scheme ${label} set as active`);
      }
    } else if (action === "compare-schemes") {
      state.compareMode = !state.compareMode;
    } else if (action === "open-tray") {
      state.trayOpen = true;
    } else if (action === "run-sizing") {
      const schemeId = state.activeSchemeId;
      if (!schemeId) {
        // No scheme yet — still let the user feel the AI think.
        if (!isOptimizationRunning()) triggerOptimization("sizing");
      } else if (sizingPhase(schemeId) === "running") {
        toast("Sizing already in progress");
      } else {
        startSizing(schemeId);
        state.trayOpen = true; // surface the progress panel for the user
        if (!isOptimizationRunning()) triggerOptimization("sizing");
      }
    } else if (action === "edit-zones") {
      toast("Edit zones (mock)");
    } else if (action === "apply-resolution") {
      toast(`Applied ${target.dataset.resolution} resolution`);
    } else if (action === "show-load-path") {
      toast("Load takedown displayed");
    } else if (action === "open-calc") {
      toast("Calculation report opened");
    } else if (action === "apply-size") {
      toast("Member size updated");
    } else {
      toast("Action queued");
    }
  });

  const update = () => render(host);
  const unsubs = [];
  unsubs.push(on("page", update));
  unsubs.push(on("selectedObject", update));
  unsubs.push(on("activeSchemeId", update));
  unsubs.push(on("compareMode", update));
  unsubs.push(on("placement", update));
  unsubs.push(on("loads", update));
  unsubs.push(onSizingStateChange(update));
  unsubs.push(onAnalysisStateChange(update));
  // Re-render when parsed geometry resolves or its review status flips,
  // so the empty-state metrics + Accept Geometry button reflect reality.
  unsubs.push(onGeometryChange(update));
  update();

  return { update, dispose: () => unsubs.forEach((fn) => fn()) };
}

// ---------------------------------------------------------------------------
// Load combinations modal
// ---------------------------------------------------------------------------

function _showLoadCombinationsModal() {
  if (!state.loads) state.loads = createInitialLoadsState();
  const loads = state.loads;
  const combinations = loads.loadCombinations;

  const typeLabel = (t) =>
    ({ service: "Service", strength: "Strength", lateral: "Lateral" }[t] ?? t);
  const typeTone = (t) =>
    ({ service: "pass", strength: "warn", lateral: "fail" }[t] ?? "default");

  const rows = combinations.map((combo) => {
    const res = combo.resultSummary;
    const isActive = combo.id === loads.activeCombinationId;
    return `
      <div class="loads-combo-row${isActive ? " is-active" : ""}" data-combo-id="${combo.id}">
        <div class="loads-combo-header">
          <div class="loads-combo-name">
            ${isActive ? `<span class="status-dot" data-tone="pass"></span>` : ""}
            <strong>${escapeHtml(combo.name)}</strong>
            <span class="loads-combo-expr">${escapeHtml(combo.expression)}</span>
          </div>
          <span class="status-chip" data-tone="${typeTone(combo.type)}">${typeLabel(combo.type)}</span>
        </div>
        ${res ? `
          <div class="loads-combo-results">
            <span>Total: <strong>${res.totalLoadKip.toLocaleString()} kip</strong></span>
            <span>Max axial: <strong>${res.maxColumnAxialKip.toLocaleString()} kip</strong></span>
            <span>Controls: <strong>${escapeHtml(res.controllingElementId || "—")}</strong></span>
          </div>
        ` : `<div class="loads-combo-note">Run load analysis to see results.</div>`}
        <div class="loads-combo-footer">
          <button class="btn btn-sm${isActive ? " btn-primary" : " btn-secondary"}" data-set-combo="${combo.id}">
            ${isActive ? "Active" : "Set active"}
          </button>
        </div>
      </div>
    `;
  }).join("");

  import("./modal.js").then(({ openModal, closeModal }) => {
    openModal({
      title: "Load Combinations",
      body: `
        <div class="loads-combos-grid">
          ${rows}
        </div>
        <p style="margin-top:12px;color:var(--text-tertiary);font-size:var(--text-xs)">
          Click "Set active" to change the controlling combination. Results update after re-running load analysis.
        </p>
      `,
      footer: `<button class="btn btn-primary" id="loads-combo-close">Close</button>`,
    });

    document.getElementById("loads-combo-close")?.addEventListener("click", closeModal);

    // Set active combination
    document.querySelectorAll("[data-set-combo]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.setCombo;
        if (state.loads) {
          state.loads.activeCombinationId = id;
          state.loads.analysisStale = true;
          emit("loads", state.loads, state.loads);
          toast(`Active combination changed`);
        }
        closeModal();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Export load summary
// ---------------------------------------------------------------------------

function _exportLoadSummary() {
  if (!state.loads) {
    toast("No load data to export", { tone: "warn" });
    return;
  }
  const loads = state.loads;
  const timestamp = new Date().toISOString();
  const projectName = "Civil Agent Project";

  const summary = {
    project: projectName,
    exportedAt: timestamp,
    analysisStale: loads.analysisStale,
    loadCases: loads.loadCases.map((lc) => ({
      id: lc.id,
      name: lc.name,
      type: lc.type,
      value: lc.value,
      unit: lc.unit,
      source: lc.source,
      status: lc.status,
      appliesTo: lc.appliesTo,
    })),
    loadCombinations: loads.loadCombinations.map((c) => ({
      id: c.id,
      name: c.name,
      expression: c.expression,
      type: c.type,
      status: c.status,
      resultSummary: c.resultSummary,
    })),
    results: loads.analysisStale ? null : loads.loadResults,
    warnings: loads.warnings,
  };

  const json = JSON.stringify(summary, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `load-summary-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("Load summary exported");
}
