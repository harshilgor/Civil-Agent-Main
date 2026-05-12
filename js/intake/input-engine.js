/**
 * Missing-input calculator and question generator.
 *
 * Given a workflow + known inputs, determines which inputs are still
 * missing, then generates structured IntakeQuestion objects from the
 * question bank.
 */

import { WORKFLOW_REQUIREMENTS, QUESTION_BANK } from "./types.js";

const MAX_QUESTIONS_PER_ROUND = 5;

export function getMissingInputs(workflow, knownInputs) {
  const reqs = WORKFLOW_REQUIREMENTS[workflow];
  if (!reqs) return { required: [], recommended: [] };

  const missingRequired = reqs.required.filter((id) => !knownInputs[id]);
  const missingRecommended = reqs.recommended.filter((id) => !knownInputs[id]);
  return { required: missingRequired, recommended: missingRecommended };
}

export function generateQuestions(workflow, knownInputs) {
  const { required, recommended } = getMissingInputs(workflow, knownInputs);

  const ids = [...required, ...recommended].slice(0, MAX_QUESTIONS_PER_ROUND);

  return ids
    .filter((id) => QUESTION_BANK[id])
    .map((id) => ({
      id,
      ...QUESTION_BANK[id],
      answered: false,
      answer: undefined,
    }));
}

export function allRequiredFilled(workflow, knownInputs) {
  const reqs = WORKFLOW_REQUIREMENTS[workflow];
  if (!reqs) return true;
  return reqs.required.every((id) => knownInputs[id]);
}
