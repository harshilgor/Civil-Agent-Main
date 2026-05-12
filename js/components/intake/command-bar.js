/**
 * Project Command Bar — upgraded input with file attachment, auto-grow
 * textarea, and send button.
 */

import { icon } from "../../utils/icons.js";
import { ACCEPTED_EXTENSIONS } from "../../intake/types.js";

export function renderCommandBar(opts = {}) {
  const {
    inputText = "",
    disabled = false,
    placeholder = "Describe what you want Civil Agent to do\u2026",
    helperText = "Attach IFC, DXF, DWG, PDF, RVT, reports, schedules, or drawings",
    showHelper = true,
    compact = false,
  } = opts;

  const sendVisible = inputText.trim().length > 0 ? "is-visible" : "";

  return `
    <div class="intake-command-bar ${compact ? "is-compact" : ""}" data-intake-bar>
      <div class="intake-command-row">
        <button class="intake-attach-btn" data-intake-attach aria-label="Attach files" ${disabled ? "disabled" : ""}>
          ${icon("paperclip", 18)}
        </button>
        <textarea
          class="intake-textarea"
          data-intake-input
          placeholder="${placeholder}"
          rows="1"
          ${disabled ? "disabled" : ""}
        >${inputText}</textarea>
        <button class="intake-send-btn ${sendVisible}" data-intake-send aria-label="Send" ${disabled ? "disabled" : ""}>
          ${icon("send", 16)}
        </button>
      </div>
      ${showHelper ? `<div class="intake-helper">${helperText}</div>` : ""}
      <input
        type="file"
        data-intake-file-input
        multiple
        accept="${ACCEPTED_EXTENSIONS}"
        hidden
      />
    </div>
  `;
}

export function bindCommandBar(host, callbacks = {}) {
  const bar = host.querySelector("[data-intake-bar]");
  if (!bar) return;

  const textarea = bar.querySelector("[data-intake-input]");
  const sendBtn = bar.querySelector("[data-intake-send]");
  const attachBtn = bar.querySelector("[data-intake-attach]");
  const fileInput = bar.querySelector("[data-intake-file-input]");

  // Auto-grow textarea
  if (textarea) {
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
      const hasText = textarea.value.trim().length > 0;
      sendBtn?.classList.toggle("is-visible", hasText);
      callbacks.onInput?.(textarea.value);
    });

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim()) callbacks.onSubmit?.(textarea.value.trim());
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      if (textarea?.value.trim()) callbacks.onSubmit?.(textarea.value.trim());
    });
  }

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length > 0) {
        callbacks.onFiles?.(fileInput.files);
        fileInput.value = "";
      }
    });
  }

  // Focus highlight
  if (textarea) {
    textarea.addEventListener("focus", () => bar.classList.add("is-focus"));
    textarea.addEventListener("blur", () => bar.classList.remove("is-focus"));
  }

  // Drag and drop
  bar.addEventListener("dragenter", (e) => { e.preventDefault(); bar.classList.add("is-dragover"); });
  bar.addEventListener("dragover", (e) => e.preventDefault());
  bar.addEventListener("dragleave", () => bar.classList.remove("is-dragover"));
  bar.addEventListener("drop", (e) => {
    e.preventDefault();
    bar.classList.remove("is-dragover");
    const files = e.dataTransfer?.files;
    if (files?.length > 0) callbacks.onFiles?.(files);
  });
}
