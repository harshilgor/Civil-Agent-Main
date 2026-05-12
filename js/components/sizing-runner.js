/**
 * Sizing run state machine.
 *
 * Encapsulates the full lifecycle of a `POST /schemes/{id}/calculate`
 * job:
 *
 *   idle → running → (complete | error)
 *
 * Concurrent runs are supported: each scheme owns one in-flight run at
 * a time, keyed by `schemeId`. Components subscribe via
 * `onSizingStateChange()` and read state with `sizingPhase(schemeId)` /
 * `sizingSteps(schemeId)` — same pattern as `scheme-generator.js`.
 *
 * The progress channel is **scheme-scoped** (`sizing-progress:{schemeId}`)
 * so two schemes can be sizing in parallel without their progress bars
 * cross-talking.
 *
 * Public API mirrors `scheme-generator.js` so the bottom tray and
 * inspector code stays uniform across agents:
 *
 *   import { startSizing, sizingPhase, onSizingStateChange } from "./sizing-runner.js";
 *
 *   startSizing(schemeId);                 // kicks off a calculation
 *   sizingPhase(schemeId);                 // "idle" | "running" | ...
 *   onSizingStateChange(() => render());   // re-render on every change
 */

import { state } from "../state.js";
import {
  triggerCalculateSizing,
  subscribeSizingProgress,
  SIZING_STEPS,
  sizingStepLabel,
} from "../api/sizing.js";
import { invalidateSizing, loadSizing } from "../canvas/scheme-adapter.js";
import { toast } from "./toast.js";

// ---------------------------------------------------------------------------
// Module-level state — one run record per scheme
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RunRecord
 * @property {"idle"|"running"|"complete"|"error"} phase
 * @property {Array<{id:string,label:string,status:"pending"|"running"|"complete"|"failed",detail:string}>} steps
 * @property {number} progress       0..1 high-water mark from the worker
 * @property {string} errorMsg
 * @property {string|null} jobId
 * @property {string|null} sizingRunId
 * @property {{close:()=>void}|null} wsSub
 */

/** schemeId → RunRecord */
const _runs = new Map();

/** Listeners fire on every state change for any scheme. */
const _listeners = new Set();

function _emit() {
  for (const fn of _listeners) {
    try {
      fn();
    } catch {
      /* never crash callers */
    }
  }
}

function _emptyRecord() {
  return {
    phase: "idle",
    steps: SIZING_STEPS.map((id) => ({
      id,
      label: sizingStepLabel(id),
      status: "pending",
      detail: "",
    })),
    progress: 0,
    errorMsg: "",
    jobId: null,
    sizingRunId: null,
    wsSub: null,
  };
}

function _record(schemeId) {
  let r = _runs.get(schemeId);
  if (!r) {
    r = _emptyRecord();
    _runs.set(schemeId, r);
  }
  return r;
}

function _setStep(record, id, patch) {
  record.steps = record.steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

/** Phase for a scheme's most recent run (returns "idle" when no record). */
export function sizingPhase(schemeId) {
  return _runs.get(schemeId)?.phase ?? "idle";
}

/** Per-step list for rendering progress UIs. */
export function sizingSteps(schemeId) {
  return _runs.get(schemeId)?.steps ?? _emptyRecord().steps;
}

/** Latest progress fraction (0..1) for a scheme — handy for a smooth bar. */
export function sizingProgress(schemeId) {
  return _runs.get(schemeId)?.progress ?? 0;
}

/** Error message when phase is "error". */
export function sizingError(schemeId) {
  return _runs.get(schemeId)?.errorMsg ?? "";
}

/** True while a scheme is actively sizing. */
export function isSizing(schemeId) {
  return sizingPhase(schemeId) === "running";
}

/**
 * Register a callback that fires on every state change across all
 * schemes. Returns an unsubscribe function.
 */
export function onSizingStateChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

/**
 * Trigger sizing for a scheme. Optionally override individual
 * assumption fields — anything missing falls through to project /
 * default assumptions in the worker.
 *
 * @param {string} schemeId
 * @param {object} [opts]
 * @param {object} [opts.assumptions]  partial overrides, camelCase
 */
export async function startSizing(schemeId, opts = {}) {
  if (!schemeId) {
    toast("No scheme selected — pick a scheme first.", { tone: "warn" });
    return;
  }
  if (sizingPhase(schemeId) === "running") return;

  const projectId = state.projectId;
  if (!projectId) {
    toast("No active project — open a project first.", { tone: "warn" });
    return;
  }

  // Reset record + invalidate the sizing cache so stale D/C colors
  // from the previous run don't show up while we recompute.
  const record = _record(schemeId);
  Object.assign(record, _emptyRecord());
  record.phase = "running";
  invalidateSizing(schemeId);
  _emit();

  // Enqueue the job
  let enqueueResult;
  try {
    enqueueResult = await triggerCalculateSizing(projectId, schemeId, {
      assumptions: opts.assumptions || null,
    });
  } catch (err) {
    record.phase = "error";
    record.errorMsg =
      err?.message ||
      "Could not start sizing — is the API running?";
    _setStep(record, "init", { status: "failed", detail: record.errorMsg });
    _emit();
    toast("Sizing failed to start", { tone: "warn" });
    return;
  }

  record.jobId = enqueueResult?.jobId || null;
  record.sizingRunId = enqueueResult?.sizingRunId || null;

  // Tear down any previous WS subscription for this scheme.
  if (record.wsSub) {
    record.wsSub.close();
    record.wsSub = null;
  }

  // Subscribe to progress
  record.wsSub = subscribeSizingProgress(schemeId, {
    onEvent(ev) {
      if (typeof ev?.progress === "number") {
        record.progress = Math.max(record.progress, ev.progress);
      }
      if (!ev?.step) {
        _emit();
        return;
      }
      const displayStatus =
        ev.status === "complete" ? "complete"
        : ev.status === "completed" ? "complete"
        : ev.status === "in_progress" ? "running"
        : ev.status === "failed" ? "failed"
        : null;
      const stepRow = record.steps.find((s) => s.id === ev.step);
      if (displayStatus && stepRow) {
        _setStep(record, ev.step, {
          status: displayStatus,
          detail: ev.detail || stepRow.detail,
        });
      }
      _emit();
    },

    async onTerminal(ev) {
      if (record.wsSub) {
        record.wsSub.close();
        record.wsSub = null;
      }

      if (ev?.status === "completed") {
        record.steps = record.steps.map((s) =>
          s.status === "pending" || s.status === "running"
            ? { ...s, status: "complete" }
            : s,
        );
        record.progress = 1;
        record.phase = "complete";
        _emit();

        // Reload sizing data into the adapter cache so the canvas
        // overlay and inspector see the new D/C numbers immediately.
        try {
          await loadSizing(projectId, schemeId, { force: true });
        } catch (err) {
          console.warn(
            "[CivilAgent] Failed to load sizing after run:",
            err?.message,
          );
        }

        // Nudge subscribers that depend on activeSchemeId-derived
        // overlays to re-paint. Re-emitting the same value is a no-op
        // for the state subsystem when activeSchemeId is unchanged,
        // so this is safe.
        if (state.activeSchemeId === schemeId) {
          state.activeSchemeId = schemeId;
        }

        toast(
          ev.detail
            ? ev.detail.slice(0, 96)
            : "Sizing complete — D/C overlay updated",
        );

        // Auto-fade the panel back to idle after a couple seconds so
        // the tray shows scheme cards again.
        setTimeout(() => {
          if (sizingPhase(schemeId) === "complete") {
            const r = _record(schemeId);
            r.phase = "idle";
            _emit();
          }
        }, 2200);
      } else {
        record.steps = record.steps.map((s) =>
          s.status === "running" ? { ...s, status: "failed" } : s,
        );
        record.phase = "error";
        record.errorMsg =
          ev?.detail || ev?.errorCode || "Sizing failed — check the worker logs.";
        _emit();
        toast(record.errorMsg.slice(0, 96), { tone: "warn" });
      }
    },

    onError(err) {
      // Transport hiccup — don't immediately tear down. The terminal
      // event will arrive on reconnect or the user can retry.
      if (record.phase !== "running") return;
      console.warn("[CivilAgent] Sizing WS error:", err);
    },

    onClose() {
      // Normal close after terminal — nothing to do.
    },
  });
}

/**
 * Reset a scheme's run state back to "idle". Closes any live WS
 * connection. Call when the user dismisses an error or navigates away.
 */
export function resetSizing(schemeId) {
  if (!schemeId) {
    _runs.forEach((r) => r.wsSub?.close());
    _runs.clear();
    _emit();
    return;
  }
  const r = _runs.get(schemeId);
  if (!r) return;
  r.wsSub?.close();
  r.wsSub = null;
  r.phase = "idle";
  r.steps = _emptyRecord().steps;
  r.errorMsg = "";
  r.progress = 0;
  _emit();
}

/** Tear down every active subscription — called on canvas unmount. */
export function disposeSizingRunner() {
  _runs.forEach((r) => r.wsSub?.close());
  _runs.clear();
  _listeners.clear();
}
