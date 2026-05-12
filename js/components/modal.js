import { mount, on as delegate } from "../utils/dom.js";
import { icon } from "../utils/icons.js";

let host;
let active = null;

function render() {
  if (!host) return;
  if (!active) {
    mount(host, "");
    document.body.style.overflow = "";
    return;
  }
  document.body.style.overflow = "hidden";
  mount(
    host,
    `<div class="overlay-backdrop" data-modal-backdrop>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <h2 id="modal-title">${active.title}</h2>
          <button class="btn-icon" data-modal-close aria-label="Close">${icon("close", 16)}</button>
        </div>
        <div class="modal-body">${active.body || ""}</div>
        ${active.footer ? `<div class="modal-foot">${active.footer}</div>` : ""}
      </section>
    </div>`,
  );
}

export function openModal(opts) {
  active = opts;
  render();
}

export function closeModal() {
  active = null;
  render();
}

export function initModals() {
  host = document.createElement("div");
  host.id = "modal-host";
  document.body.appendChild(host);

  delegate(host, "click", "[data-modal-close], [data-modal-backdrop]", (e, target) => {
    if (target.matches("[data-modal-backdrop]") && e.target !== target) return;
    closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && active) closeModal();
  });
}
