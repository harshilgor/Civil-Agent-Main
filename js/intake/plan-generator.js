/**
 * Plan generator — builds an AgentPlan from the session state.
 */

import { WORKFLOW_LABELS } from "./types.js";

export function generatePlan(session) {
  const { workflow, files, knownInputs } = session;
  const label = WORKFLOW_LABELS[workflow] || "Structural Analysis";

  const steps = buildSteps(workflow, files);
  const assumptions = buildAssumptions(knownInputs);
  const warnings = buildWarnings(files, knownInputs);

  return {
    title: `${label} Plan`,
    steps,
    assumptions,
    warnings,
    primaryAction: "Start analysis",
  };
}

function buildSteps(workflow, files) {
  const steps = [];

  const hasIfc = files.some((f) => f.extension === "ifc");
  const hasDxf = files.some((f) => f.extension === "dxf");
  const hasDwg = files.some((f) => f.extension === "dwg");
  const hasPdf = files.some((f) => f.extension === "pdf");
  const hasGeometry = files.some((f) => f.role === "geometry_source");

  if (hasIfc) steps.push("Parse IFC geometry with IfcOpenShell");
  if (hasDxf) steps.push("Parse DXF geometry with ezdxf");
  if (hasDwg) steps.push("Convert DWG to DXF and parse geometry");
  if (hasPdf) steps.push("Extract drawing information from PDF");

  if (hasGeometry) {
    steps.push("Build source model view");
  }

  const layoutWorkflows = [
    "generate_column_layout",
    "generate_framing_scheme",
    "new_structural_project",
    "compare_design_options",
  ];

  if (layoutWorkflows.includes(workflow)) {
    steps.push("Extract levels, floor plates, cores, and constraints");
    steps.push("Build Civil Agent structural interpretation");
  }

  const outputMap = {
    generate_column_layout: "Generate column layout candidates",
    generate_framing_scheme: "Generate framing scheme options",
    parse_existing_model: "Build model view and extract metadata",
    compare_design_options: "Generate and compare design alternatives",
    review_existing_structure: "Analyze existing structural system",
    estimate_loads: "Compute gravity and lateral load takeoff",
    member_sizing: "Run member sizing checks",
    new_structural_project: "Generate preliminary structural concept",
  };

  if (outputMap[workflow]) steps.push(outputMap[workflow]);

  steps.push("Review assumptions before next step");

  return steps;
}

function buildAssumptions(knownInputs) {
  const assumptions = [];
  if (knownInputs.structural_system) assumptions.push(`Structural system: ${knownInputs.structural_system}`);
  if (knownInputs.optimization_goal) assumptions.push(`Optimization: ${knownInputs.optimization_goal}`);
  if (knownInputs.project_location) assumptions.push(`Location: ${knownInputs.project_location}`);
  if (knownInputs.building_use) assumptions.push(`Occupancy: ${knownInputs.building_use}`);
  if (knownInputs.grid_preferences) assumptions.push(`Grid: ${knownInputs.grid_preferences}`);
  if (knownInputs.floor_system_preference) assumptions.push(`Floor system: ${knownInputs.floor_system_preference}`);
  if (knownInputs.max_beam_depth) assumptions.push(`Max beam depth: ${knownInputs.max_beam_depth}`);
  return assumptions;
}

function buildWarnings(files, knownInputs) {
  const warnings = [];
  const hasGeometry = files.some((f) => f.role === "geometry_source");
  const hasGrid = knownInputs.grid_preferences && knownInputs.grid_preferences !== "Infer grid from geometry";
  const hasPdf = files.some((f) => f.extension === "pdf");
  const hasDwg = files.some((f) => f.extension === "dwg");

  if (!hasGrid && hasGeometry) {
    warnings.push("No structural grid provided \u2014 Civil Agent will infer grid candidates.");
  }
  if (hasPdf) {
    warnings.push("PDF drawings may require scale confirmation.");
  }
  if (hasDwg) {
    warnings.push("DWG parsing is experimental.");
  }
  if (!hasGeometry) {
    warnings.push("No geometry file provided \u2014 starting from blank canvas.");
  }

  return warnings;
}
