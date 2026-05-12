/**
 * Project lifecycle helpers.
 *
 * Wraps the small set of `/api/projects` endpoints used by the
 * "New project" flow. Mirrors the server contract added in
 * `apps/api/routers/projects.py`.
 */

import { request } from "./client.js";

/** Create a project and return `{ id, name, createdAt }`. */
export async function createProject(payload) {
  return await request("/api/projects", {
    method: "POST",
    body: {
      name: payload.name,
      location: payload.location || null,
      buildingType: payload.buildingType || null,
      metadata: payload.metadata || null,
    },
  });
}

/** Fetch one project by id, or null on 404. */
export async function getProject(projectId) {
  try {
    return await request(`/api/projects/${projectId}`);
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}
