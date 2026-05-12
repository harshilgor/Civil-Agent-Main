/**
 * Plan card — displays the AgentPlan with steps, assumptions, warnings,
 * and a primary action button.
 */

import { btn } from "../../utils/helpers.js";
import { icon } from "../../utils/icons.js";

export function renderPlanCard(plan) {
  if (!plan) return "";

  const steps = plan.steps.map((s) => `<li class="intake-plan-step">${s}</li>`).join("");

  const assumptions = plan.assumptions.length > 0
    ? `<p class="intake-plan-section-label">Assumptions</p>
       <ul class="intake-plan-items">${plan.assumptions.map((a) => `<li class="intake-plan-item">${a}</li>`).join("")}</ul>`
    : "";

  const warnings = plan.warnings.length > 0
    ? `<p class="intake-plan-section-label">Warnings</p>
       <ul class="intake-plan-items intake-plan-warnings">${plan.warnings.map((w) => `<li class="intake-plan-item">${w}</li>`).join("")}</ul>`
    : "";

  return `
    <div class="intake-plan" data-plan-card>
      <h3 class="intake-plan-title">${plan.title}</h3>
      <p class="intake-plan-section-label">Steps</p>
      <ol class="intake-plan-steps">${steps}</ol>
      ${assumptions}
      ${warnings}
      <div class="intake-plan-cta">
        ${btn(plan.primaryAction, { variant: "primary", data: { action: "confirm-plan" } })}
      </div>
    </div>
  `;
}
