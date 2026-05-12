/**
 * Processing screen.
 *
 * Two execution modes, picked from `state.newProject.processingMode`:
 *
 *   • **"live"** — open the parse-progress WebSocket, stream
 *      `ProgressEvent`s, render them, fetch the final ParsedGeometry on
 *      the terminal event, stash it on state, and forward the engineer
 *      to the workspace.
 *
 *   • **"mock"** — run the previous simulated pipeline. Used in offline
 *      / no-API demos so the static-site experience still flows.
 *
 * The visual structure (header, step list, 3D preview) is shared by
 * both modes so the user perceives a consistent screen regardless of
 * whether the API is wired up.
 */

import { mount, escapeHtml } from "../utils/dom.js";
import { btn } from "../utils/helpers.js";
import { state, set } from "../state.js";
import { navigateToProject } from "../router.js";
import { ThreeCanvas } from "../canvas/three-canvas.js";
import {
  PARSE_STEPS,
  stepLabel,
  subscribeProgress,
  fetchGeometry,
} from "../api/parse.js";
import { triggerGenerateSchemes } from "../api/schemes.js";
import { seedParsedGeometry } from "../canvas/parsed-geometry-cache.js";
import { toast } from "../components/toast.js";

// ---------------------------------------------------------------------------
// Mock pipeline (used when no API / no parser-eligible upload).
// ---------------------------------------------------------------------------

const MOCK_PIPELINE = [
  { id: "setup", label: "Setting up workspace", duration: 600 },
  {
    id: "parse", label: "Parsing Architectural_Model.ifc", duration: 1800,
    children: [
      { id: "levels", label: "Extracting levels", duration: 350 },
      { id: "grids", label: "Extracting grids", duration: 350 },
      { id: "cores", label: "Identifying cores", duration: 350 },
      { id: "openings", label: "Detecting openings", duration: 380 },
      { id: "boundaries", label: "Building floor plate boundaries", duration: 360 },
    ],
  },
  {
    id: "geotech", label: "Processing Geotechnical_Report.pdf", duration: 900,
    children: [
      { id: "soil", label: "Extracting soil parameters", duration: 320 },
      { id: "bearing", label: "Identifying bearing capacity", duration: 320 },
    ],
  },
  { id: "assumptions", label: "Generating initial assumptions", duration: 600 },
  { id: "model3d", label: "Preparing 3D model", duration: 500 },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let activeHost = null;
let preview = null;
let mockTimer = null;
let liveSub = null;

/** Live mode: latest progress event we received. */
let liveEvent = null;
/** Live mode: snapshot of substeps once terminal — frozen for display. */
let liveTerminal = null;
/** Live mode: deterministic step ordering = parser PARSE_STEPS. */
const LIVE_STEPS = PARSE_STEPS;

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

function symbol(s) {
  if (s === "complete" || s === "done" || s === "completed") return "✓";
  if (s === "in_progress" || s === "running" || s === "active") return "◎";
  if (s === "failed") return "✗";
  if (s === "skipped") return "—";
  return "○";
}

function liveStepStatus(stepName) {
  if (!liveEvent) return "pending";
  const ss = (liveEvent.substeps || []).find((s) => s.name === stepName);
  if (!ss) return "pending";
  return ss.status;
}

function liveStepDetail(stepName) {
  if (!liveEvent) return "";
  const ss = (liveEvent.substeps || []).find((s) => s.name === stepName);
  return ss?.detail || "";
}

function mockFlatPipeline() {
  const out = [];
  MOCK_PIPELINE.forEach((p) => {
    out.push({ id: p.id, label: p.label, parent: null });
    (p.children || []).forEach((c) =>
      out.push({ id: c.id, label: c.label, parent: p.id }),
    );
  });
  return out;
}

function mockStatus(stepId) {
  const idx = state.processing.steps.indexOf(stepId);
  if (idx === -1) return "pending";
  if (idx < state.processing.activeIndex) return "done";
  if (idx === state.processing.activeIndex) return "active";
  return "pending";
}

function liveStepsMarkup() {
  // Render in canonical order; show detail under the step label.
  return LIVE_STEPS.map((name) => {
    const status = liveStepStatus(name);
    const detail = liveStepDetail(name);
    const cls = status === "in_progress" ? "active" : status === "complete" ? "done" : status;
    return `<div class="processing-step" data-state="${cls}">
      <span class="processing-step-icon">${symbol(status)}</span>
      <span>${stepLabel(name)}${detail ? `<small style="display:block;color:var(--text-tertiary);font-size:11px">${escapeHtml(detail)}</small>` : ""}</span>
      <span class="processing-progress">${status === "in_progress" ? "..." : ""}</span>
    </div>`;
  }).join("");
}

function mockStepsMarkup() {
  return MOCK_PIPELINE.map((p) => {
    const s = mockStatus(p.id);
    const childMarkup = (p.children || [])
      .map((c) => {
        const cs = mockStatus(c.id);
        return `<div class="processing-step processing-substep" data-state="${cs}">
          <span class="processing-step-icon">${symbol(cs)}</span>
          <span>└── ${c.label}</span>
        </div>`;
      })
      .join("");
    return `<div class="processing-step" data-state="${s}">
      <span class="processing-step-icon">${symbol(s)}</span>
      <span>${p.label}</span>
      <span class="processing-progress">${s === "active" ? "..." : ""}</span>
    </div>${childMarkup}`;
  }).join("");
}

function progressPercent() {
  if (state.newProject.processingMode === "live") {
    return Math.round((liveEvent?.progress ?? 0) * 100);
  }
  const total = mockFlatPipeline().length;
  if (total === 0) return 0;
  const idx = Math.max(0, Math.min(state.processing.activeIndex + 1, total));
  return Math.round((idx / total) * 100);
}

function isComplete() {
  if (state.newProject.processingMode === "live") {
    return Boolean(liveTerminal && liveTerminal.status === "completed");
  }
  return state.processing.activeIndex >= mockFlatPipeline().length;
}

function isFailed() {
  return state.newProject.processingMode === "live"
    && liveTerminal
    && (liveTerminal.status === "failed" || liveTerminal.status === "timeout");
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(host) {
  activeHost = host;
  const pct = progressPercent();
  const live = state.newProject.processingMode === "live";
  const stepsMarkup = live ? liveStepsMarkup() : mockStepsMarkup();
  const subtitle = isFailed()
    ? `Parsing failed${liveTerminal?.errorCode ? ` (${liveTerminal.errorCode})` : ""}.`
    : isComplete()
      ? `Workspace ready.`
      : `CivilAgent is setting up your workspace.`;

  mount(
    host,
    `<div class="processing">
      <header class="projects-home-topbar">
        <div class="projects-home-brand"><span class="projects-home-brand-mark">CA</span><span>CivilAgent</span></div>
        <span class="last-sync">${live ? "Parsing" : "Setting up"} · ${pct}%</span>
      </header>
      <main class="processing-body">
        <div class="processing-card">
          <div>
            <h1 class="processing-title">${escapeHtml(state.newProject.name || "New project")}</h1>
            <p class="processing-subtitle">${subtitle}</p>
          </div>
          <div class="processing-steps">
            ${stepsMarkup}
          </div>
          <div id="processing-cta"></div>
        </div>
        <aside class="processing-preview" data-preview></aside>
      </main>
    </div>`,
  );

  const previewHost = host.querySelector("[data-preview]");
  if (previewHost && !preview) {
    preview = new ThreeCanvas(previewHost);
    preview.mount();
    let angle = Math.PI / 4;
    const tick = () => {
      if (!preview || !preview.controls) return;
      angle += 0.001;
      preview.controls.target.set(70, 30, 40);
      preview.activeCamera.position.set(70 + Math.cos(angle) * 220, 130, 40 + Math.sin(angle) * 220);
      preview.activeCamera.lookAt(preview.controls.target);
      preview.needsRender = true;
      preview.__rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  // Refresh the preview canvas when geometry arrives mid-pipeline.
  if (preview && state.newProject.parsedGeometry && !preview.__appliedGeometry) {
    try {
      preview.applyParsedGeometry(state.newProject.parsedGeometry);
      preview.__appliedGeometry = true;
    } catch (e) {
      console.warn("[CivilAgent] preview applyParsedGeometry failed:", e);
    }
  }

  const cta = host.querySelector("#processing-cta");
  if (!cta) return;

  if (isFailed()) {
    cta.innerHTML = btn("Back to projects →", { variant: "secondary", data: { action: "back-home" } });
    cta.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action='back-home']");
      if (t) {
        cleanup();
        window.location.hash = "#/";
      }
    }, { once: true });
    return;
  }

  if (isComplete()) {
    cta.innerHTML = btn("Open workspace →", { variant: "primary", data: { action: "open-workspace" } });
    cta.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action='open-workspace']");
      if (t) {
        cleanup();
        const pid = state.newProject.projectId || "8th-street";
        navigateToProject(pid, "geometry");
      }
    }, { once: true });
  }
}

// ---------------------------------------------------------------------------
// Mock pipeline driver
// ---------------------------------------------------------------------------

function startMockPipeline() {
  const all = mockFlatPipeline();
  set("processing.steps", all.map((s) => s.id));
  set("processing.activeIndex", 0);

  const tick = () => {
    if (!activeHost || !document.body.contains(activeHost)) return;
    render(activeHost);
    if (state.processing.activeIndex >= all.length) {
      mockTimer = setTimeout(() => {
        if (!activeHost || !document.body.contains(activeHost)) return;
        cleanup();
        navigateToProject("8th-street", "geometry");
      }, 1200);
      return;
    }
    const step = all[state.processing.activeIndex];
    const node = MOCK_PIPELINE.find((p) => p.id === step.id) ||
      MOCK_PIPELINE.flatMap((p) => p.children || []).find((c) => c.id === step.id) || { duration: 400 };
    mockTimer = setTimeout(() => {
      set("processing.activeIndex", state.processing.activeIndex + 1);
      tick();
    }, node.duration);
  };
  tick();
}

async function fetchGeometryWithRetry(projectId, geometryId, attempts = 8, delayMs = 350) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const resp = await fetchGeometry(projectId, geometryId);
      if (resp?.geometry) return resp;
      // No geometry yet but the response was 200 — keep waiting.
    } catch (err) {
      // 404 right after terminal can happen if the WS event arrived
      // before the row was visible. Treat as transient.
      if (err?.status && err.status >= 500) throw err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live pipeline driver
// ---------------------------------------------------------------------------

function startLivePipeline() {
  liveEvent = null;
  liveTerminal = null;

  const geometryId = state.newProject.geometryId;
  if (!geometryId) {
    // Shouldn't happen; safety net = degrade to mock.
    set("newProject.processingMode", "mock");
    startMockPipeline();
    return;
  }

  liveSub = subscribeProgress(geometryId, {
    onEvent: (ev) => {
      liveEvent = ev;
      if (activeHost && document.body.contains(activeHost)) render(activeHost);
    },
    onTerminal: async (ev) => {
      liveTerminal = ev;
      if (ev.status === "completed" || ev.status === "partial") {
        // The worker publishes its terminal progress event BEFORE the
        // geometry row is committed (parser → sink → worker → DB), so a
        // naive GET right here can race the worker. Retry briefly.
        const projectId = state.newProject.projectId;
        const envelope = await fetchGeometryWithRetry(projectId, ev.geometryId);
        if (envelope?.geometry) {
          set("newProject.parsedGeometry", envelope.geometry);
          set("newProject.processingStatus", "ready");
          // Pre-populate the cache so every UI surface that reads from
          // it (3D viewport, 2D plan, bottom tray, inspector) shows
          // real data the moment the workspace opens — no empty-card
          // flash while a follow-up fetch runs.
          try {
            seedParsedGeometry(projectId, envelope.geometry, {
              geometryId: envelope.id ?? ev.geometryId,
              version: envelope.version,
              parseStatus: envelope.parseStatus,
              reviewStatus: envelope.reviewStatus,
              createdAt: envelope.createdAt,
              completedAt: envelope.completedAt,
              acceptedAt: envelope.acceptedAt,
              acceptedBy: envelope.acceptedBy,
            });
          } catch (seedErr) {
            // Seeding is a perf optimisation — never fatal.
            console.warn("[CivilAgent] Failed to seed geometry cache:", seedErr);
          }
          // Kick off scheme generation in the background so the workspace
          // opens with variants already computing. Fire-and-forget — errors
          // are non-fatal; the user can trigger generation manually from the
          // Schemes page if the auto-trigger misses.
          _autoTriggerSchemes(projectId).catch(() => {});
        } else {
          set("newProject.processingStatus", "error");
          set("newProject.processingError", "Geometry fetch timed out after parse completed.");
        }
      } else {
        set("newProject.processingStatus", "error");
        set("newProject.processingError", ev.errorCode || ev.detail || "Parse failed");
      }
      if (activeHost && document.body.contains(activeHost)) render(activeHost);
    },
    onError: (err) => {
      console.warn("[CivilAgent] progress WS error:", err);
    },
    onClose: () => {
      // No-op; terminal handler already recorded the result.
    },
  });
}

// ---------------------------------------------------------------------------
// Auto-trigger scheme generation after a successful parse
// ---------------------------------------------------------------------------

/**
 * Enqueue scheme generation immediately after geometry becomes available.
 * Runs silently in the background — errors are swallowed so a transient
 * API hiccup doesn't affect the parse success screen.
 *
 * The worker will archive any old schemes and generate fresh variants under
 * the new geometry_id, so this is safe to call even when schemes already
 * exist for the project.
 */
async function _autoTriggerSchemes(projectId) {
  if (!projectId) return;
  try {
    await triggerGenerateSchemes(projectId, {});
    toast("Generating column layouts in background…", { duration: 3500 });
  } catch (err) {
    // Non-fatal — user can trigger manually from the Schemes page.
    console.info("[CivilAgent] Auto scheme generation skipped:", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function cleanup() {
  if (mockTimer) {
    clearTimeout(mockTimer);
    mockTimer = null;
  }
  if (liveSub) {
    try { liveSub.close(); } catch { /* ignore */ }
    liveSub = null;
  }
  if (preview) {
    if (preview.__rafId) cancelAnimationFrame(preview.__rafId);
    preview.unmount();
    preview = null;
  }
}

export function renderProcessing(host) {
  host.className = "stage";
  render(host);
  const mode = state.newProject.processingMode;
  if (mode === "live") {
    startLivePipeline();
  } else {
    startMockPipeline();
  }
}

export function leaveProcessing() {
  cleanup();
}
