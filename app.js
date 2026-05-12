const icons = {
  projects: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7 7 0 0 0-2-1.1L14.2 3h-4.4l-.4 2.7a7 7 0 0 0-2 1.1l-2.4-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.1l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.1l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z"/></svg>',
  model: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M12 12 4 7.5M12 12l8-4.5M12 12v9"/></svg>',
  table: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 10h16M9 5v14"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6"/></svg>',
  wand: '<svg viewBox="0 0 24 24"><path d="m14 4 6 6L9 21l-6-6L14 4Z"/><path d="m14 4 6 6"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 4 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/></svg>',
  measure: '<svg viewBox="0 0 24 24"><path d="M4 17 17 4l3 3L7 20l-3-3Z"/><path d="m13 8 3 3M9 12l2 2"/></svg>',
  select: '<svg viewBox="0 0 24 24"><path d="m5 3 7 17 2-7 7-2L5 3Z"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M6 10h12v10H6z"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  warning: '<svg viewBox="0 0 24 24"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m20 6-11 11-5-5"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7"/><path d="m10 14 11-11"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-4 3 2 5-7"/></svg>',
};

const workspacePages = [
  ["overview", "Overview", "projects"],
  ["geometry", "Geometry", "model"],
  ["assumptions", "Assumptions", "table"],
  ["placement", "Placement", "model"],
  ["loads", "Loads", "chart"],
  ["schemes", "Schemes", "model"],
  ["sizing", "Sizing", "warning"],
  ["vault", "Vault", "file"],
  ["reports", "Reports", "export"],
  ["settings", "Settings", "settings"],
];

const modelPages = ["geometry", "placement", "loads", "schemes", "sizing"];

const project = {
  id: "8th-street",
  name: "8th Street Mixed-Use",
  location: "Davis, CA",
  codeBasis: "IBC 2021 / ASCE 7-16",
  materialSystem: "Steel with composite slab",
  activeSchemeId: "A",
  activeAssumptionSetId: "Set v3",
  status: "Draft",
  lastRecalculatedAt: "12 min ago",
};

const projects = [
  { id: "8th-street", name: "8th Street Mixed-Use", location: "Davis, CA", code: "IBC 2021 / Steel", status: "Draft", updated: "Today" },
  { id: "river-lab", name: "River Lab Addition", location: "Sacramento, CA", code: "CBC 2022 / Concrete", status: "Needs Review", updated: "Yesterday" },
  { id: "northline", name: "Northline Garage", location: "Reno, NV", code: "IBC 2024 / Hybrid", status: "Ready", updated: "Apr 24" },
];

const levels = [
  { id: "L1", name: "Level 1", elevation: 0, height: 15 },
  { id: "L2", name: "Level 2", elevation: 15, height: 13 },
  { id: "L6", name: "Level 6", elevation: 67, height: 13 },
  { id: "L8", name: "Roof", elevation: 93, height: 0 },
];

const gridLines = [
  { id: "G1", axis: "x", label: "1", coordinate: 170, locked: true, confidence: "100%" },
  { id: "G2", axis: "x", label: "2", coordinate: 285, locked: true, confidence: "98%" },
  { id: "G3", axis: "x", label: "3", coordinate: 400, locked: false, confidence: "96%" },
  { id: "G4", axis: "x", label: "4", coordinate: 515, locked: false, confidence: "92%" },
  { id: "G5", axis: "x", label: "5", coordinate: 630, locked: false, confidence: "84%" },
  { id: "G6", axis: "x", label: "6", coordinate: 745, locked: true, confidence: "96%" },
  { id: "GA", axis: "y", label: "A", coordinate: 160, locked: true, confidence: "100%" },
  { id: "GB", axis: "y", label: "B", coordinate: 250, locked: true, confidence: "96%" },
  { id: "GC", axis: "y", label: "C", coordinate: 340, locked: true, confidence: "93%" },
  { id: "GD", axis: "y", label: "D", coordinate: 430, locked: false, confidence: "89%" },
];

const cores = [
  { id: "CORE-1", type: "mixed", boundary: [275, 215, 90, 130], levels: "L1-L8", conflicts: "None" },
  { id: "CORE-2", type: "service", boundary: [650, 200, 92, 135], levels: "L1-L8", conflicts: "Opening review near Grid 5" },
];

const noColumnZones = [
  { id: "NCZ-1", name: "L1 lobby", boundary: [165, 305, 150, 90], reason: "Architectural clear-span lobby", source: "Floor_Plans_A1-A8.pdf" },
  { id: "NCZ-2", name: "Atrium", boundary: [585, 350, 160, 82], reason: "Long-span atrium void", source: "Architectural_Model_Level_Set.rvt" },
];

const columns = [
  { id: "C1", gridLabel: "A-1", x: 170, y: 160, startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "620 sf", axialLoad: "510 kip", dcr: 0.68, status: "pass", locked: true, source: "engineer" },
  { id: "C4", gridLabel: "C-4", x: 515, y: 340, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "740 sf", axialLoad: "640 kip", dcr: 0.74, status: "pass", locked: false, source: "generated" },
  { id: "C8", gridLabel: "D-6", x: 745, y: 430, startLevel: "L1", endLevel: "L8", size: "W14x99", tributaryArea: "810 sf", axialLoad: "720 kip", dcr: 0.88, status: "warning", locked: false, source: "generated" },
  { id: "C12", gridLabel: "B-5", x: 630, y: 250, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "680 sf", axialLoad: "598 kip", dcr: 0.81, status: "pass", locked: false, source: "imported" },
];

const beams = [
  { id: "B12", start: [170, 160], end: [745, 130], levelId: "L6", span: "28.0 ft", size: "W18x35", tributaryWidth: "12.5 ft", uniformLoad: "1.15 klf", momentDemand: "184 kip-ft", shearDemand: "42 kip", dcr: 0.82, governingCheck: "Flexure", status: "pass", locked: false },
  { id: "B21", start: [165, 340], end: [820, 305], levelId: "L6", span: "31.8 ft", size: "W21x44", tributaryWidth: "13.5 ft", uniformLoad: "1.32 klf", momentDemand: "318 kip-ft", shearDemand: "76 kip", dcr: 0.96, governingCheck: "Live-load deflection", status: "warning", locked: false },
  { id: "B33", start: [195, 470], end: [850, 430], levelId: "L6", span: "30.2 ft", size: "W18x40", tributaryWidth: "11.8 ft", uniformLoad: "1.08 klf", momentDemand: "228 kip-ft", shearDemand: "50 kip", dcr: 0.72, governingCheck: "Flexure", status: "pass", locked: false },
  { id: "B66", start: [745, 130], end: [785, 430], levelId: "L6", span: "29.5 ft", size: "W18x35", tributaryWidth: "14.0 ft", uniformLoad: "1.40 klf", momentDemand: "334 kip-ft", shearDemand: "80 kip", dcr: 1.02, governingCheck: "Vibration", status: "fail", locked: false },
];

const shearWalls = [
  { id: "SW1", direction: "N-S", boundary: [288, 210, 20, 132], length: "32 ft", thickness: "12 in", levels: "L1-L8", driftContribution: "34%", dcr: 0.86, status: "pass", locked: true },
  { id: "SW2", direction: "E-W", boundary: [655, 202, 92, 18], length: "44 ft", thickness: "12 in", levels: "L1-L8", driftContribution: "42%", dcr: 1.04, status: "fail", locked: false },
];

const braces = [
  { id: "BR7", start: [285, 250], end: [400, 340], levels: "L1-L4", frameLine: "Grid B", dcr: 0.79, status: "pass" },
  { id: "BR9", start: [630, 250], end: [745, 340], levels: "L3-L8", frameLine: "Grid 5", dcr: 0.91, status: "warning" },
];

const slabZones = [
  { id: "SLAB-A", boundary: [145, 125, 700, 350], system: "Composite slab", thickness: "3.25 in LW concrete on 2 in deck", loadPsf: "70 psf", status: "pass" },
  { id: "SLAB-ROOF", boundary: [585, 350, 160, 82], system: "Roof framing zone", thickness: "Metal deck", loadPsf: "95 psf equipment", status: "warning" },
];

const loadCases = [
  { id: "DL", name: "Dead Load", type: "dead", value: 70, units: "psf", source: "Composite slab default", approved: true },
  { id: "LL", name: "Office Live Load", type: "live", value: 50, units: "psf", source: "IBC 2021 occupancy default", approved: true },
  { id: "EQ", name: "Equipment Load", type: "equipment", value: 18, units: "psf", source: "Equipment_Load_Schedule.xlsx", approved: false },
  { id: "W", name: "Wind Base", type: "wind", value: 110, units: "mph", source: "ASCE 7-16", approved: true },
  { id: "E", name: "Seismic", type: "seismic", value: 0.43, units: "Sds", source: "Seismic_Criteria_Memo.pdf", approved: true },
];

const schemes = [
  { id: "A", name: "Balanced Strategy", strategy: "Core walls plus moment frames", status: "active", steel: "421 t", concrete: "318 cy", cost: "1.00x", drift: "H/455", span: "31.8 ft", depth: "24 in", sections: 18, columns: 42, warnings: 2, constructability: 86, disruption: 22, note: "Best overall balance." },
  { id: "B", name: "Minimum Steel Weight", strategy: "Longer spans with optimized beams", status: "generated", steel: "392 t", concrete: "304 cy", cost: "0.97x", drift: "H/412", span: "34.5 ft", depth: "27 in", sections: 24, columns: 38, warnings: 4, constructability: 78, disruption: 24, note: "Lighter but more unique sections." },
  { id: "C", name: "Lowest Cost", strategy: "Simpler members and more repetition", status: "generated", steel: "452 t", concrete: "330 cy", cost: "0.89x", drift: "H/388", span: "29.0 ft", depth: "24 in", sections: 14, columns: 47, warnings: 5, constructability: 91, disruption: 31, note: "Lowest cost but tighter drift margin." },
  { id: "D", name: "Shallow Beam Strategy", strategy: "More columns to control beam depth", status: "generated", steel: "448 t", concrete: "326 cy", cost: "1.04x", drift: "H/440", span: "27.5 ft", depth: "21 in", sections: 21, columns: 54, warnings: 2, constructability: 83, disruption: 39, note: "Controls beam depth with more columns." },
  { id: "E", name: "Least Intrusive", strategy: "Avoids lobby and retail column conflicts", status: "generated", steel: "462 t", concrete: "340 cy", cost: "1.07x", drift: "H/430", span: "36.0 ft", depth: "30 in", sections: 23, columns: 36, warnings: 6, constructability: 74, disruption: 12, note: "Best architectural fit, heavier framing." },
];

const assumptions = [
  { id: "A1", category: "Design basis", label: "Design code", value: "IBC 2021 / ASCE 7-16", units: "", source: "Project setup", sourceDocumentId: "IBC_2021_Project_Criteria.pdf", status: "approved", affects: "load combinations, reports", lastChangedBy: "Harsh Grant", lastChangedAt: "Apr 30, 10:12" },
  { id: "A2", category: "Gravity loads", label: "Office live load", value: "50", units: "psf", source: "IBC default", sourceDocumentId: "IBC_2021_Project_Criteria.pdf", status: "approved", affects: "beams, columns, load takedown", lastChangedBy: "CivilAgent", lastChangedAt: "Apr 30, 10:13" },
  { id: "A3", category: "Gravity loads", label: "Superimposed dead load", value: "20", units: "psf", source: "Firm default", sourceDocumentId: "", status: "default", affects: "all gravity members", lastChangedBy: "CivilAgent", lastChangedAt: "Apr 30, 10:13" },
  { id: "A4", category: "Lateral criteria", label: "Seismic site class", value: "D", units: "", source: "Geotechnical report", sourceDocumentId: "Geotechnical_Report_Final.pdf", status: "extracted", affects: "lateral forces, drift", lastChangedBy: "CivilAgent", lastChangedAt: "Apr 30, 10:14" },
  { id: "A5", category: "Lateral criteria", label: "Allowable bearing pressure", value: "3000", units: "psf", source: "Geotechnical report", sourceDocumentId: "Geotechnical_Report_Final.pdf", status: "needs_review", affects: "foundations, reports", lastChangedBy: "CivilAgent", lastChangedAt: "Apr 30, 10:14" },
  { id: "A6", category: "Project constraints", label: "Max beam depth", value: "24", units: "in", source: "Engineer preference", sourceDocumentId: "", status: "edited", affects: "schemes, sizing", lastChangedBy: "Harsh Grant", lastChangedAt: "Apr 30, 10:18" },
  { id: "A7", category: "Project constraints", label: "Target bay size", value: "25-30", units: "ft", source: "Project setup", sourceDocumentId: "", status: "approved", affects: "placement, schemes", lastChangedBy: "Harsh Grant", lastChangedAt: "Apr 30, 10:19" },
];

const vaultDocuments = [
  { id: "D1", name: "Geotechnical_Report_Final.pdf", category: "Geotechnical", version: "v3", source: "Consultant", fileType: "PDF", aiStatus: "Referenced", updatedAt: "Apr 19", referencedBy: "Site Class D, bearing pressure", reviewStatus: "Needs review", insights: ["Site Class D extracted with 91% confidence.", "Allowable bearing pressure 3000 psf needs approval."] },
  { id: "D2", name: "Architectural_Model_Level_Set.rvt", category: "Architectural", version: "v12", source: "Revit", fileType: "RVT", aiStatus: "Referenced", updatedAt: "Apr 26", referencedBy: "levels, grids, cores", reviewStatus: "Reviewed", insights: ["8 levels, 14 grids, 2 cores, lobby no-column zone."] },
  { id: "D3", name: "Floor_Plans_A1-A8.pdf", category: "Architectural", version: "v6", source: "Drawing set", fileType: "PDF", aiStatus: "Parsed", updatedAt: "Apr 22", referencedBy: "room loading, openings", reviewStatus: "Reviewed", insights: ["Room/zones mapped with 89% confidence."] },
  { id: "D4", name: "Core_Wall_Study_v2.pdf", category: "Structural", version: "v2", source: "Internal", fileType: "PDF", aiStatus: "Referenced", updatedAt: "Apr 24", referencedBy: "lateral scheme", reviewStatus: "Reviewed", insights: ["Core walls viable for lateral system in both directions."] },
  { id: "D5", name: "Topographic_Survey.dwg", category: "Civil", version: "v1", source: "Surveyor", fileType: "DWG", aiStatus: "Uploaded", updatedAt: "Apr 10", referencedBy: "not referenced", reviewStatus: "Open", insights: ["Stored only. Not parsed."] },
  { id: "D6", name: "MEP_Coordination_Model.ifc", category: "MEP", version: "v4", source: "IFC", fileType: "IFC", aiStatus: "Referenced", updatedAt: "Apr 25", referencedBy: "beam clearance warning", reviewStatus: "Needs review", insights: ["Major penetrations near Grid C-4."] },
  { id: "D7", name: "Equipment_Load_Schedule.xlsx", category: "MEP", version: "v2", source: "Spreadsheet", fileType: "XLSX", aiStatus: "Needs review", updatedAt: "Apr 18", referencedBy: "roof loads", reviewStatus: "Needs review", insights: ["Rooftop equipment loads are not mapped to Level 8 bays."] },
  { id: "D8", name: "IBC_2021_Project_Criteria.pdf", category: "Code", version: "v1", source: "Reference", fileType: "PDF", aiStatus: "Parsed", updatedAt: "Apr 04", referencedBy: "load combinations", reviewStatus: "Reviewed", insights: ["Risk category II and drift limits extracted."] },
  { id: "D9", name: "Structural_Design_Narrative.docx", category: "Structural", version: "v5", source: "Internal", fileType: "DOCX", aiStatus: "Referenced", updatedAt: "Apr 27", referencedBy: "scheme ranking", reviewStatus: "Reviewed", insights: ["Prefers member repetition and 24 in max beam depth."] },
  { id: "D10", name: "Existing_Framing_Plans.pdf", category: "Existing", version: "v1", source: "Archive", fileType: "PDF", aiStatus: "Needs review", updatedAt: "Apr 02", referencedBy: "opening conflicts", reviewStatus: "Needs review", insights: ["Existing framing conflict near core opening."] },
  { id: "D11", name: "Seismic_Criteria_Memo.pdf", category: "Structural", version: "v1", source: "Consultant", fileType: "PDF", aiStatus: "Parsed", updatedAt: "Apr 20", referencedBy: "lateral criteria", reviewStatus: "Reviewed", insights: ["Sds 0.43 used in lateral load assumptions."] },
];

const issues = [
  { id: "I1", severity: "Warning", objectType: "beam", objectId: "B21", title: "B21 near capacity", description: "Live-load deflection controls on a 31.8 ft span.", suggestedActions: ["Increase size", "Add support", "Allow deeper beam"], dcr: 0.96 },
  { id: "I2", severity: "Fail", objectType: "shearWall", objectId: "SW2", title: "SW2 failing shear check", description: "Shear demand exceeds capacity under E-W seismic case.", suggestedActions: ["Thicken wall", "Extend wall", "Add paired wall"], dcr: 1.04 },
  { id: "I3", severity: "Warning", objectType: "load", objectId: "EQ", title: "Equipment loads unapproved", description: "Rooftop equipment loads are not mapped to bays.", suggestedActions: ["Open source document", "Map to Level 8", "Approve assumption"], dcr: 0 },
];

const reports = [
  { id: "R1", name: "Structural Narrative", status: "Generated", lastGeneratedAt: "Today 12:18", includedSources: "Scheme A, Assumption Set v3, Vault appendix", missingInputs: "None" },
  { id: "R2", name: "Preliminary Framing Plans", status: "Generated", lastGeneratedAt: "Today 12:20", includedSources: "Active scheme, levels L1-L8", missingInputs: "None" },
  { id: "R3", name: "Member Schedule", status: "Draft", lastGeneratedAt: "Not generated", includedSources: "Sizing model", missingInputs: "Resolve SW2 fail" },
  { id: "R4", name: "Assumption Log", status: "Ready", lastGeneratedAt: "Not generated", includedSources: "Assumption Set v3", missingInputs: "Approve bearing pressure" },
  { id: "R5", name: "Scheme Comparison Summary", status: "Ready", lastGeneratedAt: "Not generated", includedSources: "Schemes A-D", missingInputs: "None" },
  { id: "R6", name: "Load Takedown Summary", status: "Blocked", lastGeneratedAt: "Not generated", includedSources: "Load cases", missingInputs: "Equipment load mapping" },
  { id: "R7", name: "Vault Source Appendix", status: "Ready", lastGeneratedAt: "Not generated", includedSources: "Referenced docs", missingInputs: "Review geotech extraction" },
];

const state = {
  mode: "global",
  page: "overview",
  activeSchemeId: "A",
  assumptionSetId: "Set v3",
  activeLevelId: "L6",
  viewMode: "2d",
  selectedObject: null,
  visibleLayers: {
    architectural: false,
    floorPlates: true,
    grids: true,
    cores: true,
    noColumnZones: true,
    columns: true,
    beams: true,
    shearWalls: true,
    braces: true,
    loads: true,
    tributaryAreas: true,
    warnings: true,
    labels: true,
  },
  showLayers: false,
  bottomOpen: true,
  assistantOpen: false,
  commandOpen: false,
  selectedAssumptionId: "A5",
  selectedDocumentId: "D1",
  vaultTab: "documents",
  compareMode: false,
  recalculating: false,
  lastRecalculatedAt: project.lastRecalculatedAt,
  activeProjectIndex: 0,
  modal: null,
  toasts: [],
};

const app = document.querySelector("#app");
const objectMaps = {
  column: Object.fromEntries(columns.map((item) => [item.id, item])),
  beam: Object.fromEntries(beams.map((item) => [item.id, item])),
  shearWall: Object.fromEntries(shearWalls.map((item) => [item.id, item])),
  brace: Object.fromEntries(braces.map((item) => [item.id, item])),
  core: Object.fromEntries(cores.map((item) => [item.id, item])),
  noColumnZone: Object.fromEntries(noColumnZones.map((item) => [item.id, item])),
  grid: Object.fromEntries(gridLines.map((item) => [item.id, item])),
  slab: Object.fromEntries(slabZones.map((item) => [item.id, item])),
  load: Object.fromEntries(loadCases.map((item) => [item.id, item])),
};

function icon(name) {
  return icons[name] || icons.file;
}

function activeScheme() {
  return schemes.find((scheme) => scheme.id === state.activeSchemeId) || schemes[0];
}

function currentProject() {
  const projectRecord = projects[state.activeProjectIndex] || projects[0];
  const material = projectRecord.code?.split(" / ")[1] || project.materialSystem;
  return {
    ...project,
    ...projectRecord,
    codeBasis: projectRecord.code?.replace(` / ${material}`, "") || project.codeBasis,
    materialSystem: material,
  };
}

function selectedObject() {
  if (!state.selectedObject) return null;
  return objectMaps[state.selectedObject.type]?.[state.selectedObject.id] || null;
}

function activePageLabel() {
  return workspacePages.find(([id]) => id === state.page)?.[1] || "Workspace";
}

function render() {
  app.innerHTML = state.mode === "workspace" ? workspaceShell() : globalShell();
  bind();
}

function globalShell() {
  return `
    <main class="shell global-shell">
      <aside class="sidebar" aria-label="Global navigation">
        <button class="brand text-brand">CivilAgent</button>
        <nav class="nav">
          <button class="nav-item active">${icon("projects")}<span>Projects</span></button>
          <button class="nav-item">${icon("table")}<span>Templates</span></button>
          <button class="nav-item">${icon("file")}<span>Help / Docs</span></button>
          <button class="nav-item">${icon("settings")}<span>Settings</span></button>
        </nav>
        ${profileBlock()}
      </aside>
      <section class="main">
        <header class="topbar">
          <div class="header-title">
            <h1>CivilAgent</h1>
            <p>Deterministic structural workflow, project context, and engineer-reviewed design decisions.</p>
          </div>
          <div class="top-actions">
            <label class="mini-search">${icon("search")}<input placeholder="Search projects, documents, schemes..." /></label>
            <button class="primary-btn" data-action="new-project">${icon("plus")}New Project</button>
          </div>
        </header>
        <div class="stage global-stage">
          <section class="launcher">
            <div class="page-head">
              <p class="eyebrow">Projects</p>
              <h2>Open a structural workspace</h2>
              <p>Review deterministic structural models, assumptions, schemes, sizing checks, Vault context, and reports.</p>
            </div>
            <div class="project-list">
              <div class="project-row head"><span>Project</span><span>Location</span><span>Code / Material</span><span>Status</span><span>Updated</span><span></span></div>
              ${projects.map((projectItem, index) => `
                <button class="project-row" data-action="open-project" data-project-index="${index}">
                  <span><strong>${projectItem.name}</strong><small>Workspace / ${projectItem.id}</small></span>
                  <span>${projectItem.location}</span>
                  <span>${projectItem.code}</span>
                  <span>${statusChip(projectItem.status)}</span>
                  <span>${projectItem.updated}</span>
                  <em>Open</em>
                </button>
              `).join("")}
            </div>
            <section class="recent-activity">
              <h3>Recent activity</h3>
              ${activityItem("CivilAgent recalculated Scheme A from approved assumptions.", "12 min ago")}
              ${activityItem("Geotechnical_Report_Final.pdf extraction needs review.", "Today")}
              ${activityItem("B21 flagged near capacity due to live-load deflection.", "Today")}
              ${activityItem("Structural narrative generated for engineer review.", "Yesterday")}
            </section>
          </section>
        </div>
        ${modalLayer()}
        ${toastLayer()}
      </section>
    </main>
  `;
}

function workspaceShell() {
  return `
    <main class="shell workspace-shell">
      ${workspaceSidebar()}
      <section class="main">
        ${workspaceTopbar()}
        <div class="stage workspace-stage">
          ${workspaceContent()}
        </div>
        ${assistantDrawer()}
        ${commandPalette()}
        ${modalLayer()}
        ${toastLayer()}
      </section>
    </main>
  `;
}

function workspaceSidebar() {
  const activeProject = currentProject();
  return `
    <aside class="sidebar project-sidebar" aria-label="Workspace navigation">
      <button class="back-link" data-action="back-projects">Projects</button>
      <div class="project-sidebar-title">
        <strong>${activeProject.name}</strong>
        <span>${activeProject.location}</span>
      </div>
      <nav class="nav">
        ${workspacePages.map(([id, label, iconName]) => `
          <button class="nav-item ${state.page === id ? "active" : ""}" data-page="${id}">
            ${icon(iconName)}
            <span>${label}</span>
          </button>
        `).join("")}
      </nav>
      ${profileBlock()}
    </aside>
  `;
}

function workspaceTopbar() {
  const activeProject = currentProject();
  return `
    <header class="topbar workspace-topbar">
      <div class="header-title">
        <h1>${activeProject.name}</h1>
        <p>Workspace / ${activePageLabel()} / Active Scheme ${state.activeSchemeId} / ${activeProject.status}</p>
      </div>
      <div class="top-actions">
        ${chip(`Scheme ${state.activeSchemeId}`)}
        ${chip(state.assumptionSetId)}
        <span class="last-sync">${state.recalculating ? "Recalculating..." : `Recalculated ${state.lastRecalculatedAt}`}</span>
        <button class="secondary-btn" data-action="recalculate">${state.recalculating ? "Running" : "Recalculate"}</button>
        <button class="secondary-btn" data-action="open-assistant">${icon("wand")}Ask CivilAgent</button>
        <button class="secondary-btn" data-action="export-view">${icon("export")}Export</button>
        <button class="secondary-btn" data-action="share">Share</button>
        <button class="icon-btn" data-page="settings" aria-label="Project settings">${icon("settings")}</button>
      </div>
    </header>
  `;
}

function workspaceContent() {
  if (state.page === "overview") return overviewPage();
  if (state.page === "assumptions") return assumptionsPage();
  if (state.page === "vault") return vaultPage();
  if (state.page === "reports") return reportsPage();
  if (state.page === "settings") return settingsPage();
  return modelWorkspacePage();
}

function overviewPage() {
  return `
    <section class="overview-grid">
      <div class="overview-main">
        <div class="metric-strip">
          ${metricCard("Active scheme", "Scheme A", "Balanced Strategy")}
          ${metricCard("Pending assumptions", "3", "1 high-impact extraction")}
          ${metricCard("Critical sizing issues", "1 fail", "SW2 shear check")}
          ${metricCard("Vault review", "4 items", "Geotech and MEP")}
          ${metricCard("Last recalculated", state.lastRecalculatedAt, state.recalculating ? "Running deterministic engine" : "Ready")}
        </div>
        <div class="overview-canvas-card">
          <div class="section-head">
            <div><p class="eyebrow">Model preview</p><h2>Current structural workspace</h2></div>
            <button class="secondary-btn" data-page="geometry">Open geometry</button>
          </div>
          ${engineeringCanvas("overview")}
        </div>
        <div class="activity-panel">
          <h3>Recent activity</h3>
          ${activityItem("Scheme A recalculated from Assumption Set v3.", "12 min ago")}
          ${activityItem("SW2 flagged as failing E-W shear check.", "18 min ago")}
          ${activityItem("Geotechnical report sent bearing pressure to assumptions.", "Today")}
          ${activityItem("Equipment schedule marked for engineer review.", "Today")}
        </div>
      </div>
      <aside class="overview-side">
        <section class="glass-panel">
          <p class="eyebrow">Next actions</p>
          ${actionLine("Review 3 extracted assumptions", "Assumptions", "assumptions")}
          ${actionLine("Resolve 1 failing shear wall", "Sizing", "sizing")}
          ${actionLine("Generate member schedule", "Reports", "reports")}
          ${actionLine("Export Revit package", "Reports", "reports")}
        </section>
        <section class="glass-panel">
          <p class="eyebrow">Workflow progress</p>
          ${workflowStep("Geometry", true)}
          ${workflowStep("Assumptions", true)}
          ${workflowStep("Placement", true)}
          ${workflowStep("Loads", true)}
          ${workflowStep("Schemes", true)}
          ${workflowStep("Sizing", false)}
          ${workflowStep("Reports", false)}
        </section>
      </aside>
    </section>
  `;
}

function modelWorkspacePage() {
  return `
    <section class="model-workspace">
      <div class="canvas-column">
        ${engineeringCanvas(state.page)}
        ${bottomTray()}
      </div>
      ${rightInspector()}
    </section>
  `;
}

function engineeringCanvas(activeMode) {
  if (state.viewMode === "split") {
    return `
      <section class="engineering-canvas split">
        <div class="split-pane">${canvasViewport(activeMode, "2d")}</div>
        <div class="split-pane">${canvasViewport(activeMode, "3d")}</div>
      </section>
    `;
  }
  return `<section class="engineering-canvas">${canvasViewport(activeMode, state.viewMode)}</section>`;
}

function canvasViewport(activeMode, viewMode) {
  const activeProject = currentProject();
  const is3d = viewMode === "3d";
  const isSection = viewMode === "section";
  return `
    <div class="canvas-shell ${is3d ? "is-3d" : ""} ${isSection ? "is-section" : ""}">
      <div class="canvas-top-left">
        <span class="mono">${activeProject.name}</span>
        <strong>${activePageLabel()} / ${viewMode.toUpperCase()}</strong>
      </div>
      ${canvasTools()}
      ${layerMenu()}
      <svg class="model-svg ${is3d ? "model-iso" : ""}" viewBox="0 0 1000 650" role="img" aria-label="Engineering model canvas">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="rgba(59,130,246,.75)"/></marker>
        </defs>
        ${drawFloorPlate()}
        ${drawGrids()}
        ${drawCores()}
        ${drawNoColumnZones()}
        ${drawSlabs(activeMode)}
        ${drawTributaryAreas(activeMode)}
        ${drawShearWalls()}
        ${drawBraces(activeMode)}
        ${drawBeams()}
        ${drawColumns()}
        ${drawLoads(activeMode)}
        ${drawWarnings(activeMode)}
        ${drawLabels()}
      </svg>
      ${canvasControls()}
    </div>
  `;
}

function canvasTools() {
  return `
    <div class="canvas-tools">
      <button class="tool-btn active" title="Select" aria-label="Select">${icon("select")}</button>
      <button class="tool-btn" data-action="measure" title="Measure" aria-label="Measure">${icon("measure")}</button>
      <button class="tool-btn" data-action="isolate" title="Isolate selected" aria-label="Isolate selected">${icon("model")}</button>
      <button class="tool-btn" data-action="reset-view" title="Reset view" aria-label="Reset view">${icon("reset")}</button>
      <button class="tool-btn" data-action="export-view" title="Export view" aria-label="Export view">${icon("export")}</button>
    </div>
  `;
}

function canvasControls() {
  return `
    <div class="canvas-controls">
      <div class="segmented">
        ${["2d", "3d", "section", "split"].map((mode) => `<button class="${state.viewMode === mode ? "active" : ""}" data-view="${mode}">${modeLabel(mode)}</button>`).join("")}
      </div>
      <select data-change="level" aria-label="Active level">${levels.map((level) => `<option value="${level.id}" ${state.activeLevelId === level.id ? "selected" : ""}>${level.name}</option>`).join("")}</select>
      <button class="filter-btn ${state.visibleLayers.grids ? "active" : ""}" data-layer="grids">Grid</button>
      <select data-change="scheme" aria-label="Active scheme">${schemes.map((scheme) => `<option value="${scheme.id}" ${state.activeSchemeId === scheme.id ? "selected" : ""}>Scheme ${scheme.id}</option>`).join("")}</select>
      <button class="filter-btn" data-action="toggle-layers">${icon("layers")}Layers</button>
    </div>
  `;
}

function layerMenu() {
  if (!state.showLayers) return "";
  const layers = [
    ["architectural", "Architectural model"],
    ["floorPlates", "Floor plates"],
    ["grids", "Grids"],
    ["cores", "Cores"],
    ["noColumnZones", "No-column zones"],
    ["columns", "Columns"],
    ["beams", "Beams"],
    ["shearWalls", "Shear walls"],
    ["braces", "Braces"],
    ["loads", "Loads"],
    ["tributaryAreas", "Tributary areas"],
    ["warnings", "Warnings"],
    ["labels", "Labels"],
  ];
  return `
    <div class="layer-menu">
      <p class="eyebrow">Layers</p>
      ${layers.map(([key, label]) => `<button class="${state.visibleLayers[key] ? "active" : ""}" data-layer="${key}"><span>${label}</span><em>${state.visibleLayers[key] ? "On" : "Off"}</em></button>`).join("")}
    </div>
  `;
}

function drawFloorPlate() {
  if (!state.visibleLayers.floorPlates) return "";
  return `<polygon class="plate" points="118,118 832,86 902,478 188,536"></polygon>`;
}

function drawGrids() {
  if (!state.visibleLayers.grids) return "";
  const vertical = gridLines.filter((line) => line.axis === "x").map((line) => `
    <line class="grid-line" x1="${line.coordinate}" y1="95" x2="${line.coordinate + 52}" y2="510" data-select-type="grid" data-select-id="${line.id}"></line>
    <text class="grid-label" x="${line.coordinate - 4}" y="84">${line.label}</text>
  `).join("");
  const horizontal = gridLines.filter((line) => line.axis === "y").map((line) => `
    <line class="grid-line" x1="130" y1="${line.coordinate}" x2="900" y2="${line.coordinate - 36}" data-select-type="grid" data-select-id="${line.id}"></line>
    <text class="grid-label" x="108" y="${line.coordinate + 3}">${line.label}</text>
  `).join("");
  return vertical + horizontal;
}

function drawCores() {
  if (!state.visibleLayers.cores) return "";
  return cores.map((core) => {
    const [x, y, w, h] = core.boundary;
    return `<rect class="core ${isSelected("core", core.id)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" data-select-type="core" data-select-id="${core.id}"></rect>`;
  }).join("");
}

function drawNoColumnZones() {
  if (!state.visibleLayers.noColumnZones) return "";
  return noColumnZones.map((zone) => {
    const [x, y, w, h] = zone.boundary;
    return `<rect class="no-column-zone ${isSelected("noColumnZone", zone.id)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" data-select-type="noColumnZone" data-select-id="${zone.id}"></rect>`;
  }).join("");
}

function drawSlabs(activeMode) {
  if (!state.visibleLayers.floorPlates || !["loads", "sizing"].includes(activeMode)) return "";
  return slabZones.map((slab) => {
    const [x, y, w, h] = slab.boundary;
    return `<rect class="slab-zone ${slab.status}" x="${x}" y="${y}" width="${w}" height="${h}" data-select-type="slab" data-select-id="${slab.id}"></rect>`;
  }).join("");
}

function drawTributaryAreas(activeMode) {
  if (!state.visibleLayers.tributaryAreas || !["loads", "placement", "sizing"].includes(activeMode)) return "";
  return `
    <polygon class="tributary" points="370,180 650,160 690,315 405,335" data-select-type="beam" data-select-id="B21"></polygon>
    <polygon class="tributary blue" points="455,250 620,230 660,405 492,430" data-select-type="column" data-select-id="C4"></polygon>
  `;
}

function drawColumns() {
  if (!state.visibleLayers.columns) return "";
  return columns.map((column) => `
    <g data-select-type="column" data-select-id="${column.id}">
      <rect class="column ${column.status} ${column.locked ? "locked" : ""} ${isSelected("column", column.id)}" x="${column.x - 8}" y="${column.y - 8}" width="16" height="16" rx="2"></rect>
      ${column.locked ? `<text class="lock-label" x="${column.x + 10}" y="${column.y - 8}">L</text>` : ""}
    </g>
  `).join("");
}

function drawBeams() {
  if (!state.visibleLayers.beams) return "";
  return beams.map((beam) => `
    <line class="beam ${beam.status} ${beam.locked ? "locked" : ""} ${isSelected("beam", beam.id)}" x1="${beam.start[0]}" y1="${beam.start[1]}" x2="${beam.end[0]}" y2="${beam.end[1]}" data-select-type="beam" data-select-id="${beam.id}"></line>
  `).join("");
}

function drawShearWalls() {
  if (!state.visibleLayers.shearWalls) return "";
  return shearWalls.map((wall) => {
    const [x, y, w, h] = wall.boundary;
    return `<rect class="shear-wall ${wall.status} ${wall.locked ? "locked" : ""} ${isSelected("shearWall", wall.id)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="1" data-select-type="shearWall" data-select-id="${wall.id}"></rect>`;
  }).join("");
}

function drawBraces(activeMode) {
  if (!state.visibleLayers.braces || !["placement", "schemes", "sizing"].includes(activeMode)) return "";
  return braces.map((brace) => `
    <line class="brace ${brace.status} ${isSelected("brace", brace.id)}" x1="${brace.start[0]}" y1="${brace.start[1]}" x2="${brace.end[0]}" y2="${brace.end[1]}" data-select-type="brace" data-select-id="${brace.id}"></line>
  `).join("");
}

function drawLoads(activeMode) {
  if (!state.visibleLayers.loads || activeMode !== "loads") return "";
  return columns.map((column) => `
    <line class="load-arrow" x1="${column.x}" y1="${column.y - 70}" x2="${column.x}" y2="${column.y - 18}" marker-end="url(#arrow)" data-select-type="column" data-select-id="${column.id}"></line>
    <text class="load-label" x="${column.x + 8}" y="${column.y - 60}">${column.axialLoad}</text>
  `).join("") + `<line class="lateral-arrow" x1="150" y1="570" x2="340" y2="570" marker-end="url(#arrow)"></line><text class="load-label" x="155" y="555">E-W lateral</text>`;
}

function drawWarnings(activeMode) {
  if (!state.visibleLayers.warnings || !["geometry", "loads", "sizing", "schemes"].includes(activeMode)) return "";
  return `
    <g class="warning-badge" data-select-type="beam" data-select-id="B21"><circle cx="520" cy="306" r="13"></circle><text x="516" y="311">!</text></g>
    <g class="warning-badge fail" data-select-type="shearWall" data-select-id="SW2"><circle cx="700" cy="218" r="13"></circle><text x="696" y="223">!</text></g>
  `;
}

function drawLabels() {
  if (!state.visibleLayers.labels) return "";
  const memberLabels = [
    ["B21", 500, 325],
    ["B12", 460, 142],
    ["C4", 526, 356],
    ["SW2", 678, 198],
  ];
  return memberLabels.map(([label, x, y]) => `<text class="object-label" x="${x}" y="${y}">${label}</text>`).join("");
}

function isSelected(type, id) {
  return state.selectedObject?.type === type && state.selectedObject?.id === id ? "selected" : "";
}

function rightInspector() {
  const object = selectedObject();
  return `
    <aside class="right-inspector">
      <div class="inspector-head">
        <div><p class="eyebrow">${object ? objectLabel(state.selectedObject.type) : activePageLabel()}</p><h2>${object ? object.id || object.name || object.label : inspectorTitle()}</h2></div>
        <button class="icon-btn quiet" data-action="clear-selection" aria-label="Clear selection">${icon("close")}</button>
      </div>
      ${object ? selectedObjectInspector(object) : emptyInspector()}
    </aside>
  `;
}

function inspectorTitle() {
  const titles = {
    geometry: "Geometry summary",
    placement: "Placement strategy",
    loads: "Load path summary",
    schemes: `Scheme ${state.activeSchemeId}`,
    sizing: "Member checks",
  };
  return titles[state.page] || activePageLabel();
}

function selectedObjectInspector(object) {
  if (state.selectedObject.type === "beam") return beamInspector(object);
  if (state.selectedObject.type === "column") return columnInspector(object);
  if (state.selectedObject.type === "shearWall") return wallInspector(object);
  if (state.selectedObject.type === "core") return coreInspector(object);
  if (state.selectedObject.type === "grid") return gridInspector(object);
  if (state.selectedObject.type === "slab") return slabInspector(object);
  if (state.selectedObject.type === "noColumnZone") return zoneInspector(object);
  return genericInspector(object);
}

function beamInspector(beam) {
  return `
    <div class="detail-list">
      ${plainItem("Selected size", beam.size)}
      ${plainItem("Span", beam.span)}
      ${plainItem("Tributary width", beam.tributaryWidth)}
      ${plainItem("Uniform load", beam.uniformLoad)}
      ${plainItem("Moment demand", beam.momentDemand)}
      ${plainItem("Shear demand", beam.shearDemand)}
      ${plainItem("Governing check", beam.governingCheck)}
      ${plainItem("D/C ratio", beam.dcr)}
      ${plainItem("Status", beam.status)}
    </div>
    <div class="reasoning-note">B21 is near capacity because live-load deflection controls on a 31.8 ft span. This explanation is tied to the active scheme, approved live load, and member check table.</div>
    ${sourceList(["Active Scheme A", "Assumption Set v3", "Office live load = 50 psf", "Floor_Plans_A1-A8.pdf"])}
    <div class="button-row vertical">
      <button class="secondary-btn" data-action="apply-size">Apply suggested size</button>
      <button class="secondary-btn" data-action="open-calculation">Open calculation</button>
      <button class="secondary-btn" data-action="show-tributary">Show tributary area</button>
      <button class="secondary-btn" data-action="open-assistant">Ask CivilAgent why</button>
    </div>
  `;
}

function columnInspector(column) {
  return `
    <div class="detail-list">
      ${plainItem("Grid", column.gridLabel)}
      ${plainItem("Levels", `${column.startLevel}-${column.endLevel}`)}
      ${plainItem("Size", column.size)}
      ${plainItem("Tributary area", column.tributaryArea)}
      ${plainItem("Axial load", column.axialLoad)}
      ${plainItem("D/C ratio", column.dcr)}
      ${plainItem("Source", column.source)}
      ${plainItem("Locked", column.locked ? "Yes" : "No")}
    </div>
    <div class="mini-chart"><span style="height:28%"></span><span style="height:48%"></span><span style="height:70%"></span><span style="height:92%"></span></div>
    <div class="button-row vertical">
      <button class="secondary-btn" data-action="toggle-lock">${column.locked ? "Unlock" : "Lock"} column</button>
      <button class="secondary-btn" data-action="show-load-path">Show load takedown</button>
      <button class="secondary-btn" data-page="sizing">Inspect column sizing</button>
    </div>
  `;
}

function wallInspector(wall) {
  return `
    <div class="detail-list">
      ${plainItem("Direction", wall.direction)}
      ${plainItem("Length", wall.length)}
      ${plainItem("Thickness", wall.thickness)}
      ${plainItem("Levels", wall.levels)}
      ${plainItem("Drift contribution", wall.driftContribution)}
      ${plainItem("D/C ratio", wall.dcr)}
      ${plainItem("Status", wall.status)}
      ${plainItem("Locked", wall.locked ? "Yes" : "No")}
    </div>
    <div class="reasoning-note">SW2 is failing shear under the E-W seismic case. Deterministic resolution options are to thicken, extend, or add a paired wall.</div>
    <div class="button-row vertical">
      <button class="secondary-btn" data-action="toggle-lock">${wall.locked ? "Unlock" : "Lock"} wall</button>
      <button class="secondary-btn" data-action="mock-thicken">Thicken wall</button>
      <button class="secondary-btn" data-action="mock-extend">Extend wall</button>
      <button class="secondary-btn" data-action="open-assistant">Ask about lateral system</button>
    </div>
  `;
}

function coreInspector(core) {
  return `
    <div class="detail-list">
      ${plainItem("Type", core.type)}
      ${plainItem("Levels affected", core.levels)}
      ${plainItem("Conflicts", core.conflicts)}
      ${plainItem("Referenced schemes", "A, C, D")}
    </div>
    <div class="reasoning-note">Core geometry is used as a lateral candidate and as a no-framing region for placement generation.</div>
    <div class="button-row vertical"><button class="secondary-btn" data-action="mark-reviewed">Mark reviewed</button><button class="secondary-btn">Open source model</button></div>
  `;
}

function gridInspector(grid) {
  return `
    <div class="detail-list">
      ${plainItem("Grid label", grid.label)}
      ${plainItem("Axis", grid.axis)}
      ${plainItem("Coordinate", grid.coordinate)}
      ${plainItem("Confidence", grid.confidence)}
      ${plainItem("Locked", grid.locked ? "Yes" : "No")}
    </div>
    <div class="button-row vertical"><button class="secondary-btn">Lock grid</button><button class="secondary-btn">Edit label</button><button class="secondary-btn">Hide grid</button></div>
  `;
}

function slabInspector(slab) {
  return `
    <div class="detail-list">
      ${plainItem("System", slab.system)}
      ${plainItem("Thickness", slab.thickness)}
      ${plainItem("Load", slab.loadPsf)}
      ${plainItem("Status", slab.status)}
    </div>
    <div class="reasoning-note">Slab zone loads come from approved dead/live load assumptions plus extracted equipment loads where available.</div>
  `;
}

function zoneInspector(zone) {
  return `
    <div class="detail-list">
      ${plainItem("Reason", zone.reason)}
      ${plainItem("Source", zone.source)}
    </div>
    <div class="reasoning-note">Placement generation avoids this zone unless the engineer explicitly allows a support exception.</div>
  `;
}

function genericInspector(object) {
  return `<pre class="object-json">${JSON.stringify(object, null, 2)}</pre>`;
}

function emptyInspector() {
  if (state.page === "geometry") {
    return `
      <div class="detail-list">
        ${plainItem("Levels detected", "8")}
        ${plainItem("Grids detected", "14 / 96%")}
        ${plainItem("Cores detected", "2")}
        ${plainItem("Openings detected", "140 / 84%")}
        ${plainItem("Review status", "3 items need review")}
      </div>
      <div class="reasoning-note">CivilAgent extracted geometry from the Revit model and drawing set. The engineer must accept or correct the understanding before placement decisions are final.</div>
      <div class="button-row vertical"><button class="primary-btn" data-action="accept-geometry">Accept geometry</button><button class="secondary-btn" data-action="edit-zones">Edit zones</button><button class="secondary-btn" data-page="placement">Send to placement</button></div>
    `;
  }
  if (state.page === "placement") {
    return `
      <div class="detail-list">
        ${plainItem("Bay size target", "25-30 ft")}
        ${plainItem("No-column zones", "2")}
        ${plainItem("Max span", "31.8 ft")}
        ${plainItem("Max beam depth", "24 in")}
        ${plainItem("Lateral preference", "Core walls")}
      </div>
      <div class="reasoning-note">Placement is generated around architectural constraints and locked engineer decisions. Locked elements remain fixed during regeneration.</div>
      <div class="button-row vertical"><button class="primary-btn" data-action="regenerate-locked">Regenerate around locked decisions</button><button class="secondary-btn">Add column</button><button class="secondary-btn">Add shear wall</button></div>
    `;
  }
  if (state.page === "loads") {
    return `
      <div class="detail-list">
        ${plainItem("Active load cases", "5")}
        ${plainItem("Total L6 floor load", "8,420 kip")}
        ${plainItem("Max column axial", "720 kip")}
        ${plainItem("Unresolved assumptions", "1 equipment load")}
        ${plainItem("Combination", "1.2D + 1.6L")}
      </div>
      <div class="reasoning-note">Load visualization is based on approved assumptions and extracted document values. Unapproved equipment loads remain highlighted.</div>
    `;
  }
  if (state.page === "schemes") return schemeInspector();
  if (state.page === "sizing") {
    return `
      <div class="detail-list">
        ${plainItem("Passing", "182")}
        ${plainItem("Near capacity", "9")}
        ${plainItem("Failing", "2")}
        ${plainItem("Top issue", "SW2 shear check")}
      </div>
      <div class="button-row vertical"><button class="secondary-btn">View issue queue</button><button class="secondary-btn">Generate resolution options</button><button class="secondary-btn">Export member schedule</button></div>
    `;
  }
  return "";
}

function schemeInspector() {
  const scheme = activeScheme();
  return `
    <div class="detail-list">
      ${plainItem("Strategy", scheme.strategy)}
      ${plainItem("Status", scheme.status)}
      ${plainItem("Steel tonnage", scheme.steel)}
      ${plainItem("Concrete volume", scheme.concrete)}
      ${plainItem("Cost index", scheme.cost)}
      ${plainItem("Max drift", scheme.drift)}
      ${plainItem("Max span", scheme.span)}
      ${plainItem("Max beam depth", scheme.depth)}
      ${plainItem("Unique sections", scheme.sections)}
      ${plainItem("Warnings", scheme.warnings)}
    </div>
    <div class="reasoning-note">Why this scheme exists: ${scheme.note} It gives the engineer a transparent tradeoff between weight, cost, drift, member repetition, and architectural disruption.</div>
    <div class="button-row vertical">
      <button class="secondary-btn" data-action="compare-schemes">Compare options</button>
      <button class="primary-btn" data-action="set-active-scheme">Set active</button>
      <button class="secondary-btn">Duplicate</button>
      <button class="secondary-btn">Merge gravity/lateral systems</button>
      <button class="secondary-btn">Export active strategy</button>
    </div>
  `;
}

function assumptionsPage() {
  const selected = assumptions.find((item) => item.id === state.selectedAssumptionId) || assumptions[0];
  return `
    <section class="table-workspace">
      <div class="table-main glass-panel">
        <div class="section-head">
          <div><p class="eyebrow">Assumptions</p><h2>Engineering control panel</h2><p>Every deterministic calculation is tied to reviewed assumptions and source documents.</p></div>
          <div class="button-row tight"><button class="secondary-btn" data-action="approve-low-risk">Approve low-risk defaults</button><button class="secondary-btn">Create snapshot</button><button class="primary-btn" data-action="recalculate">Recalculate</button></div>
        </div>
        <div class="data-table assumption-table">
          <div class="data-row head"><span>Group</span><span>Label</span><span>Value</span><span>Source</span><span>Status</span><span>Affects</span></div>
          ${assumptions.map((item) => `
            <button class="data-row ${state.selectedAssumptionId === item.id ? "active" : ""}" data-assumption="${item.id}">
              <span>${item.category}</span><strong>${item.label}</strong><span class="mono">${item.value} ${item.units}</span><span>${item.source}</span><span>${statusChip(item.status)}</span><span>${item.affects}</span>
            </button>
          `).join("")}
        </div>
      </div>
      <aside class="right-inspector">
        <div class="inspector-head"><div><p class="eyebrow">Selected assumption</p><h2>${selected.label}</h2></div></div>
        <div class="detail-list">
          ${plainItem("Value", `${selected.value} ${selected.units}`)}
          ${plainItem("Source", selected.source)}
          ${plainItem("Source document", selected.sourceDocumentId || "None")}
          ${plainItem("Status", selected.status)}
          ${plainItem("Affects", selected.affects)}
          ${plainItem("Last changed", `${selected.lastChangedBy} / ${selected.lastChangedAt}`)}
        </div>
        <div class="reasoning-note">This value is used by deterministic load generation, scheme ranking, sizing checks, and reports. Review status controls whether downstream outputs can be marked ready.</div>
        <div class="button-row vertical"><button class="primary-btn" data-action="approve-assumption">Approve</button><button class="secondary-btn">Edit</button><button class="secondary-btn">Reject extracted value</button><button class="secondary-btn" data-page="vault">Open source document</button></div>
      </aside>
    </section>
  `;
}

function vaultPage() {
  const selected = vaultDocuments.find((doc) => doc.id === state.selectedDocumentId) || vaultDocuments[0];
  return `
    <section class="table-workspace">
      <div class="table-main glass-panel">
        <div class="section-head">
          <div><p class="eyebrow">Project Vault</p><h2>Project knowledge layer</h2><p>Documents, extracted insights, and pending review items that feed deterministic assumptions and reports.</p></div>
          <button class="primary-btn" data-action="upload-doc">${icon("plus")}Upload context</button>
        </div>
        <div class="segmented vault-tabs">
          ${["documents", "insights", "pending"].map((tab) => `<button class="${state.vaultTab === tab ? "active" : ""}" data-vault-tab="${tab}">${tabLabel(tab)}</button>`).join("")}
        </div>
        ${vaultTabContent()}
      </div>
      <aside class="right-inspector">
        <div class="inspector-head"><div><p class="eyebrow">Vault context</p><h2>${selected.name}</h2></div></div>
        <div class="detail-list">
          ${plainItem("Category", selected.category)}
          ${plainItem("Version", selected.version)}
          ${plainItem("File type", selected.fileType)}
          ${plainItem("AI status", selected.aiStatus)}
          ${plainItem("Review", selected.reviewStatus)}
          ${plainItem("Referenced by", selected.referencedBy)}
        </div>
        <div class="reasoning-note">${selected.insights.join(" ")}</div>
        <div class="button-row vertical"><button class="secondary-btn">Preview</button><button class="secondary-btn">Replace version</button><button class="secondary-btn">Download</button><button class="primary-btn" data-action="mark-reviewed">Mark reviewed</button></div>
      </aside>
    </section>
  `;
}

function vaultTabContent() {
  if (state.vaultTab === "insights") {
    const insights = vaultDocuments.flatMap((doc) => doc.insights.map((text, index) => ({ id: `${doc.id}-${index}`, doc, text })));
    return `<div class="insight-list">${insights.map((item) => `<button class="insight-row" data-doc="${item.doc.id}"><strong>${item.text}</strong><span>${item.doc.name}</span><em>Send to assumptions</em></button>`).join("")}</div>`;
  }
  if (state.vaultTab === "pending") {
    return `<div class="insight-list">${vaultDocuments.filter((doc) => doc.reviewStatus === "Needs review").map((doc) => `<button class="insight-row" data-doc="${doc.id}"><strong>${doc.name}</strong><span>${doc.insights[0]}</span><em>Review</em></button>`).join("")}</div>`;
  }
  return `
    <div class="data-table vault-data-table">
      <div class="data-row head"><span>Name</span><span>Category</span><span>Source</span><span>Version</span><span>Updated</span><span>AI status</span><span>Referenced by</span></div>
      ${vaultDocuments.map((doc) => `
        <button class="data-row ${state.selectedDocumentId === doc.id ? "active" : ""}" data-doc="${doc.id}">
          <strong>${doc.name}</strong><span>${doc.category}</span><span>${doc.source}</span><span class="mono">${doc.version}</span><span>${doc.updatedAt}</span><span>${statusChip(doc.aiStatus)}</span><span>${doc.referencedBy}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function reportsPage() {
  return `
    <section class="table-workspace">
      <div class="table-main glass-panel">
        <div class="section-head">
          <div><p class="eyebrow">Reports</p><h2>Preliminary deliverables for engineer review</h2><p>Generated from the active scheme, approved assumptions, sizing checks, and referenced Vault context.</p></div>
          <button class="primary-btn" data-action="generate-package">Generate package</button>
        </div>
        <div class="preset-row">
          ${["Internal review package", "Client concept package", "Engineer-of-record review package"].map((preset) => `<button class="preset-card"><strong>${preset}</strong><span>Preliminary / for engineer review</span></button>`).join("")}
        </div>
        <div class="report-list full">
          ${reports.map((report) => `
            <div class="report-row ${report.status === "Generated" ? "generated" : "pending"}">
              <span><strong>${report.name}</strong><small>${report.includedSources} / Missing: ${report.missingInputs}</small></span>
              <em>${statusChip(report.status)}</em>
              <div><button class="secondary-btn" data-action="generate-report">Generate</button><button class="secondary-btn">Preview</button><button class="secondary-btn">Download PDF</button><button class="secondary-btn">Open in browser</button></div>
            </div>
          `).join("")}
        </div>
      </div>
      <aside class="right-inspector">
        <div class="inspector-head"><div><p class="eyebrow">Report package</p><h2>Export status</h2></div></div>
        <div class="detail-list">
          ${plainItem("Generated reports", "2")}
          ${plainItem("Pending reports", "5")}
          ${plainItem("Unresolved assumptions", "1")}
          ${plainItem("Referenced Vault docs", "8")}
          ${plainItem("Active scheme used", `Scheme ${state.activeSchemeId}`)}
          ${plainItem("Format", "PDF + browser preview")}
        </div>
        <div class="reasoning-note">Report copy is preliminary and for engineer review. CivilAgent does not produce final stamped construction documents.</div>
      </aside>
    </section>
  `;
}

function settingsPage() {
  const activeProject = currentProject();
  return `
    <section class="table-workspace">
      <div class="table-main glass-panel">
        <div class="section-head"><div><p class="eyebrow">Project settings</p><h2>${activeProject.name}</h2><p>Project-level controls, connections, team access, and audit trail.</p></div></div>
        <div class="settings-grid">
          ${settingsCard("Project metadata", [activeProject.location, activeProject.codeBasis, activeProject.materialSystem])}
          ${settingsCard("Codes and design basis", ["Risk Category II", "IBC 2021", "ASCE 7-16"])}
          ${settingsCard("Team", ["Harsh Grant - owner", "A. Patel - architecture", "M. Chen - reviewer"])}
          ${settingsCard("Export targets", ["Revit connection: connected", "ETABS v21", "IFC schema: IFC4"])}
          ${settingsCard("Assumption history", ["Apr 30 - live load approved", "Apr 30 - bearing pressure extracted", "Apr 29 - Site Class D imported", "View full history"]) }
          ${settingsCard("Firm defaults", ["Open firm assumptions template", "Member library: Vellum standard", "Report template: preliminary structural"]) }
        </div>
      </div>
      <aside class="right-inspector">
        <div class="inspector-head"><div><p class="eyebrow">Workspace settings</p><h2>Connection summary</h2></div></div>
        <div class="detail-list">
          ${plainItem("Revit connection", "Connected")}
          ${plainItem("Active export target", "Revit + ETABS")}
          ${plainItem("Team members", "3")}
          ${plainItem("Assumption log entries", "12")}
          ${plainItem("Last sync", "Today 12:06")}
        </div>
      </aside>
    </section>
  `;
}

function bottomTray() {
  if (!state.bottomOpen) {
    return `<button class="bottom-peek" data-action="toggle-bottom">Open tray</button>`;
  }
  const content = {
    geometry: geometryTray(),
    placement: placementTray(),
    loads: loadsTray(),
    schemes: schemesTray(),
    sizing: sizingTray(),
  }[state.page] || "";
  return `
    <section class="bottom-tray">
      <div class="tray-head"><p class="eyebrow">${activePageLabel()} tray</p><button class="icon-btn quiet" data-action="toggle-bottom">${icon("close")}</button></div>
      ${content}
    </section>
  `;
}

function geometryTray() {
  return `<div class="tray-grid">${metricCard("Levels", "8", "100% confidence")}${metricCard("Grids", "14", "96% confidence")}${metricCard("Cores", "2", "reviewed")}${metricCard("Openings", "140", "84% confidence")}${issueMini("Opening conflict near Grid C-4")}${issueMini("Core boundary needs review")}${issueMini("Grid spacing irregular between 4-5")}</div>`;
}

function placementTray() {
  const alternatives = [
    ["Balanced grid", "42 columns", "31.8 ft max span", "2 warnings"],
    ["Fewer columns", "36 columns", "36.0 ft max span", "6 warnings"],
    ["Shallow beams", "54 columns", "27.5 ft max span", "2 warnings"],
    ["Core-wall dominant", "44 columns", "30.5 ft max span", "3 warnings"],
    ["Least intrusive", "36 columns", "36.0 ft max span", "6 warnings"],
  ];
  return `<div class="tray-card-row">${alternatives.map(([name, a, b, c]) => `<button class="tray-card"><strong>${name}</strong><span>${a}</span><span>${b}</span><em>${c}</em></button>`).join("")}</div>`;
}

function loadsTray() {
  return `<div class="mini-table tray-table">${loadCases.map((load) => `<div><span>${load.name}</span><strong>${load.value} ${load.units}</strong><em>${load.approved ? "Approved" : "Needs review"}</em></div>`).join("")}</div>`;
}

function schemesTray() {
  if (state.compareMode) {
    return `<div class="comparison-table"><div><span>Metric</span><strong>A</strong><strong>B</strong><strong>C</strong></div>${["steel", "cost", "drift", "sections", "warnings"].map((key) => `<div><span>${key}</span>${schemes.slice(0, 3).map((scheme) => `<strong>${scheme[key] || scheme[key === "sections" ? "sections" : ""]}</strong>`).join("")}</div>`).join("")}</div>`;
  }
  return `<div class="tray-card-row">${schemes.map((scheme) => schemeCard(scheme)).join("")}</div>`;
}

function sizingTray() {
  return `<div class="issue-queue">${issues.map((issue) => `<button class="issue-row ${issue.severity.toLowerCase()}" data-select-type="${issue.objectType === "shearWall" ? "shearWall" : issue.objectType}" data-select-id="${issue.objectId}"><span>${issue.severity}</span><strong>${issue.objectId}</strong><em>D/C ${issue.dcr || "-"}</em><small>${issue.title}</small><b>${issue.suggestedActions[0]}</b></button>`).join("")}</div>`;
}

function assistantDrawer() {
  if (!state.assistantOpen) return "";
  const prompts = suggestedPrompts();
  return `
    <aside class="assistant-drawer">
      <div class="assistant-head">
        <div><p class="eyebrow">Ask CivilAgent</p><h2>Context: ${assistantContext()}</h2></div>
        <button class="icon-btn quiet" data-action="close-assistant">${icon("close")}</button>
      </div>
      <div class="assistant-thread">
        <div class="assistant-message">
          <strong>${assistantDirectAnswer()}</strong>
          <h4>Why / reasoning</h4>
          <ul><li>Deterministic checks use active Scheme ${state.activeSchemeId}.</li><li>Assumptions are pulled from ${state.assumptionSetId} and referenced Vault documents.</li><li>Engineer review status controls downstream readiness.</li></ul>
          <h4>Data used</h4>
          <p>Active project, selected object, assumptions table, member checks, and Vault source links.</p>
          <h4>Suggested actions</h4>
          <div class="button-row"><button class="secondary-btn" data-action="recalculate">Recalculate</button><button class="secondary-btn" data-page="assumptions">Open assumptions</button><button class="secondary-btn" data-page="sizing">Show issues</button></div>
        </div>
      </div>
      <div class="suggested-prompts">${prompts.map((prompt) => `<button>${prompt}</button>`).join("")}</div>
      <label class="assistant-input"><input placeholder="Ask a contextual engineering workflow question..." /><button class="primary-btn">Ask</button></label>
    </aside>
  `;
}

function commandPalette() {
  if (!state.commandOpen) return "";
  const commands = [
    ["Show failing members", "sizing", "warning"],
    ["Compare schemes", "schemes", "model"],
    ["Open assumptions needing review", "assumptions", "table"],
    ["Search geotechnical report", "vault", "file"],
    ["Generate report package", "reports", "export"],
    ["Recalculate scheme", "recalculate", "reset"],
  ];
  return `
    <div class="command-backdrop">
      <section class="command-palette">
        <label>${icon("search")}<input placeholder="Search member, document, page, or action..." autofocus /></label>
        <div class="command-list">${commands.map(([label, action, iconName]) => `<button data-command="${action}">${icon(iconName)}<span>${label}</span><em>Command</em></button>`).join("")}</div>
      </section>
    </div>
  `;
}

function modalLayer() {
  if (state.modal === "new-project") {
    const activeProject = currentProject();
    return `
      <div class="modal-backdrop">
        <section class="modal">
          <div class="modal-head"><div><p class="eyebrow">New project</p><h2>Create structural workspace</h2></div><button class="icon-btn quiet" data-action="close-modal">${icon("close")}</button></div>
          <div class="form-grid">
            <label class="field"><span>Project name</span><input value="${activeProject.name}" /></label>
            <label class="field"><span>Location</span><input value="${activeProject.location}" /></label>
            <label class="field"><span>Project type</span><select><option>Mixed-use</option><option>Office</option><option>Residential</option></select></label>
            <label class="field"><span>Material preference</span><select><option>Steel</option><option>Concrete</option><option>Hybrid</option></select></label>
            <label class="field"><span>Start from</span><select><option>Revit model</option><option>IFC</option><option>PDF plans</option></select></label>
            <label class="field"><span>Design code</span><select><option>IBC 2021 / ASCE 7-16</option><option>IBC 2024 / ASCE 7-22</option></select></label>
          </div>
          <button class="primary-btn wide" data-action="create-workspace">Create Project</button>
        </section>
      </div>
    `;
  }
  return "";
}

function toastLayer() {
  if (!state.toasts.length) return "";
  return `<div class="toast-stack">${state.toasts.map((toast) => `<div class="toast">${icon("check")}<span>${toast}</span></div>`).join("")}</div>`;
}

function bind() {
  app.onclick = (event) => {
    const target = event.target.closest("[data-action], [data-page], [data-select-type], [data-view], [data-layer], [data-assumption], [data-doc], [data-vault-tab], [data-scheme], [data-command]");
    if (!target) return;
    if (target.dataset.page) {
      state.mode = "workspace";
      state.page = target.dataset.page;
      state.selectedObject = null;
      state.showLayers = false;
      render();
      return;
    }
    if (target.dataset.selectType) {
      state.selectedObject = { type: target.dataset.selectType, id: target.dataset.selectId };
      render();
      return;
    }
    if (target.dataset.view) {
      state.viewMode = target.dataset.view;
      render();
      return;
    }
    if (target.dataset.layer) {
      state.visibleLayers[target.dataset.layer] = !state.visibleLayers[target.dataset.layer];
      render();
      return;
    }
    if (target.dataset.assumption) {
      state.selectedAssumptionId = target.dataset.assumption;
      render();
      return;
    }
    if (target.dataset.doc) {
      state.selectedDocumentId = target.dataset.doc;
      render();
      return;
    }
    if (target.dataset.vaultTab) {
      state.vaultTab = target.dataset.vaultTab;
      render();
      return;
    }
    if (target.dataset.scheme) {
      state.activeSchemeId = target.dataset.scheme;
      project.activeSchemeId = target.dataset.scheme;
      addToast(`Scheme ${state.activeSchemeId} selected`);
      render();
      return;
    }
    if (target.dataset.command) {
      runCommand(target.dataset.command);
      return;
    }
    handleAction(target.dataset.action, target);
  };

  app.onchange = (event) => {
    const target = event.target;
    if (target.dataset.change === "level") state.activeLevelId = target.value;
    if (target.dataset.change === "scheme") state.activeSchemeId = target.value;
    render();
  };
}

function handleAction(action, target) {
  if (action === "new-project") state.modal = "new-project";
  if (action === "create-workspace") {
    state.activeProjectIndex = 0;
    state.modal = null;
    state.mode = "workspace";
    state.page = "overview";
  }
  if (action === "close-modal") state.modal = null;
  if (action === "open-project") {
    state.activeProjectIndex = Number(target.dataset.projectIndex || 0);
    state.mode = "workspace";
    state.page = "overview";
  }
  if (action === "back-projects") state.mode = "global";
  if (action === "open-assistant") state.assistantOpen = true;
  if (action === "close-assistant") state.assistantOpen = false;
  if (action === "toggle-layers") state.showLayers = !state.showLayers;
  if (action === "toggle-bottom") state.bottomOpen = !state.bottomOpen;
  if (action === "clear-selection") state.selectedObject = null;
  if (action === "compare-schemes") {
    state.compareMode = !state.compareMode;
    state.bottomOpen = true;
  }
  if (action === "set-active-scheme") addToast(`Scheme ${state.activeSchemeId} set active for exports`);
  if (action === "recalculate") mockRecalculate();
  if (action === "accept-geometry") addToast("Geometry accepted for placement");
  if (action === "regenerate-locked") {
    state.lastRecalculatedAt = "just now";
    addToast("Regenerated around locked decisions");
  }
  if (action === "toggle-lock") {
    const object = selectedObject();
    if (object && "locked" in object) {
      object.locked = !object.locked;
      addToast(`${object.id} ${object.locked ? "locked" : "unlocked"}`);
    }
  }
  if (action === "approve-assumption") {
    const assumption = assumptions.find((item) => item.id === state.selectedAssumptionId);
    if (assumption) assumption.status = "approved";
    addToast("Assumption approved");
  }
  if (action === "mark-reviewed") addToast("Document marked reviewed");
  if (action === "generate-report" || action === "generate-package") addToast("Preliminary report generated for engineer review");
  if (action === "export-view") addToast("View exported");
  if (action === "share") addToast("Share link copied");
  if (action === "apply-size") addToast("Suggested size applied in mock model");
  if (action === "show-tributary") {
    state.visibleLayers.tributaryAreas = true;
    addToast("Tributary area displayed");
  }
  render();
}

function runCommand(command) {
  state.commandOpen = false;
  if (command === "recalculate") {
    mockRecalculate();
    return;
  }
  if (command === "sizing") state.page = "sizing";
  if (command === "schemes") {
    state.page = "schemes";
    state.compareMode = true;
    state.bottomOpen = true;
  }
  if (command === "assumptions") state.page = "assumptions";
  if (command === "vault") state.page = "vault";
  if (command === "reports") state.page = "reports";
  state.mode = "workspace";
  addToast("Command applied");
  render();
}

function mockRecalculate() {
  if (state.recalculating) return;
  state.recalculating = true;
  render();
  window.setTimeout(() => {
    state.recalculating = false;
    state.lastRecalculatedAt = "just now";
    project.lastRecalculatedAt = "just now";
    addToast("Scheme recalculated from deterministic engine mock");
    render();
  }, 900);
}

function addToast(message) {
  state.toasts.push(message);
  window.setTimeout(() => {
    state.toasts.shift();
    render();
  }, 2600);
}

function profileBlock() {
  return `
    <div class="profile">
      <div class="profile-photo">HG</div>
      <div><strong>Harsh Grant</strong><span>Vellum Structures</span></div>
      <button class="profile-settings" aria-label="User settings">${icon("settings")}</button>
    </div>
  `;
}

function metricCard(label, value, note) {
  return `<section class="metric-card"><span>${label}</span><strong>${value}</strong><em>${note}</em></section>`;
}

function schemeCard(scheme) {
  return `
    <button class="tray-card scheme-mini ${state.activeSchemeId === scheme.id ? "active" : ""}" data-scheme="${scheme.id}">
      <strong>Option ${scheme.id} - ${scheme.name}</strong>
      <span>${scheme.note}</span>
      <div class="scheme-metrics"><em>${scheme.steel}</em><em>${scheme.cost}</em><em>${scheme.drift}</em><em>${scheme.sections} sections</em></div>
      ${statusChip(scheme.status)}
    </button>
  `;
}

function settingsCard(title, rows) {
  return `<section class="settings-card"><h3>${title}</h3>${rows.map((row) => `<span>${row}</span>`).join("")}</section>`;
}

function sourceList(items) {
  return `<div class="source-list"><p class="eyebrow">Data used</p>${items.map((item) => `<span>${item}</span>`).join("")}</div>`;
}

function chip(label) {
  return `<span class="chip">${label}</span>`;
}

function statusChip(status) {
  const key = String(status).toLowerCase().replace(/\s+/g, "-");
  return `<em class="status-chip ${key}">${status}</em>`;
}

function plainItem(label, value) {
  return `<div class="plain-item"><span>${label}</span><strong>${value}</strong></div>`;
}

function activityItem(title, time) {
  return `<div class="activity-item"><strong>${title}</strong><span>${time}</span></div>`;
}

function actionLine(title, label, page) {
  return `<button class="action-line" data-page="${page}"><span>${title}</span><em>${label}</em></button>`;
}

function workflowStep(label, done) {
  return `<div class="workflow-step ${done ? "done" : ""}"><span>${done ? "Done" : "Open"}</span><strong>${label}</strong></div>`;
}

function issueMini(title) {
  return `<button class="issue-mini">${icon("warning")}<span>${title}</span></button>`;
}

function tabLabel(tab) {
  return tab === "documents" ? "Documents" : tab === "insights" ? "Extracted insights" : "Pending review";
}

function objectLabel(type) {
  const labels = { beam: "Beam", column: "Column", shearWall: "Shear wall", core: "Core", grid: "Grid", slab: "Slab zone", noColumnZone: "No-column zone", brace: "Brace" };
  return labels[type] || "Selected object";
}

function modeLabel(mode) {
  return mode === "2d" ? "2D" : mode === "3d" ? "3D" : mode === "section" ? "Section" : "Split";
}

function suggestedPrompts() {
  const prompts = {
    geometry: ["What geometry still needs review?", "Show opening conflicts.", "Which grids are irregular?"],
    assumptions: ["What changed since the last snapshot?", "Which assumptions came from the geotech report?", "What assumptions affect drift?"],
    placement: ["Why did you place columns here?", "Try fewer interior columns.", "Regenerate around locked columns."],
    loads: ["Show load path for C4.", "What controls column axial load?", "Which load assumptions are unapproved?"],
    schemes: ["Compare Scheme A and B.", "Which scheme is most constructible?", "Why is Scheme C cheaper?"],
    sizing: ["Why is B21 failing?", "Show all members over 0.90 D/C.", "Suggest ways to reduce beam depth."],
    vault: ["What did the geotech report say?", "What extracted items need review?", "Send bearing pressure to assumptions."],
    reports: ["Draft a structural narrative.", "What sources are included in this report?", "Generate a client review package."],
  };
  return prompts[state.page] || ["What should I review next?", "What changed recently?", "Show unresolved items."];
}

function assistantContext() {
  if (state.selectedObject) return `Scheme ${state.activeSchemeId} / ${state.activeLevelId} / ${state.selectedObject.id}`;
  return `Scheme ${state.activeSchemeId} / ${activePageLabel()}`;
}

function assistantDirectAnswer() {
  if (state.selectedObject?.id === "B21") return "B21 is near capacity because live-load deflection controls.";
  if (state.page === "vault") return "The geotechnical report is referenced by foundation and seismic site assumptions.";
  if (state.page === "schemes") return "Scheme A is currently the best balance of cost, drift, and constructability.";
  return "CivilAgent can explain the current deterministic workflow state and open the relevant source data.";
}

const activity = [
  ["CivilAgent parsed Architectural_Model_Level_Set.rvt", "14 minutes ago"],
  ["Equipment load schedule needs review", "Today"],
  ["Scheme A marked as active strategy", "Yesterday"],
];

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "k") {
    event.preventDefault();
    state.commandOpen = true;
    render();
  }
  if (event.key === "Escape") {
    state.commandOpen = false;
    state.assistantOpen = false;
    state.showLayers = false;
    render();
  }
});

render();
