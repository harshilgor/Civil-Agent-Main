/**
 * File card list — shows classified files with role, parseability,
 * parser, warning, and remove button.
 */

import { icon } from "../../utils/icons.js";
import { ROLE_LABELS, PARSEABILITY_LABELS } from "../../intake/types.js";
import { bytes } from "../../utils/helpers.js";

export function renderFileCards(files) {
  if (!files || files.length === 0) return "";

  const cards = files.map((f) => {
    const isGeo = f.role === "geometry_source";
    const roleLabel = ROLE_LABELS[f.role] || f.role;
    const pLabel = PARSEABILITY_LABELS[f.parseability] || f.parseability;

    return `
      <div class="intake-file-card ${isGeo ? "is-geometry" : ""}" data-file-id="${f.fileId}">
        <span class="intake-file-ext">${f.extension}</span>
        <div class="intake-file-info">
          <span class="intake-file-name" title="${f.filename}">${f.filename}</span>
          <div class="intake-file-meta">
            <span class="intake-file-role">${roleLabel}</span>
            <span class="intake-file-parseability" data-p="${f.parseability}">${pLabel}</span>
            ${f.parser ? `<span>${f.parser}</span>` : ""}
          </div>
          ${f.warning ? `<span class="intake-file-warning">${f.warning}</span>` : ""}
        </div>
        <button class="intake-file-remove" data-remove-file="${f.fileId}" aria-label="Remove ${f.filename}">
          ${icon("close", 14)}
        </button>
      </div>
    `;
  }).join("");

  return `<div class="intake-file-list">${cards}</div>`;
}

export function renderInlineFileCards(files) {
  if (!files || files.length === 0) return "";
  return files.map((f) =>
    `<span class="intake-inline-file"><span class="intake-inline-file-ext">${f.extension}</span><span class="intake-inline-file-name">${f.filename}</span></span>`
  ).join("");
}
