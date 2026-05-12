import { state, on } from "../state.js";
import { patch, on as delegate, mount } from "../utils/dom.js";
import { icon } from "../utils/icons.js";
import { navigateToPage } from "../router.js";

const COMMANDS = [
  { id: "page-overview",   group: "Pages",   label: "Go to Overview",      icon: "projects", shortcut: "1", run: () => navigateToPage("overview") },
  { id: "page-geometry",   group: "Pages",   label: "Go to Geometry",      icon: "model",    shortcut: "2", run: () => navigateToPage("geometry") },
  { id: "page-assumptions",group: "Pages",   label: "Go to Assumptions",   icon: "table",    shortcut: "3", run: () => navigateToPage("assumptions") },
  { id: "page-placement",  group: "Pages",   label: "Go to Placement",     icon: "model",    shortcut: "4", run: () => navigateToPage("placement") },
  { id: "page-loads",      group: "Pages",   label: "Go to Loads",         icon: "chart",    shortcut: "5", run: () => navigateToPage("loads") },
  { id: "page-schemes",    group: "Pages",   label: "Go to Schemes",       icon: "model",    shortcut: "6", run: () => navigateToPage("schemes") },
  { id: "page-sizing",     group: "Pages",   label: "Go to Sizing",        icon: "warning",  shortcut: "7", run: () => navigateToPage("sizing") },
  { id: "page-vault",      group: "Pages",   label: "Go to Vault",         icon: "file",     shortcut: "8", run: () => navigateToPage("vault") },
  { id: "page-reports",    group: "Pages",   label: "Go to Reports",       icon: "export",   shortcut: "9", run: () => navigateToPage("reports") },
  { id: "act-recalc",      group: "Actions", label: "Recalculate scheme",  icon: "reset",    shortcut: "",  run: () => { state.recalculating = true; setTimeout(() => state.recalculating = false, 800); } },
  { id: "act-assistant",   group: "Actions", label: "Ask CivilAgent",      icon: "wand",     shortcut: "",  run: () => { state.assistantOpen = true; } },
  { id: "view-3d",         group: "Views",   label: "Switch to 3D",        icon: "model",    shortcut: "Space", run: () => { state.viewMode = "3d"; } },
  { id: "view-2d",         group: "Views",   label: "Switch to 2D",        icon: "table",    shortcut: "Space", run: () => { state.viewMode = "2d"; } },
];

let host;
let query = "";
let activeIndex = 0;

function filtered() {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  return COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
}

function render() {
  if (!host) return;
  if (!state.cmdkOpen) {
    mount(host, "");
    return;
  }

  const items = filtered();
  if (activeIndex >= items.length) activeIndex = 0;

  const groups = [...new Set(items.map((i) => i.group))];
  const list = groups
    .map((g) => {
      const groupItems = items
        .filter((i) => i.group === g)
        .map(
          (cmd) => {
            const idx = items.indexOf(cmd);
            return `<button class="cmdk-item ${idx === activeIndex ? "is-active" : ""}" data-cmd="${cmd.id}" data-idx="${idx}">${icon(cmd.icon, 14)}<span>${cmd.label}</span><span class="cmdk-item-shortcut">${cmd.shortcut || ""}</span></button>`;
          },
        )
        .join("");
      return `<p class="cmdk-section-label">${g}</p>${groupItems}`;
    })
    .join("");

  mount(
    host,
    `<div class="cmdk-backdrop" data-cmdk-backdrop>
      <section class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="cmdk-input">${icon("search", 16)}<input type="text" placeholder="Search pages, actions, members..." autofocus value="${query.replace(/"/g, "&quot;")}"></div>
        <div class="cmdk-list">${list || '<p class="cmdk-section-label" style="padding:12px">No results</p>'}</div>
      </section>
    </div>`,
  );
  const input = host.querySelector("input");
  if (input) {
    input.focus();
    input.setSelectionRange(query.length, query.length);
  }
}

function close() {
  state.cmdkOpen = false;
  query = "";
  activeIndex = 0;
}

function runCurrent() {
  const items = filtered();
  const cmd = items[activeIndex];
  if (cmd) {
    cmd.run();
    close();
  }
}

export function initCommandPalette() {
  host = document.createElement("div");
  host.id = "cmdk-host";
  document.body.appendChild(host);

  delegate(host, "click", "[data-cmdk-backdrop]", (e, target) => {
    if (e.target === target) close();
  });
  delegate(host, "click", "[data-cmd]", (_e, target) => {
    activeIndex = Number(target.dataset.idx);
    runCurrent();
  });
  delegate(host, "input", "input", (e) => {
    query = e.target.value;
    activeIndex = 0;
    render();
  });
  delegate(host, "keydown", "input", (e) => {
    const items = filtered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(items.length - 1, activeIndex + 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runCurrent();
    } else if (e.key === "Escape") {
      close();
    }
  });

  on("cmdkOpen", render);
  render();
}
