/**
 * Chat thread — renders the full message history with structured
 * question cards, plan cards, progress timelines, and completion cards.
 */

import { renderInlineFileCards } from "./file-cards.js";
import { renderQuestionCards } from "./question-cards.js";
import { renderPlanCard } from "./plan-card.js";
import { renderProgressTimeline } from "./progress-timeline.js";
import { renderCompletionCard } from "./completion-card.js";

export function renderChatThread(messages) {
  if (!messages || messages.length === 0) return "";

  const items = messages.map((msg, idx) => {
    if (msg.role === "user") return renderUserMessage(msg);
    return renderAssistantMessage(msg, idx === messages.length - 1);
  }).join("");

  return items;
}

function renderUserMessage(msg) {
  const filesHtml = msg.files
    ? `<div class="intake-msg-user-files">${renderInlineFileCards(msg.files)}</div>`
    : "";
  return `
    <div class="intake-msg intake-msg-user">
      <div class="intake-msg-user-bubble">
        ${formatText(msg.content)}
        ${filesHtml}
      </div>
    </div>
  `;
}

function renderAssistantMessage(msg, isLast) {
  const parts = [];

  if (msg.content) {
    parts.push(`<div class="intake-msg-text">${formatText(msg.content)}</div>`);
  }

  if (msg.questions && isLast) {
    parts.push(renderQuestionCards(msg.questions));
  }

  if (msg.plan) {
    parts.push(renderPlanCard(msg.plan));
  }

  if (msg.progress) {
    parts.push(renderProgressTimeline(msg.progress));
  }

  if (msg.completion) {
    parts.push(renderCompletionCard());
  }

  return `<div class="intake-msg intake-msg-assistant">${parts.join("")}</div>`;
}

function formatText(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}
