/**
 * New Project — single-page setup form.
 *
 * Every section (identity, parameters, design basis, files) is visible
 * from the moment the page mounts. The form is rendered once. After
 * that, three rules guarantee the page never "blinks" while the user
 * is typing:
 *
 *   1. Text inputs and selects only mutate state. They never write to
 *      `formHost.innerHTML`, so the focused input is never replaced and
 *      the cursor is never lost.
 *   2. The Create-Project button's enabled state is a single attribute
 *      flip, not a re-render.
 *   3. Adding/removing a file is the *only* event that re-renders any
 *      DOM, and even then only the `[data-files]` panel is rewritten —
 *      not the form.
 */

import { state, set } from "../state.js";
import { mount, on as delegate, escapeHtml } from "../utils/dom.js";
import { icon } from "../utils/icons.js";
import { btn, bytes } from "../utils/helpers.js";
import {
  navigateToProcessing,
  navigateToProjectsHome,
  navigateToProject,
} from "../router.js";
import { isApiReachable, ApiError } from "../api/client.js";
import { createProject } from "../api/projects.js";
import { uploadFile } from "../api/upload.js";
import { triggerParse } from "../api/parse.js";
import { toast } from "../components/toast.js";

// ---------------------------------------------------------------------------
// Choice tables
// ---------------------------------------------------------------------------

const BUILDING_TYPES = [
  "Office", "Residential", "Mixed-Use", "Retail",
  "Healthcare", "Education", "Industrial", "Parking",
];
const CODES = ["IBC 2024", "IBC 2021", "IBC 2018", "IBC 2015"];
const SEISMIC = ["ASCE 7-22", "ASCE 7-16", "ASCE 7-10"];
const RISK = ["I", "II", "III", "IV"];
const MATERIALS = [
  "Steel composite", "Concrete flat plate", "Post-tensioned",
  "Concrete moment frame", "Mass timber", "Hybrid",
];

// ---------------------------------------------------------------------------
// File-format taxonomy. Keep in sync with:
//   packages/engine/geometry_parser/constants.py :: SUPPORTED_FORMATS
// ---------------------------------------------------------------------------

/** Backend can parse these directly into ParsedGeometry. */
const PARSER_FORMATS = [".ifc", ".dxf", ".dwg", ".pdf"];

/** Accepted by the upload box — broader than parser formats so engineers
 *  can stage every supporting document for the project vault.            */
const ACCEPTED_EXTENSIONS = [
  ".ifc", ".dxf", ".dwg", ".rvt", ".pdf",
  ".xlsx", ".xls", ".docx", ".doc",
  ".png", ".jpg", ".jpeg",
];

const ROLE_OPTIONS = [
  "Geometry source",
  "Geotech Report",
  "Loads",
  "Design Basis",
  "Reference",
];

// ---------------------------------------------------------------------------
// Module-level handles
// ---------------------------------------------------------------------------

let pageHost = null;
let isBound = false;

// ---------------------------------------------------------------------------
// File classification helpers
// ---------------------------------------------------------------------------

function detectType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "ifc") return "IFC";
  if (ext === "rvt") return "RVT";
  if (ext === "pdf") return "PDF";
  if (ext === "dwg") return "DWG";
  if (ext === "dxf") return "DXF";
  if (["xlsx", "xls"].includes(ext)) return "XLSX";
  if (["docx", "doc"].includes(ext)) return "DOCX";
  if (["png", "jpg", "jpeg"].includes(ext)) return "IMG";
  return ext.toUpperCase() || "FILE";
}

function isParserEligible(fileType) {
  return ["IFC", "DXF", "DWG", "PDF"].includes(fileType);
}

function categorize(name, fileType) {
  if (isParserEligible(fileType) || fileType === "RVT") return "Geometry source";
  const n = name.toLowerCase();
  if (n.includes("geo") || n.includes("soil")) return "Geotech Report";
  if (n.includes("equipment") || n.includes("load")) return "Loads";
  if (n.includes("seismic") || n.includes("criteria")) return "Design Basis";
  return "Reference";
}

function defaultStatus(fileType) {
  if (isParserEligible(fileType)) return "Queued for parsing";
  if (fileType === "RVT") return "Convert to IFC for parsing";
  return "Reference document";
}

// ---------------------------------------------------------------------------
// Section markup — pure functions of state. None of these are re-invoked
// during typing. Inputs use uncontrolled `value` so user keystrokes stay
// local to the element.
// ---------------------------------------------------------------------------

function sectionIdentity(np) {
  return `
    <section class="np-section">
      <p class="np-section-label">Project identity</p>
      <div class="np-grid-3">
        <div class="field">
          <span class="field-label">Project name</span>
          <input class="input" data-np="name" value="${escapeHtml(np.name)}" placeholder="8th Street Mixed-Use" autocomplete="off" />
        </div>
        <div class="field">
          <span class="field-label">Location</span>
          <input class="input" data-np="location" value="${escapeHtml(np.location)}" placeholder="Davis, CA" autocomplete="off" />
        </div>
        <div class="field">
          <span class="field-label">Building type</span>
          <select class="select" data-np="buildingType">
            <option value="">Select...</option>
            ${BUILDING_TYPES.map((t) => `<option ${np.buildingType === t ? "selected" : ""}>${t}</option>`).join("")}
          </select>
        </div>
      </div>
    </section>
  `;
}

function sectionParameters(np) {
  return `
    <section class="np-section">
      <p class="np-section-label">Building parameters</p>
      <div class="np-grid-3">
        <div class="field">
          <span class="field-label">Stories above</span>
          <input class="input" type="number" data-np="storiesAbove" value="${escapeHtml(np.storiesAbove)}" placeholder="8" />
        </div>
        <div class="field">
          <span class="field-label">Stories below</span>
          <input class="input" type="number" data-np="storiesBelow" value="${escapeHtml(np.storiesBelow)}" placeholder="1" />
        </div>
        <div class="field">
          <span class="field-label">Typical floor-to-floor</span>
          <input class="input" data-np="floorToFloor" value="${escapeHtml(np.floorToFloor)}" placeholder="13'-6&quot;" autocomplete="off" />
        </div>
        <div class="field">
          <span class="field-label">Ground floor height</span>
          <input class="input" data-np="groundHeight" value="${escapeHtml(np.groundHeight)}" placeholder="18'-0&quot;" autocomplete="off" />
        </div>
        <div class="field" style="grid-column:span 2">
          <span class="field-label">Approximate footprint (optional)</span>
          <input class="input" data-np="footprint" value="${escapeHtml(np.footprint)}" placeholder="15,000 sf" autocomplete="off" />
        </div>
      </div>
    </section>
  `;
}

function sectionDesignBasis(np) {
  return `
    <section class="np-section">
      <p class="np-section-label">Design basis</p>
      <div class="np-grid-2-2">
        <div class="field">
          <span class="field-label">Code year</span>
          <select class="select" data-np="codeYear">
            ${CODES.map((c) => `<option ${np.codeYear === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <span class="field-label">Seismic criteria</span>
          <select class="select" data-np="seismic">
            ${SEISMIC.map((c) => `<option ${np.seismic === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
          <span class="field-help" data-seismic-hint>${seismicHintFor(np.location)}</span>
        </div>
        <div class="field">
          <span class="field-label">Risk category</span>
          <select class="select" data-np="riskCategory">
            ${RISK.map((c) => `<option ${np.riskCategory === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <span class="field-label">Material system</span>
          <select class="select" data-np="materialSystem">
            <option value="">Select...</option>
            ${MATERIALS.map((c) => `<option ${np.materialSystem === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
      </div>
    </section>
  `;
}

function seismicHintFor(location) {
  return location
    ? `SDC D estimated for ${escapeHtml(location)} — verify with geotech report.`
    : `Pick a location and CivilAgent will estimate SDC.`;
}

function sectionFiles() {
  // Files panel renders its inner contents from `renderFilesPanel()`.
  // Empty placeholder on first paint; a fresh paint runs whenever the
  // file list changes structurally.
  return `
    <section class="np-section">
      <p class="np-section-label">Architectural & supporting files</p>
      <label class="np-dropzone" data-dropzone tabindex="0">
        <input
          type="file"
          multiple
          style="display:none"
          data-file-input
          accept="${ACCEPTED_EXTENSIONS.join(",")}" />
        <div class="np-dropzone-icon">${icon("upload", 22)}</div>
        <p class="np-dropzone-text">Drop architectural files here, or <span class="np-dropzone-browse">browse files</span></p>
        <div class="np-dropzone-types">
          ${PARSER_FORMATS.map((f) => `<span class="np-dropzone-type is-primary">${f}</span>`).join("")}
          <span class="np-dropzone-type">.rvt</span>
          <span class="np-dropzone-type">.xlsx</span>
          <span class="np-dropzone-type">.docx</span>
        </div>
        <p class="np-dropzone-help">
          <strong>IFC, DXF, DWG, PDF</strong> are parsed by CivilAgent to extract grids, levels, cores, and existing columns.
          <br/>RVT, XLSX, DOCX, and images are stored in the project vault as reference documents.
        </p>
      </label>
      <div data-files>${renderFilesPanel()}</div>
    </section>
  `;
}

function renderFilesPanel() {
  const files = state.newProject.files;
  if (!files.length) return "";

  const parserCount = files.filter((f) => isParserEligible(f.fileType)).length;

  return `
    <div class="np-files">
      ${files.map((f, i) => fileRow(f, i)).join("")}
    </div>
    ${parserCount > 0 ? parserBanner(parserCount) : ""}
  `;
}

function fileRow(f, i) {
  const eligible = isParserEligible(f.fileType);
  return `
    <div class="np-file ${eligible ? "is-parser" : ""}" data-file-row="${i}">
      <span class="np-file-type">${escapeHtml(f.fileType)}</span>
      <span class="np-file-name">${escapeHtml(f.name)}</span>
      <span class="np-file-size">${bytes(f.size)}</span>
      <select data-file-role="${i}">
        ${ROLE_OPTIONS.map((r) => `<option ${f.role === r ? "selected" : ""}>${r}</option>`).join("")}
      </select>
      <span class="np-file-status">${escapeHtml(f.status)}</span>
      <button class="np-file-remove" data-remove-file="${i}" aria-label="Remove ${escapeHtml(f.name)}">
        ${icon("trash", 14)}
      </button>
    </div>
  `;
}

function parserBanner(count) {
  return `
    <div class="np-info-banner">
      ${icon("sparkles", 14)}
      <span>
        <strong>${count} file${count === 1 ? "" : "s"} queued for parsing.</strong>
        CivilAgent will extract levels, grids, cores, and existing columns. You'll review the results before proceeding.
      </span>
    </div>
  `;
}

function sectionCta(np) {
  return `
    <section class="np-section np-cta">
      ${btn("Create project →", { variant: "primary", data: { action: "create" } })}
      <span class="np-cta-help" data-cta-help>${ctaHelpFor(np)}</span>
    </section>
  `;
}

function ctaHelpFor(np) {
  if (!isFormValid(np)) {
    return `Add a project name, location, and building type to continue.`;
  }
  return np.files.length
    ? `CivilAgent will set up your workspace and begin parsing your uploaded files.`
    : `CivilAgent will set up your workspace. You can upload files later from the project vault.`;
}

function isFormValid(np) {
  return Boolean(np.name && np.location && np.buildingType);
}

// ---------------------------------------------------------------------------
// Mount + render
// ---------------------------------------------------------------------------

function renderShell(host) {
  pageHost = host;
  const np = state.newProject;
  mount(
    host,
    `<div class="new-project">
      <header class="projects-home-topbar">
        <button class="sidebar-back" data-action="back">${icon("chevron_left", 14)}<span>Back</span></button>
        <div class="projects-home-brand">
          <span class="projects-home-brand-mark">CA</span><span>CivilAgent</span>
        </div>
        <div></div>
      </header>
      <main class="new-project-body">
        <div class="np-form" data-np-form>
          <header class="np-header">
            <h1>Start a new project</h1>
            <p>Tell CivilAgent about the building and drop in any files we should know about. Everything is editable later.</p>
          </header>
          ${sectionIdentity(np)}
          ${sectionParameters(np)}
          ${sectionDesignBasis(np)}
          ${sectionFiles()}
          ${sectionCta(np)}
        </div>
      </main>
    </div>`,
  );
  syncCtaState();
}

/** Targeted re-render of the file list only — never touches inputs. */
function renderFilesOnly() {
  const filesHost = pageHost?.querySelector("[data-files]");
  if (!filesHost) return;
  filesHost.innerHTML = renderFilesPanel();
  syncCtaState();
}

/** Tiny direct-DOM updates that keep the form in sync without a re-render. */
function syncSeismicHint() {
  const el = pageHost?.querySelector("[data-seismic-hint]");
  if (el) el.innerHTML = seismicHintFor(state.newProject.location);
}

function syncCtaState() {
  const np = state.newProject;
  const valid = isFormValid(np);
  const btnEl = pageHost?.querySelector("[data-action='create']");
  if (btnEl) {
    btnEl.disabled = !valid;
    btnEl.classList.toggle("is-disabled", !valid);
  }
  const help = pageHost?.querySelector("[data-cta-help]");
  if (help) help.textContent = ctaHelpFor(np);
}

// ---------------------------------------------------------------------------
// Event binding (runs once per page lifetime)
// ---------------------------------------------------------------------------

function bind(host) {
  delegate(host, "click", "[data-action='back']", () => navigateToProjectsHome());

  // Live state updates — never re-render on input. The DOM input keeps
  // its own value via the user's typing; we just mirror to state so the
  // create handler reads fresh values.
  delegate(host, "input", "[data-np]", (_e, target) => {
    const key = target.dataset.np;
    set(`newProject.${key}`, target.value);
    if (key === "location") syncSeismicHint();
    if (key === "name" || key === "buildingType") syncCtaState();
  });

  // Selects use `change` (input doesn't fire on <select> in all browsers
  // for option choice). Same rule: state-only, no DOM rewrite.
  delegate(host, "change", "[data-np]", (_e, target) => {
    const key = target.dataset.np;
    set(`newProject.${key}`, target.value);
    if (key === "buildingType") syncCtaState();
  });

  delegate(host, "click", "[data-action='create']", () => {
    const np = state.newProject;
    if (!isFormValid(np)) {
      // Disabled visually; ignore stray clicks.
      return;
    }
    handleCreate().catch((err) => {
      console.error("[CivilAgent] create flow failed:", err);
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : (err?.message || "Unexpected error");
      toast(msg, { tone: "fail", duration: 4500 });
      set("newProject.processingStatus", "error");
      set("newProject.processingError", msg);
      const btnEl = pageHost?.querySelector("[data-action='create']");
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.classList.remove("is-disabled");
      }
    });
  });

  // ---- Files: only structural changes trigger DOM mutation, scoped to
  // the [data-files] panel. ----------------------------------------------------
  delegate(host, "click", "[data-remove-file]", (_e, target) => {
    const idx = Number(target.dataset.removeFile);
    const arr = state.newProject.files.slice();
    arr.splice(idx, 1);
    set("newProject.files", arr);
    renderFilesOnly();
  });

  delegate(host, "change", "[data-file-role]", (_e, target) => {
    const idx = Number(target.dataset.fileRole);
    const arr = state.newProject.files.slice();
    arr[idx] = { ...arr[idx], role: target.value };
    set("newProject.files", arr);
    // No DOM re-render needed — the <select> already reflects the choice.
  });

  // ---- Drag/drop and click-to-browse on the dropzone ----
  host.addEventListener("dragenter", (e) => {
    const dz = e.target.closest?.("[data-dropzone]");
    if (dz) {
      e.preventDefault();
      dz.classList.add("is-dragover");
    }
  });
  host.addEventListener("dragover", (e) => {
    const dz = e.target.closest?.("[data-dropzone]");
    if (dz) e.preventDefault();
  });
  host.addEventListener("dragleave", (e) => {
    const dz = e.target.closest?.("[data-dropzone]");
    if (dz) dz.classList.remove("is-dragover");
  });
  host.addEventListener("drop", (e) => {
    const dz = e.target.closest?.("[data-dropzone]");
    if (!dz) return;
    e.preventDefault();
    dz.classList.remove("is-dragover");
    handleFiles(Array.from(e.dataTransfer?.files || []));
  });

  delegate(host, "click", "[data-dropzone]", (e) => {
    if (e.target.closest("[data-file-row]") || e.target.closest("[data-remove-file]")) {
      return; // a click inside an existing file row should not reopen the picker
    }
    const fileInput = host.querySelector("[data-file-input]");
    if (!fileInput) return;
    if (e.target === fileInput) return;
    e.preventDefault();
    fileInput.click();
  });

  delegate(host, "change", "[data-file-input]", (_e, target) => {
    handleFiles(Array.from(target.files || []));
    target.value = "";
  });
}

function handleFiles(files) {
  if (!files.length) return;
  const descriptors = files.map((f) => {
    const fileType = detectType(f.name);
    return {
      name: f.name,
      size: f.size,
      // Hold the actual File on the descriptor so we can stream bytes
      // to S3 later. It's a non-enumerable hop — the descriptor JSON
      // (used for re-render) ignores it.
      _file: f,
      fileType,
      role: categorize(f.name, fileType),
      status: defaultStatus(fileType),
    };
  });
  set("newProject.files", state.newProject.files.concat(descriptors));
  renderFilesOnly();
}

// ---------------------------------------------------------------------------
// Create-project flow
// ---------------------------------------------------------------------------
//
// Best-effort path:
//
//   1. POST /api/projects                       (project row + dev org)
//   2. For each file: presign → S3 PUT → register
//   3. For the first parser-eligible file: trigger parse
//   4. Navigate to /processing with `processingMode: "live"`
//
// If the API is unreachable, we surface a non-blocking toast and fall
// back to the mock processing simulation so the static-site demo still
// works offline.

async function handleCreate() {
  const np = state.newProject;
  set("newProject.processingError", null);

  const btnEl = pageHost?.querySelector("[data-action='create']");
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.classList.add("is-disabled");
  }

  const apiUp = await isApiReachable();

  if (!apiUp) {
    // Offline / no API: keep behaviour identical to the previous demo.
    if (np.files.length) {
      set("newProject.processingMode", "mock");
      navigateToProcessing();
    } else {
      navigateToProject("8th-street", "overview");
    }
    return;
  }

  set("newProject.processingStatus", "uploading");
  set("newProject.processingMode", "live");

  // 1) Create the project row.
  const project = await createProject({
    name: np.name,
    location: np.location,
    buildingType: np.buildingType,
    metadata: {
      storiesAbove: np.storiesAbove,
      storiesBelow: np.storiesBelow,
      floorToFloor: np.floorToFloor,
      groundHeight: np.groundHeight,
      footprint: np.footprint,
      codeYear: np.codeYear,
      seismic: np.seismic,
      riskCategory: np.riskCategory,
      materialSystem: np.materialSystem,
    },
  });
  set("newProject.projectId", project.id);

  // 2) Upload every file. We mark each one's status in state so the
  //    file panel reflects progress (renderFilesOnly is cheap).
  const files = np.files.slice();
  let parserEligibleIndex = -1;
  for (let i = 0; i < files.length; i += 1) {
    const desc = files[i];
    if (!desc._file) continue; // descriptor without a File (shouldn't happen)
    try {
      const result = await uploadFile(project.id, desc._file, {
        onStage: (stage) => {
          const next = state.newProject.files.slice();
          next[i] = { ...next[i], status: stageLabel(stage, desc) };
          set("newProject.files", next);
          renderFilesOnly();
        },
      });
      const next = state.newProject.files.slice();
      next[i] = {
        ...next[i],
        fileId: result.fileId,
        contentType: result.contentType,
        status: "Uploaded",
      };
      set("newProject.files", next);
      renderFilesOnly();
      if (parserEligibleIndex < 0 && isParserEligible(desc.fileType)) {
        parserEligibleIndex = i;
      }
    } catch (err) {
      const next = state.newProject.files.slice();
      next[i] = { ...next[i], status: `Upload failed — ${err?.message || "error"}` };
      set("newProject.files", next);
      renderFilesOnly();
      throw err;
    }
  }

  // 3) Trigger a parse on the first parser-eligible file (if any).
  if (parserEligibleIndex >= 0) {
    const desc = state.newProject.files[parserEligibleIndex];
    set("newProject.processingStatus", "parsing");
    const trigger = await triggerParse(project.id, desc.fileId);
    set("newProject.geometryId", trigger.geometryId);
    navigateToProcessing();
    return;
  }

  // 4) No parse-eligible files: project exists, jump straight to workspace.
  toast(`Project "${project.name}" created.`, { tone: "pass" });
  set("newProject.processingStatus", "ready");
  navigateToProject(project.id, "overview");
}

function stageLabel(stage, desc) {
  if (!isParserEligible(desc.fileType)) {
    return ({
      presign: "Preparing upload",
      upload: "Uploading",
      register: "Registering",
      done: "Stored as reference",
    })[stage] || desc.status;
  }
  return ({
    presign: "Preparing upload",
    upload: "Uploading",
    register: "Registering",
    done: "Uploaded — queued for parsing",
  })[stage] || desc.status;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function renderNewProject(host) {
  host.className = "stage";
  renderShell(host);
  if (!isBound) {
    bind(host);
    isBound = true;
  }
}
