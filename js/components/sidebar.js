import { state, on } from "../state.js";
import { icon } from "../utils/icons.js";
import { patch, on as delegate } from "../utils/dom.js";
import { projects } from "../data/mock-project.js";
import { navigateToPage, navigateToProjectsHome } from "../router.js";

const PAGES = [
  ["overview", "Overview", "projects", "1"],
  ["geometry", "Geometry", "model", "2"],
  ["assumptions", "Assumptions", "table", "3"],
  ["placement", "Placement", "model", "4"],
  ["loads", "Loads", "chart", "5"],
  ["schemes", "Schemes", "model", "6"],
  ["sizing", "Sizing", "warning", "7"],
  ["vault", "Vault", "file", "8"],
  ["reports", "Reports", "export", "9"],
  ["settings", "Settings", "settings", ""],
];

function getProject() {
  return projects.find((p) => p.id === state.projectId) || projects[0];
}

function render(host) {
  const project = getProject();
  const markup = `
    <button class="sidebar-back" data-action="back-projects">${icon("chevron_left", 14)}<span>Projects</span></button>
    <div class="sidebar-project">
      <span class="sidebar-project-name">${project.name}</span>
      <span class="sidebar-project-location">${project.location}</span>
    </div>
    <nav class="nav" aria-label="Project pages">
      ${PAGES.map(([id, label, ic, key]) => `
        <button class="nav-item ${state.page === id ? "is-active" : ""}" data-page="${id}">
          ${icon(ic, 16)}
          <span>${label}</span>
          ${key ? `<span class="nav-item-shortcut">${key}</span>` : ""}
        </button>
      `).join("")}
    </nav>
    <div class="profile">
      <div class="profile-avatar">HG</div>
      <div>
        <span class="profile-name">Harsh Grant</span>
        <span class="profile-org">Vellum Structures</span>
      </div>
      <button class="profile-settings" aria-label="User settings">${icon("settings", 14)}</button>
    </div>
  `;
  patch(host, markup);
}

export function mountSidebar(host) {
  host.classList.add("sidebar");
  host.setAttribute("aria-label", "Workspace navigation");

  delegate(host, "click", "[data-page]", (_e, target) => {
    navigateToPage(target.dataset.page);
  });
  delegate(host, "click", "[data-action='back-projects']", () => {
    navigateToProjectsHome();
  });

  const update = () => render(host);
  on("page", update);
  on("projectId", update);
  update();

  return { update };
}
