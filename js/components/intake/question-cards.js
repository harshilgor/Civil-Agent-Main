/**
 * Question cards — renders structured IntakeQuestion objects as
 * interactive controls (buttons, chips, text inputs).
 */

import { btn } from "../../utils/helpers.js";

export function renderQuestionCards(questions) {
  if (!questions || questions.length === 0) return "";

  const cards = questions.map((q) => {
    let control = "";

    if (q.type === "single_select" && q.options) {
      const opts = q.options.map((opt) =>
        `<button class="intake-option-btn" data-question="${q.id}" data-option="${opt}">${opt}</button>`
      ).join("");
      control = `<div class="intake-question-options">${opts}</div>`;
    } else if (q.type === "multi_select" && q.options) {
      const opts = q.options.map((opt) =>
        `<button class="intake-option-btn" data-question="${q.id}" data-option="${opt}" data-multi="true">${opt}</button>`
      ).join("");
      control = `<div class="intake-question-options">${opts}</div>`;
    } else {
      control = `<input class="intake-question-input" data-question-text="${q.id}" placeholder="Type your answer\u2026" />`;
    }

    return `
      <div class="intake-question" data-qid="${q.id}">
        <span class="intake-question-label">${q.label}</span>
        ${control}
      </div>
    `;
  }).join("");

  return `
    <div class="intake-questions" data-questions-group>
      ${cards}
      ${btn("Submit answers", {
        variant: "primary",
        size: "sm",
        data: { action: "submit-answers" },
      })}
    </div>
  `;
}

export function bindQuestionCards(host, onSubmit) {
  const group = host.querySelector("[data-questions-group]");
  if (!group) return;

  const answers = {};

  group.addEventListener("click", (e) => {
    const optBtn = e.target.closest("[data-option]");
    if (optBtn) {
      const qid = optBtn.dataset.question;
      const value = optBtn.dataset.option;
      const isMulti = optBtn.dataset.multi === "true";

      if (isMulti) {
        optBtn.classList.toggle("is-selected");
        if (!answers[qid]) answers[qid] = [];
        if (Array.isArray(answers[qid])) {
          const idx = answers[qid].indexOf(value);
          if (idx >= 0) answers[qid].splice(idx, 1);
          else answers[qid].push(value);
        }
      } else {
        const siblings = group.querySelectorAll(`[data-question="${qid}"]`);
        siblings.forEach((s) => s.classList.remove("is-selected"));
        optBtn.classList.add("is-selected");
        answers[qid] = value;
      }
      return;
    }

    const submitBtn = e.target.closest("[data-action='submit-answers']");
    if (submitBtn) {
      const textInputs = group.querySelectorAll("[data-question-text]");
      textInputs.forEach((input) => {
        if (input.value.trim()) answers[input.dataset.questionText] = input.value.trim();
      });

      if (Object.keys(answers).length > 0) {
        onSubmit(answers);
      }
    }
  });
}
