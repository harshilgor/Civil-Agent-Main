/**
 * Load analysis runner — manages the analysis simulation lifecycle.
 *
 * Mirrors the pattern from sizing-runner.js: external listeners subscribe
 * via `onAnalysisStateChange()`, and state changes are pushed to
 * `state.loads` + reactive notification.
 */

import {
  calculateLoadAnalysis,
  generateLoadWarnings,
  createInitialLoadsState,
} from "./load-engine.js";
import { state, emit } from "../state.js";
import { columns as mockColumns } from "../data/mock-members.js";

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

const listeners = new Set();

/** Subscribe to analysis state changes. Returns unsubscribe fn. */
export function onAnalysisStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function _notify() {
  // Force reactive update — emit "loads" even though object ref is same
  emit("loads", state.loads, state.loads);
  listeners.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// Analysis stage definitions
// ---------------------------------------------------------------------------

const STAGES = [
  { fromPct: 0, toPct: 0.20, label: "Scanning structural elements…" },
  { fromPct: 0.20, toPct: 0.45, label: "Calculating tributary areas…" },
  { fromPct: 0.45, toPct: 0.70, label: "Evaluating load combinations…" },
  { fromPct: 0.70, toPct: 0.90, label: "Solving element reactions…" },
  { fromPct: 0.90, toPct: 1.00, label: "Generating warnings and summaries…" },
];

function stageLabel(pct) {
  for (const s of STAGES) {
    if (pct >= s.fromPct && pct < s.toPct) return s.label;
  }
  return "Complete";
}

// ---------------------------------------------------------------------------
// Runner state
// ---------------------------------------------------------------------------

let _timer = null;
let _isRunning = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the load analysis. No-op if already running. */
export function startAnalysis() {
  if (_isRunning) return;
  _isRunning = true;

  // Ensure loads state is initialized
  if (!state.loads) {
    state.loads = createInitialLoadsState();
  }

  const loads = state.loads;
  loads.isAnalyzing = true;
  loads.analysisStale = false;
  loads.analysisProgress = {
    current: 0,
    total: 642,
    percent: 0,
    label: "Scanning structural elements…",
    stage: "running",
  };

  _notify();

  const total = 642;
  const intervalMs = 40;
  // Reach 100% in ~5 s: increment per tick = total / (5000 / 40) = ~5.1
  const increment = total / (5000 / intervalMs);

  _timer = setInterval(() => {
    const loads = state.loads;
    if (!loads) {
      _cleanup();
      return;
    }

    const next = Math.min(loads.analysisProgress.current + increment, total);
    const pct = next / total;

    loads.analysisProgress = {
      current: Math.round(next),
      total,
      percent: pct,
      label: stageLabel(pct),
      stage: "running",
    };

    _notify();

    if (next >= total) {
      _cleanup();
      _completeAnalysis();
    }
  }, intervalMs);
}

/** Cancel a running analysis. */
export function cancelAnalysis() {
  _cleanup();
  const loads = state.loads;
  if (!loads) return;
  loads.isAnalyzing = false;
  loads.analysisProgress = {
    current: 0,
    total: 642,
    percent: 0,
    label: "Cancelled",
    stage: "idle",
  };
  loads.analysisStale = true;
  _notify();
}

/** Whether an analysis is currently running. */
export function isAnalysisRunning() {
  return _isRunning;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function _cleanup() {
  if (_timer != null) {
    clearInterval(_timer);
    _timer = null;
  }
  _isRunning = false;
}

function _completeAnalysis() {
  const loads = state.loads;
  if (!loads) return;

  const loadCases = loads.loadCases;
  const combinations = loads.loadCombinations;

  const results = calculateLoadAnalysis(loadCases, combinations, mockColumns, null);
  const warnings = generateLoadWarnings(loadCases, combinations, results);

  loads.isAnalyzing = false;
  loads.analysisStale = false;
  loads.analysisProgress = {
    current: 642,
    total: 642,
    percent: 1.0,
    label: "Complete",
    stage: "complete",
  };
  loads.loadResults = {
    totalFloorLoadKip: results.totalFloorLoadKip,
    maxColumnAxialKip: results.maxColumnAxialKip,
    maxBeamReactionKip: results.maxBeamReactionKip,
    maxWallReactionKip: results.maxWallReactionKip,
    unapprovedCases: results.unapprovedCases,
    elementResults: results.elementResults,
    controllingCombinationId: results.controllingCombinationId,
    controllingElementId: results.controllingElementId,
  };
  loads.loadCombinations = results.combinations;
  loads.warnings = warnings;

  _notify();
}
