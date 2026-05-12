/**
 * Shared engineering constants used across the JS frontend.
 *
 * Anything that describes a *visual band tied to engineering meaning*
 * (D/C status thresholds, badge color mapping) lives here so the canvas
 * overlays, inspector panels, and any future status badges all read from
 * the same source.
 *
 * Backend mirror:
 *   - packages/engine/geometry_parser/constants.py — confidence bands
 *   - packages/engine/member_sizer/constants.py — DCR_THRESHOLDS + status
 *     strings ("pass" / "efficient" / "near-capacity" / "fail" / "unsized").
 *
 * If you change a threshold or status string here you MUST mirror it in
 * `member_sizer/constants.py` (and bump SIZER_VERSION). Engineers rely
 * on the visual band matching the API status they see in audit logs.
 */

// ---------------------------------------------------------------------------
// Demand/Capacity ratio bands.
// ---------------------------------------------------------------------------

export const DCR_THRESHOLDS = Object.freeze({
  PASS: 0.85,        // green below this
  EFFICIENT: 0.95,   // yellow band: PASS ≤ x < EFFICIENT
  NEAR_CAPACITY: 1.0 // orange band: EFFICIENT ≤ x ≤ 1.0; red above 1.0
});

export const DCR_COLORS = Object.freeze({
  PASS: 0x22c55e,
  EFFICIENT: 0xeab308,
  NEAR_CAPACITY: 0xf97316,
  FAIL: 0xef4444,
  UNSIZED: 0x555555,
});

/** Canonical mapping DCR → integer hex color. Used by overlays & badges. */
export function dcrToColor(dcr) {
  if (dcr == null || dcr <= 0) return DCR_COLORS.UNSIZED;
  if (dcr < DCR_THRESHOLDS.PASS) return DCR_COLORS.PASS;
  if (dcr < DCR_THRESHOLDS.EFFICIENT) return DCR_COLORS.EFFICIENT;
  if (dcr <= DCR_THRESHOLDS.NEAR_CAPACITY) return DCR_COLORS.NEAR_CAPACITY;
  return DCR_COLORS.FAIL;
}

/** Canonical mapping DCR → discrete status label. */
export function dcrToStatus(dcr) {
  if (dcr == null || dcr <= 0) return "unsized";
  if (dcr < DCR_THRESHOLDS.PASS) return "pass";
  if (dcr < DCR_THRESHOLDS.EFFICIENT) return "efficient";
  if (dcr <= DCR_THRESHOLDS.NEAR_CAPACITY) return "near-capacity";
  return "fail";
}
