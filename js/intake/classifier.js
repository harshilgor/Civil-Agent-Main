/**
 * Intent classifier (rule-based) and file classifier (extension-based).
 */

import { FILE_CLASSIFICATION } from "./types.js";

let _fileIdSeq = 0;

// ── Intent classification ────────────────────────────────────────────

const INTENT_RULES = [
  { pattern: /column\s*(layout|grid|placement)/i,   workflow: "generate_column_layout" },
  { pattern: /generate.*column/i,                    workflow: "generate_column_layout" },
  { pattern: /framing|beam\s*layout|girder/i,        workflow: "generate_framing_scheme" },
  { pattern: /parse.*(\.(ifc|dxf|dwg)|model)/i,     workflow: "parse_existing_model" },
  { pattern: /compare|alternatives|options/i,        workflow: "compare_design_options" },
  { pattern: /review.*existing|existing.*review/i,   workflow: "review_existing_structure" },
  { pattern: /load(s|\s+take\s*off|\s+estimate)/i,  workflow: "estimate_loads" },
  { pattern: /\bsiz(e|ing)\b/i,                     workflow: "member_sizing" },
];

export function classifyIntent(messageText, hasGeometryFile) {
  const text = (messageText || "").trim();
  if (!text) return hasGeometryFile ? "new_structural_project" : "general_question";

  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) return rule.workflow;
  }

  return hasGeometryFile ? "new_structural_project" : "general_question";
}

// ── File classification ──────────────────────────────────────────────

export function classifyFile(file) {
  const name = file.name || "";
  const ext = name.split(".").pop().toLowerCase();
  const meta = FILE_CLASSIFICATION[ext] || {
    role: "supporting_document",
    parseability: "reference_only",
    parser: null,
    warning: "This file will be used as supporting context only.",
  };

  _fileIdSeq += 1;
  return {
    fileId: `file-${_fileIdSeq}-${Date.now()}`,
    filename: name,
    extension: ext,
    size: file.size || 0,
    role: meta.role,
    parseability: meta.parseability,
    parser: meta.parser,
    warning: meta.warning,
    status: "attached",
    _raw: file,
  };
}

export function classifyFiles(fileList) {
  return Array.from(fileList).map(classifyFile);
}

export function hasGeometrySource(classifiedFiles) {
  return classifiedFiles.some(
    (f) => f.role === "geometry_source",
  );
}
