/**
 * Hash-based router.
 *
 * Routes:
 *   #/                                     → projects home
 *   #/new                                  → new project wizard
 *   #/processing                           → live parsing screen
 *   #/p/:projectId/:page                   → workspace page
 *
 * The router is the single source of truth for `state.mode` / `state.page` /
 * `state.projectId`. Code that wants to navigate calls `navigate(path)`
 * rather than mutating state directly.
 */

import { state, setMany } from "./state.js";

const VALID_PAGES = new Set([
  "overview",
  "geometry",
  "assumptions",
  "placement",
  "loads",
  "schemes",
  "sizing",
  "vault",
  "reports",
  "settings",
]);

export function navigate(path) {
  const target = path.startsWith("#") ? path : `#${path}`;
  if (window.location.hash === target) {
    handleRoute();
  } else {
    window.location.hash = target;
  }
}

export function navigateToPage(page) {
  if (!state.projectId) return;
  navigate(`/p/${state.projectId}/${page}`);
}

export function navigateToProject(projectId, page = "overview") {
  navigate(`/p/${projectId}/${page}`);
}

export function navigateToProjectsHome() {
  navigate("/");
}

export function navigateToNewProject() {
  navigate("/new");
}

export function navigateToProcessing() {
  navigate("/processing");
}

function parseHash() {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  if (hash === "/" || hash === "") return { mode: "projects" };
  if (hash === "/new") return { mode: "new-project" };
  if (hash === "/processing") return { mode: "processing" };

  const projectMatch = hash.match(/^\/p\/([^/]+)\/([^/]+)/);
  if (projectMatch) {
    const [, projectId, page] = projectMatch;
    return {
      mode: "workspace",
      projectId,
      page: VALID_PAGES.has(page) ? page : "overview",
    };
  }
  return { mode: "projects" };
}

function handleRoute() {
  const route = parseHash();
  setMany(route);
}

export function initRouter() {
  window.addEventListener("hashchange", handleRoute);
  if (!window.location.hash) window.location.hash = "#/";
  handleRoute();
}
