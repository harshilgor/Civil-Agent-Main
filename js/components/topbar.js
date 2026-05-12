import { state, on } from "../state.js";
import { patch, on as delegate } from "../utils/dom.js";
import { icon } from "../utils/icons.js";
import { btn, iconBtn, chip } from "../utils/helpers.js";
import { projects } from "../data/mock-project.js";
import { toast } from "./toast.js";
import { getCachedScheme } from "../canvas/scheme-adapter.js";

function getProject() {
  return projects.find((p) => p.id === state.projectId) || projects[0];
}

const PAGE_LABELS = {
  overview: "Overview",
  geometry: "Geometry",
  assumptions: "Assumptions",
  placement: "Placement",
  loads: "Loads",
  schemes: "Schemes",
  sizing: "Sizing",
  vault: "Vault",
  reports: "Reports",
  settings: "Settings",
};

function activeSchemeLabel() {
  const id = state.activeSchemeId;
  if (!id) return "—";
  const scheme = getCachedScheme(id);
  if (!scheme) return id.slice(0, 8); // short UUID until cache hydrates
  // Engineers refer to schemes by display label ("A") and read the
  // strategy name as a tooltip — never by the raw UUID, which is
  // implementation detail, not communication.
  return scheme.displayLabel || scheme.name || id.slice(0, 8);
}

function render(host) {
  const project = getProject();
  const schemeLabel = activeSchemeLabel();
  const breadcrumb = `${PAGE_LABELS[state.page] || "Workspace"} <span class="breadcrumb-sep">/</span> Active Scheme ${schemeLabel} <span class="breadcrumb-sep">/</span> ${project.status}`;

  const markup = `
    <div class="topbar-left">
      <div class="topbar-title">
        <span class="topbar-title-name">${project.name}</span>
        <span class="topbar-breadcrumb">${breadcrumb}</span>
      </div>
    </div>
    <div class="topbar-actions">
      ${chip(`Scheme ${schemeLabel}`)}
      ${chip(state.assumptionSetId)}
      <span class="last-sync">${state.recalculating ? "Recalculating..." : `Recalculated ${project.lastRecalculatedAt}`}</span>
      <span class="topbar-divider"></span>
      ${btn(state.recalculating ? "Running" : "Recalculate", { variant: "secondary", size: "sm", data: { action: "recalculate" } })}
      ${btn("Ask CivilAgent", { variant: "secondary", size: "sm", icon: "wand", data: { action: "open-assistant" } })}
      ${iconBtn("export", { label: "Export", data: { action: "export" } })}
      ${iconBtn("share", { label: "Share", data: { action: "share" } })}
      ${iconBtn("settings", { label: "Project settings", data: { page: "settings" } })}
    </div>
  `;
  patch(host, markup);
}

export function mountTopbar(host) {
  host.classList.add("topbar");

  delegate(host, "click", "[data-action]", (_e, target) => {
    const action = target.dataset.action;
    if (action === "recalculate") {
      if (state.recalculating) return;
      state.recalculating = true;
      setTimeout(() => {
        state.recalculating = false;
        toast("Scheme recalculated");
      }, 900);
    } else if (action === "open-assistant") {
      state.assistantOpen = true;
    } else if (action === "export") {
      toast("View exported");
    } else if (action === "share") {
      toast("Share link copied");
    }
  });

  const update = () => render(host);
  on("page", update);
  on("projectId", update);
  on("activeSchemeId", update);
  on("recalculating", update);
  update();

  return { update };
}
