/**
 * IntakeSession factory and helpers.
 */

let _msgId = 0;

export function createSession() {
  return {
    sessionId: `session-${Date.now()}`,
    projectId: null,
    status: "idle",
    workflow: null,
    userGoal: "",
    messages: [],
    files: [],
    knownInputs: {},
    missingInputs: [],
    assumptions: [],
    plan: null,
  };
}

export function createMessage(role, content, extras = {}) {
  _msgId += 1;
  return {
    id: `msg-${_msgId}`,
    role,
    content,
    timestamp: Date.now(),
    ...extras,
  };
}

export function createProgressSteps(session) {
  const steps = [];
  const { files, workflow } = session;

  steps.push({ step: "Create project", status: "pending" });

  const geometryFiles = files.filter((f) => f.role === "geometry_source");
  for (const f of geometryFiles) {
    steps.push({ step: `Parse ${f.filename}`, status: "pending" });
  }

  if (geometryFiles.length > 0) {
    steps.push({ step: "Build source model", status: "pending" });
  }

  const layoutWorkflows = [
    "generate_column_layout", "generate_framing_scheme",
    "new_structural_project", "compare_design_options",
  ];

  if (layoutWorkflows.includes(workflow)) {
    steps.push({ step: "Extract structural interpretation", status: "pending" });
    steps.push({ step: "Generate scheme", status: "pending" });
  }

  steps.push({ step: "Finalize workspace", status: "pending" });

  return steps;
}
