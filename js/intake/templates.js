/**
 * Assistant response template assembler.
 * Builds text content for assistant messages at each stage.
 */

import { ROLE_LABELS } from "./types.js";

export function buildFirstResponse(session, questions) {
  const { files } = session;
  const hasFiles = files.length > 0;
  const hasQuestions = questions.length > 0;

  if (hasFiles && hasQuestions) {
    return buildResponseWithFilesAndQuestions(files);
  }
  if (hasFiles && !hasQuestions) {
    return buildResponseWithFilesNoQuestions(files);
  }
  return buildResponseNoFiles();
}

function buildResponseWithFilesAndQuestions(files) {
  const fileLines = files.map((f) => {
    const role = ROLE_LABELS[f.role] || f.role;
    const warn = f.warning ? ` ${f.warning}` : "";
    return `\u2022 **${f.filename}** \u2014 ${role}.${warn}`;
  });
  return `I can help with that. Here\u2019s how I\u2019ll use your files:\n\n${fileLines.join("\n")}\n\nBefore I start, I need a few details:`;
}

function buildResponseWithFilesNoQuestions(files) {
  const fileLines = files.map((f) => {
    const role = ROLE_LABELS[f.role] || f.role;
    const warn = f.warning ? ` ${f.warning}` : "";
    return `\u2022 **${f.filename}** \u2014 ${role}.${warn}`;
  });
  return `I have everything I need to get started.\n\n${fileLines.join("\n")}`;
}

function buildResponseNoFiles() {
  return `I can help with that. Do you have any files to attach?\n\nI can work with:\n\u2022 IFC files for direct geometry extraction\n\u2022 DXF/DWG for CAD-based geometry\n\u2022 PDF drawings as reference (may need scale confirmation)\n\u2022 RVT as reference (export to IFC for geometry parsing)\n\u2022 Reports, schedules, and other supporting documents\n\nOr I can start from a blank canvas if you prefer.`;
}

export function buildAnswerSummary(answers, questionMap) {
  const lines = Object.entries(answers).map(([id, value]) => {
    const q = questionMap[id];
    const label = q ? q.label.replace(/\?.*$/, "") : id;
    const val = Array.isArray(value) ? value.join(", ") : value;
    return `${label}: **${val}**`;
  });
  return lines.join("\n");
}

export function buildFollowUpResponse() {
  return "Thanks. Just a few more details:";
}

export function buildPlanIntro() {
  return "Here\u2019s my plan based on what you\u2019ve provided:";
}
