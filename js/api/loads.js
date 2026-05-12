/**
 * Loads API wrapper.
 *
 * All functions fall back to the local load engine when the backend is
 * unavailable, so the frontend remains fully functional offline.
 */

import { calculateLoadAnalysis, generateLoadWarnings } from "../loads/load-engine.js";
import { columns as mockColumns } from "../data/mock-members.js";

// Lazy import of the API client — avoids a hard error if it's missing
async function apiFetch(path, opts = {}) {
  const { apiFetch: fetch } = await import("./client.js");
  return fetch(path, opts);
}

export async function getLoadCases(projectId) {
  try {
    return await apiFetch(`/projects/${projectId}/loads/cases`);
  } catch {
    return null; // caller falls back to engine defaults
  }
}

export async function saveLoadCase(projectId, loadCase) {
  try {
    return await apiFetch(`/projects/${projectId}/loads/cases`, {
      method: "POST",
      body: JSON.stringify(loadCase),
    });
  } catch {
    return { ...loadCase, _savedOffline: true };
  }
}

export async function deleteLoadCase(projectId, loadCaseId) {
  try {
    return await apiFetch(`/projects/${projectId}/loads/cases/${loadCaseId}`, {
      method: "DELETE",
    });
  } catch {
    return { deleted: false, _offline: true };
  }
}

export async function runLoadAnalysis(projectId, payload) {
  try {
    return await apiFetch(`/projects/${projectId}/loads/analyze`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    // Local engine fallback
    const { loadCases, loadCombinations } = payload;
    const results = calculateLoadAnalysis(
      loadCases,
      loadCombinations,
      mockColumns,
      null,
    );
    const warnings = generateLoadWarnings(loadCases, loadCombinations, results);
    return { ...results, warnings, _local: true };
  }
}

export async function getLoadCombinations(projectId) {
  try {
    return await apiFetch(`/projects/${projectId}/loads/combinations`);
  } catch {
    return null;
  }
}

export async function saveLoadCombination(projectId, combination) {
  try {
    return await apiFetch(`/projects/${projectId}/loads/combinations`, {
      method: "POST",
      body: JSON.stringify(combination),
    });
  } catch {
    return { ...combination, _savedOffline: true };
  }
}
