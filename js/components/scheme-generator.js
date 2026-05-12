/**
 * Scheme generation state machine.
 *
 * Encapsulates the full lifecycle of a `POST /schemes/generate` job:
 *   idle → running → (complete | error)
 *
 * Other modules subscribe to state changes via `onGenerationStateChange()`,
 * render progress however they like, and call `startGeneration()` / `resetGeneration()`.
 *
 * A single generation can be active at a time (app-level singleton). The
 * WS subscription is torn down as soon as a terminal event arrives.
 *
 * Usage pattern:
 *   import { startGeneration, generationPhase, onGenerationStateChange } from "./scheme-generator.js";
 *
 *   // mount a listener
 *   const unsub = onGenerationStateChange(() => re-render());
 *
 *   // start (called from a button click)
 *   startGeneration({ materialSystem: "steel_composite", targetBay: 30 });
 */

import { state } from "../state.js";
import { triggerGenerateSchemes, subscribeSchemeProgress } from "../api/schemes.js";
import { loadSchemes, getActiveSchemeId } from "../canvas/scheme-adapter.js";
import { toast } from "./toast.js";

// ---------------------------------------------------------------------------
// Step definitions (mirrors SCHEME_PROGRESS_STEPS in the worker)
// ---------------------------------------------------------------------------

export const SCHEME_STEPS = [
  { id: "init",            label: "Loading geometry" },
  { id: "balanced",        label: "Balanced grid" },
  { id: "minimum_columns", label: "Minimum columns" },
  { id: "short_span",      label: "Short span" },
  { id: "offset_grid",     label: "Offset grid" },
  { id: "long_span",       label: "Long span" },
  { id: "scoring",         label: "Scoring & ranking" },
  { id: "complete",        label: "Saving to workspace" },
];

// ---------------------------------------------------------------------------
// Module-level state (one generation at a time)
// ---------------------------------------------------------------------------

/** @type {"idle"|"running"|"complete"|"error"} */
let _phase = "idle";

/**
 * Per-step status tracking: { id, label, status, detail }
 * status ∈ { pending | running | complete | failed }
 */
let _steps = [];
let _errorMsg = "";
let _wsSub = null;
const _listeners = new Set();

function _emit() {
  for (const fn of _listeners) {
    try { fn(); } catch { /* never crash callers */ }
  }
}

function _stepStatus(id) {
  return _steps.find((s) => s.id === id);
}

function _setStep(id, patch) {
  _steps = _steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
  _emit();
}

function _resetSteps() {
  _steps = SCHEME_STEPS.map((s) => ({ ...s, status: "pending", detail: "" }));
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

/** Current phase of the generation machine. */
export function generationPhase() { return _phase; }

/** Per-step list for rendering progress UIs. */
export function generationSteps() { return _steps; }

/** Error message when `generationPhase() === "error"`. */
export function generationError() { return _errorMsg; }

/** Returns true while generation is actively running. */
export function isGenerating() { return _phase === "running"; }

/**
 * Register a callback that fires on every state change.
 * Returns an unsubscribe function.
 */
export function onGenerationStateChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

/**
 * Start scheme generation for the current project.
 *
 * @param {object|null} [constraints]  camelCase constraint fields forwarded
 *   to the API body verbatim, e.g.
 *   { materialSystem: "steel_composite", targetBay: 30 }
 */
export async function startGeneration(constraints = null) {
  if (_phase === "running") return;

  const projectId = state.projectId;
  if (!projectId) {
    toast("No active project — open a project first.", { tone: "warn" });
    return;
  }

  _phase = "running";
  _errorMsg = "";
  _resetSteps();
  _emit();

  // --- Enqueue the job ---
  let enqueueResult;
  try {
    enqueueResult = await triggerGenerateSchemes(projectId, { constraints });
  } catch (err) {
    _phase = "error";
    _errorMsg = err?.message || "Could not start generation — is the API running?";
    _emit();
    toast("Scheme generation failed to start", { tone: "warn" });
    return;
  }

  const { geometryId } = enqueueResult;

  // --- Tear down any previous WS subscription ---
  if (_wsSub) {
    _wsSub.close();
    _wsSub = null;
  }

  // --- Subscribe to progress ---
  _wsSub = subscribeSchemeProgress(geometryId, {
    onEvent(ev) {
      if (!ev?.step) return;
      // Worker emits `status: "in_progress"` when it starts a step and
      // `status: "complete"` when done. Map to our display statuses.
      const displayStatus =
        ev.status === "complete"    ? "complete" :
        ev.status === "completed"   ? "complete" :
        ev.status === "in_progress" ? "running"  :
        ev.status === "failed"      ? "failed"   : null;
      if (displayStatus && _stepStatus(ev.step)) {
        _setStep(ev.step, { status: displayStatus, detail: ev.detail || "" });
      }
    },

    async onTerminal(ev) {
      // Close subscription immediately; the remaining work is local.
      if (_wsSub) { _wsSub.close(); _wsSub = null; }

      if (ev.status === "completed") {
        // Mark any still-pending steps as complete (the worker may skip
        // emitting intermediate events if generation is very fast).
        _steps = _steps.map((s) =>
          s.status === "pending" || s.status === "running"
            ? { ...s, status: "complete" }
            : s,
        );
        _phase = "complete";
        _emit();

        // Reload the scheme cache and activate the new top scheme.
        try {
          await loadSchemes(projectId);
          const activeId = getActiveSchemeId();
          if (activeId && !state.activeSchemeId) {
            state.activeSchemeId = activeId;
          } else if (activeId) {
            state.activeSchemeId = activeId; // always take the newly generated active
          }
        } catch (err) {
          console.warn("[CivilAgent] Failed to reload schemes after generation:", err?.message);
        }

        toast("5 column-grid variants generated");

        // Auto-reset so the tray switches back to the scheme card list.
        setTimeout(() => {
          if (_phase === "complete") { _phase = "idle"; _emit(); }
        }, 2200);

      } else {
        // Terminal with a failure status
        _steps = _steps.map((s) =>
          s.status === "running" ? { ...s, status: "failed" } : s,
        );
        _phase = "error";
        _errorMsg = ev.detail || ev.errorCode || "Generation failed — check the worker logs.";
        _emit();
        toast(_errorMsg.slice(0, 80), { tone: "warn" });
      }
    },

    onError(err) {
      // WS transport error — if still running, mark as error.
      if (_phase !== "running") return;
      console.warn("[CivilAgent] Scheme generation WS error:", err);
      // Don't immediately fail — the job may still complete and the
      // terminal event will arrive on reconnect.
    },

    onClose() {
      // Normal WS close after terminal — nothing to do.
    },
  });
}

/**
 * Reset the generator back to "idle". Closes any live WS connection.
 * Call this when the user dismisses an error or navigates away.
 */
export function resetGeneration() {
  if (_wsSub) { _wsSub.close(); _wsSub = null; }
  _phase = "idle";
  _steps = [];
  _errorMsg = "";
  _emit();
}
