/**
 * Quick-start action chips — pre-written prompts.
 */

const CHIPS = [
  "Generate column layout",
  "Parse IFC model",
  "Create framing scheme",
  "Review existing structure",
  "Compare design options",
  "Estimate loads",
];

export function renderQuickStartChips() {
  const items = CHIPS.map(
    (label) => `<button class="quick-chip" data-quick-chip="${label}">${label}</button>`,
  ).join("");
  return `<div class="quick-start-chips">${items}</div>`;
}
