/**
 * Page-specific config presets for the optimization animation.
 *
 * Each preset describes the metrics, copy, and optional page-specific
 * behaviour for one of the four AI-action pages. Callers just do:
 *
 *   import { triggerOptimization } from "./optimization-presets.js";
 *   triggerOptimization("placement");
 *
 * The orchestrator does the rest.
 */

import { runOptimization, isOptimizationRunning } from "./optimization-animation.js";

const PRESETS = {
  placement: {
    pageId: "placement",
    durations: { scan: 3500, iterate: 10000, resolve: 3500 },
    totalIterations: 847,
    visibleIterations: 6,
    iterationLabel: "Optimizing — evaluating 847 configurations…",
    successMessage: "Optimization complete — 18% cost reduction achieved",
    iterateColumnsAndSlabs: true,
    regenerateBtnSelector: ".inspector .btn-primary[data-action='regenerate']",
    metrics: [
      { key: "iter",   label: "Design iteration", isCounter: true,
        start: 1, end: 847,
        format: (v) => `${Math.round(v).toLocaleString()} of 847` },
      { key: "cols",   label: "Total columns",
        start: 42, end: 34, unit: "",
        format: (v) => `${Math.round(v)}`, deltaText: "−8 columns" },
      { key: "span",   label: "Max span",
        start: 31.8, end: 28.4, unit: " ft",
        format: (v) => `${v.toFixed(1)} ft`, deltaText: "−3.4 ft" },
      { key: "steel",  label: "Est. steel weight",
        start: 128, end: 105, unit: " tons",
        format: (v) => `${Math.round(v)} t`, deltaText: "↓ 18%" },
      { key: "cost",   label: "Est. cost",
        start: 2.4, end: 2.02,
        format: (v) => `$${v.toFixed(2)}M`, deltaText: "−$380K" },
      { key: "carbon", label: "Carbon",
        start: 340, end: 282, unit: " tCO₂",
        format: (v) => `${Math.round(v)} tCO₂`, deltaText: "↓ 17%" },
    ],
  },

  loads: {
    pageId: "loads",
    durations: { scan: 4000, iterate: 11000, resolve: 3500 },
    totalIterations: 642,
    visibleIterations: 7,
    iterationLabel: "Solving — evaluating load combinations…",
    successMessage: "Load analysis complete — 0 unapproved cases remain",
    combinationTargetLabel: "Active combination",
    finalCombination: "1.2D + 1.0L + 1.0S",
    combinationCycle: [
      "1.2D + 1.6L",
      "1.4D",
      "1.2D + 1.0L + 1.0S",
      "0.9D + 1.0E",
      "1.2D + 1.0E + 1.0L",
      "1.2D + 1.0W + 1.0L",
      "1.2D + 1.6L + 0.5S",
    ],
    metrics: [
      { key: "iter", label: "Design iteration", isCounter: true,
        start: 1, end: 642,
        format: (v) => `${Math.round(v).toLocaleString()} of 642` },
      { key: "totalfloor", label: "Total L6 floor load",
        start: 8420, end: 8240,
        format: (v) => `${Math.round(v).toLocaleString()} kip`, deltaText: "−180 kip" },
      { key: "axial",      label: "Max column axial",
        start: 728, end: 692,
        format: (v) => `${Math.round(v)} kip`, deltaText: "−36 kip" },
      { key: "unapproved", label: "Unapproved cases",
        start: 1, end: 0,
        format: (v) => `${Math.max(0, Math.round(v))}`, deltaText: "−1" },
    ],
  },

  schemes: {
    pageId: "schemes",
    durations: { scan: 3500, iterate: 12000, resolve: 4000 },
    totalIterations: 1240,
    visibleIterations: 5,
    iterationLabel: "Generating — exploring 1,240 layout strategies…",
    successMessage: "5 column-grid variants generated",
    dramaticCrossfade: true,
    schemeFilmstrip: true,
    metrics: [
      { key: "iter", label: "Schemes evaluated", isCounter: true,
        start: 1, end: 1240,
        format: (v) => `${Math.round(v).toLocaleString()} of 1,240` },
      { key: "cols",      label: "Top scheme columns",
        start: 48, end: 36,
        format: (v) => `${Math.round(v)}`, deltaText: "−12 columns" },
      { key: "tonnage",   label: "Top scheme steel",
        start: 142, end: 108,
        format: (v) => `${Math.round(v)} t`, deltaText: "↓ 24%" },
      { key: "score",     label: "Best score",
        start: 0.62, end: 0.91,
        format: (v) => `${v.toFixed(2)}`, deltaText: "+0.29" },
    ],
  },

  sizing: {
    pageId: "sizing",
    durations: { scan: 3500, iterate: 11000, resolve: 4500 },
    totalIterations: 102,
    visibleIterations: 6,
    iterationLabel: "Sizing — evaluating section catalog…",
    successMessage: "Sizing complete — 94 passing, 8 near capacity, 0 failing",
    utilizationColors: true,
    metrics: [
      { key: "iter", label: "Section iterations", isCounter: true,
        start: 1, end: 102,
        format: (v) => `${Math.round(v).toLocaleString()} of 102` },
      { key: "tonnage", label: "Total steel weight",
        start: 134, end: 108,
        format: (v) => `${Math.round(v)} t`, deltaText: "↓ 19%" },
      { key: "depth", label: "Max beam depth",
        start: 24, end: 21,
        format: (v) => `${Math.round(v)} in`, deltaText: "−3 in" },
      { key: "passing", label: "Passing members",
        start: 64, end: 94,
        format: (v) => `${Math.round(v)}`, deltaText: "+30" },
      { key: "failing", label: "Failing members",
        start: 12, end: 0,
        format: (v) => `${Math.max(0, Math.round(v))}`, deltaText: "−12" },
    ],
  },
};

/**
 * Run the optimization animation for a specific page.
 *
 * @param {"placement"|"loads"|"schemes"|"sizing"} pageId
 * @param {object} [overrides] shallow merged into the preset
 * @returns {Promise<void>}
 */
export function triggerOptimization(pageId, overrides = {}) {
  if (isOptimizationRunning()) return Promise.resolve();
  const base = PRESETS[pageId];
  if (!base) {
    console.warn("[opt-anim] No preset for page:", pageId);
    return Promise.resolve();
  }
  return runOptimization({ ...base, ...overrides });
}

export function getPreset(pageId) {
  return PRESETS[pageId] || null;
}
