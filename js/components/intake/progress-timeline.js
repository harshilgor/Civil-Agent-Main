/**
 * Progress timeline — vertical step list with live status indicators.
 */

import { icon } from "../../utils/icons.js";

export function renderProgressTimeline(steps) {
  if (!steps || steps.length === 0) return "";

  const items = steps.map((s) => {
    let iconHtml = "";
    if (s.status === "done") iconHtml = icon("check", 12);
    else if (s.status === "running") iconHtml = `<span class="intake-spinner"></span>`;
    else if (s.status === "failed") iconHtml = icon("close", 12);
    else iconHtml = `<span style="width:6px;height:6px;border-radius:50%;background:var(--text-tertiary)"></span>`;

    return `
      <div class="intake-progress-step" data-status="${s.status}">
        <div class="intake-progress-icon">${iconHtml}</div>
        <span class="intake-progress-label">${s.step}</span>
        ${s.detail ? `<span class="intake-progress-detail">${s.detail}</span>` : ""}
      </div>
    `;
  }).join("");

  return `<div class="intake-progress">${items}</div>`;
}
