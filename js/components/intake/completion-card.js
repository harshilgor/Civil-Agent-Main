/**
 * Completion card — shows "Your project is ready" with an
 * "Open workspace" button.
 */

import { btn } from "../../utils/helpers.js";
import { icon } from "../../utils/icons.js";

export function renderCompletionCard() {
  return `
    <div class="intake-completion">
      <div>${icon("check", 28)}</div>
      <h3 class="intake-completion-title">Your project is ready.</h3>
      <p class="intake-completion-sub">The workspace is configured with your files, assumptions, and initial structural interpretation.</p>
      <div class="intake-completion-actions">
        ${btn("Open workspace", { variant: "primary", data: { action: "open-workspace" } })}
        ${btn("Start another", { variant: "secondary", data: { action: "reset-intake" } })}
      </div>
    </div>
  `;
}
