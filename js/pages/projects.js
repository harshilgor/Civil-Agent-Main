import { mount, on as delegate } from "../utils/dom.js";
import { icon } from "../utils/icons.js";
import { iconBtn, btn } from "../utils/helpers.js";
import { projects } from "../data/mock-project.js";
import { navigateToNewProject, navigateToProject } from "../router.js";
import { state } from "../state.js";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

let isBound = false;

function render(host) {
  mount(
    host,
    `<div class="projects-home">
      <header class="projects-home-topbar">
        <div class="projects-home-brand">
          <span class="projects-home-brand-mark">CA</span>
          <span>CivilAgent</span>
        </div>
        <div class="projects-home-actions">
          ${btn("New project", { variant: "secondary", size: "sm", icon: "plus", data: { action: "new-project" } })}
          <button class="profile-settings" aria-label="Settings">${icon("settings", 14)}</button>
        </div>
      </header>
      <main class="projects-home-body">
        <h1 class="home-greeting">${greeting()}, Harsh</h1>
        <div class="home-input-card" data-input-card tabindex="0">
          <div class="home-input-row">
            ${icon("plus", 18)}
            <input
              type="text"
              placeholder="Start a new project..."
              data-home-input
              autocomplete="off"
            />
          </div>
          <div class="home-input-helper">
            Drop IFC, Revit, or PDF files here — or
            <button data-action="manual-setup">set up manually</button>.
          </div>
        </div>
        <section class="home-recents">
          <h2 class="home-recents-label">Recent projects</h2>
          ${projects
            .map(
              (p) => `
            <button class="recent-row" data-project-id="${p.id}">
              <span><strong>${p.name}</strong><small>${p.materialSystem}</small></span>
              <span>${p.location}</span>
              <span>Scheme ${p.activeSchemeId} · ${p.status}</span>
              <span class="recent-meta">${p.updated}</span>
            </button>
          `,
            )
            .join("")}
        </section>
      </main>
    </div>`,
  );

  const input = host.querySelector("[data-home-input]");
  if (input) input.focus();

  if (isBound) return;
  isBound = true;

  delegate(host, "click", "[data-project-id]", (_e, target) => {
    navigateToProject(target.dataset.projectId, "overview");
  });
  delegate(host, "click", "[data-action='new-project'], [data-action='manual-setup']", () => {
    const inp = host.querySelector("[data-home-input]");
    state.newProject = {
      ...state.newProject,
      seedDescription: inp?.value || "",
      step: 0,
    };
    navigateToNewProject();
  });
  delegate(host, "keydown", "[data-home-input]", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      state.newProject = {
        ...state.newProject,
        seedDescription: e.target.value || "",
        name: e.target.value || "",
      };
      navigateToNewProject();
    }
  });
  // Focus highlight (focus events don't bubble — use focusin)
  host.addEventListener("focusin", (e) => {
    if (e.target.matches?.("[data-home-input]")) {
      host.querySelector("[data-input-card]")?.classList.add("is-focus");
    }
  });
  host.addEventListener("focusout", (e) => {
    if (e.target.matches?.("[data-home-input]")) {
      host.querySelector("[data-input-card]")?.classList.remove("is-focus");
    }
  });

  // Drag-drop seeds the new-project flow
  host.addEventListener("dragenter", (e) => {
    const card = e.target.closest("[data-input-card]");
    if (card) {
      e.preventDefault();
      card.classList.add("is-dragover");
    }
  });
  host.addEventListener("dragover", (e) => {
    if (e.target.closest("[data-input-card]")) e.preventDefault();
  });
  host.addEventListener("dragleave", (e) => {
    const card = e.target.closest("[data-input-card]");
    if (card) card.classList.remove("is-dragover");
  });
  host.addEventListener("drop", (e) => {
    const card = e.target.closest("[data-input-card]");
    if (!card) return;
    e.preventDefault();
    card.classList.remove("is-dragover");
    const files = Array.from(e.dataTransfer?.files || []);
    const np = { ...state.newProject };
    np.files = filesToDescriptors(files);
    state.newProject = np;
    navigateToNewProject();
  });
}

function filesToDescriptors(files) {
  return files.map((f) => ({
    name: f.name,
    size: f.size,
    fileType: detectType(f.name),
    role: "reference",
    status: "Queued for parsing",
  }));
}

function detectType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["ifc"].includes(ext)) return "IFC";
  if (["rvt"].includes(ext)) return "RVT";
  if (["pdf"].includes(ext)) return "PDF";
  if (["dwg"].includes(ext)) return "DWG";
  if (["xlsx", "xls"].includes(ext)) return "XLSX";
  if (["docx", "doc"].includes(ext)) return "DOCX";
  return ext.toUpperCase() || "FILE";
}

export function renderProjectsHome(host) {
  host.className = "stage";
  render(host);
}
