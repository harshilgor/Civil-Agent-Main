import { state, on } from "../state.js";
import { mount } from "../utils/dom.js";

let host;
let counter = 0;

function render() {
  if (!host) return;
  if (!state.toasts.length) {
    mount(host, "");
    return;
  }
  const markup = state.toasts
    .map(
      (t) => `<div class="toast" data-id="${t.id}"><span class="status-dot" data-tone="${t.tone || "pass"}"></span><span>${t.message}</span></div>`,
    )
    .join("");
  mount(host, markup);
}

export function initToasts() {
  host = document.createElement("div");
  host.className = "toast-stack";
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  on("toasts", render);
  render();
}

export function toast(message, opts = {}) {
  const id = ++counter;
  state.toasts = [...state.toasts, { id, message, tone: opts.tone || "pass" }];
  setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
  }, opts.duration || 2400);
}
