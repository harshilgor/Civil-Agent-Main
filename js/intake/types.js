/**
 * Intake system constants and type definitions.
 *
 * No runtime types (vanilla JS) — this module exports the enums,
 * lookup tables, and question bank used by the classifier, input engine,
 * and plan generator.
 */

export const WORKFLOW_TYPES = [
  "generate_column_layout",
  "generate_framing_scheme",
  "parse_existing_model",
  "compare_design_options",
  "review_existing_structure",
  "estimate_loads",
  "member_sizing",
  "new_structural_project",
  "general_question",
];

export const WORKFLOW_LABELS = {
  generate_column_layout: "Column Layout Generation",
  generate_framing_scheme: "Framing Scheme Generation",
  parse_existing_model: "Model Parsing",
  compare_design_options: "Design Option Comparison",
  review_existing_structure: "Existing Structure Review",
  estimate_loads: "Load Estimation",
  member_sizing: "Member Sizing",
  new_structural_project: "New Structural Project",
  general_question: "General Question",
};

export const INTAKE_STATUSES = [
  "idle",
  "classifying_intent",
  "collecting_files",
  "asking_questions",
  "ready_for_plan",
  "awaiting_confirmation",
  "running_analysis",
  "needs_followup",
  "completed",
  "failed",
];

export const FILE_CLASSIFICATION = {
  ifc:  { role: "geometry_source",      parseability: "parseable",       parser: "ifcopenshell",      warning: null },
  dxf:  { role: "geometry_source",      parseability: "parseable",       parser: "ezdxf",             warning: "DXF parsing depends on clean layers and blocks." },
  dwg:  { role: "geometry_source",      parseability: "experimental",    parser: "odafc_to_dxf",      warning: "DWG support is experimental. Export to DXF if parsing fails." },
  pdf:  { role: "drawing_or_reference", parseability: "conditional",     parser: "pymupdf_or_vision", warning: "PDF drawings may need scale and page confirmation." },
  rvt:  { role: "reference_model",      parseability: "reference_only",  parser: null,                warning: "RVT is reference-only. Export to IFC for geometry extraction." },
  xlsx: { role: "supporting_document",  parseability: "reference_only",  parser: null,                warning: null },
  docx: { role: "supporting_document",  parseability: "reference_only",  parser: null,                warning: null },
  csv:  { role: "supporting_document",  parseability: "reference_only",  parser: null,                warning: null },
  png:  { role: "supporting_document",  parseability: "reference_only",  parser: null,                warning: null },
  jpg:  { role: "supporting_document",  parseability: "reference_only",  parser: null,                warning: null },
  jpeg: { role: "supporting_document",  parseability: "reference_only",  parser: null,                warning: null },
};

export const ROLE_LABELS = {
  geometry_source: "Geometry source",
  drawing_or_reference: "Drawing / reference",
  reference_model: "Reference model",
  supporting_document: "Supporting document",
};

export const PARSEABILITY_LABELS = {
  parseable: "Parseable",
  experimental: "Experimental",
  conditional: "Conditional",
  reference_only: "Reference only",
};

export const WORKFLOW_REQUIREMENTS = {
  generate_column_layout: {
    required: ["geometry_source", "project_location", "building_use"],
    recommended: ["structural_system", "optimization_goal", "no_column_zones", "core_locations", "grid_preferences"],
    optional: ["soil_report", "firm_standards", "existing_structural_drawings"],
  },
  generate_framing_scheme: {
    required: ["geometry_source", "project_location", "building_use", "structural_system"],
    recommended: ["optimization_goal", "max_beam_depth", "floor_system_preference"],
    optional: ["architectural_constraints", "vibration_criteria"],
  },
  parse_existing_model: {
    required: ["geometry_source"],
    recommended: [],
    optional: ["reference_drawings"],
  },
  compare_design_options: {
    required: ["geometry_source", "project_location", "building_use"],
    recommended: ["structural_system", "optimization_goal"],
    optional: ["budget_constraints", "schedule_constraints"],
  },
  review_existing_structure: {
    required: ["geometry_source"],
    recommended: ["project_location", "building_use", "structural_system"],
    optional: ["existing_calculations", "inspection_reports"],
  },
  estimate_loads: {
    required: ["geometry_source", "project_location", "building_use"],
    recommended: ["structural_system", "soil_data"],
    optional: ["snow_load_override", "special_loads"],
  },
  member_sizing: {
    required: ["geometry_source", "project_location", "building_use", "structural_system"],
    recommended: ["optimization_goal", "connection_preferences"],
    optional: ["deflection_limits", "fireproofing_constraints"],
  },
  new_structural_project: {
    required: ["geometry_source", "project_location", "building_use"],
    recommended: ["structural_system", "optimization_goal", "desired_output"],
    optional: ["soil_report", "architectural_constraints"],
  },
  general_question: {
    required: [],
    recommended: [],
    optional: [],
  },
};

export const QUESTION_BANK = {
  structural_system: {
    type: "single_select",
    label: "What structural system should I assume?",
    options: ["Steel", "Concrete", "Wood", "Hybrid", "Unsure \u2014 recommend one"],
  },
  project_location: {
    type: "text",
    label: "What is the project location? (Needed for code, seismic, and wind assumptions)",
  },
  building_use: {
    type: "single_select",
    label: "What is the building use?",
    options: ["Office", "Residential", "Mixed-use", "Parking", "Industrial", "School/Institutional", "Other"],
  },
  optimization_goal: {
    type: "single_select",
    label: "What should I optimize for?",
    options: ["Lowest cost", "Lowest tonnage", "Lowest drift", "Construction simplicity", "Balanced"],
  },
  desired_output: {
    type: "single_select",
    label: "What do you want generated first?",
    options: ["Column layout", "Framing scheme", "Load takeoff", "Member sizing", "Full preliminary concept"],
  },
  no_column_zones: {
    type: "text",
    label: "Are there any no-column zones or areas where columns must be avoided?",
  },
  core_locations: {
    type: "text",
    label: "Are there known core or shear wall locations I should respect?",
  },
  grid_preferences: {
    type: "single_select",
    label: "Do you have a structural grid, or should I infer one?",
    options: ["Infer grid from geometry", "I'll provide a grid drawing", "No grid needed yet"],
  },
  max_beam_depth: {
    type: "text",
    label: "Is there a maximum beam depth constraint? (e.g., 'W18 max' or '18 inches')",
  },
  floor_system_preference: {
    type: "single_select",
    label: "Floor system preference?",
    options: ["Composite deck", "Non-composite", "Concrete slab", "Precast plank", "Unsure"],
  },
};

export const ACCEPTED_EXTENSIONS = ".ifc,.dxf,.dwg,.pdf,.rvt,.xlsx,.docx,.csv,.png,.jpg,.jpeg";
