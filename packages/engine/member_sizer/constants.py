"""Tunable load-calculator + member-sizer constants.

Every numeric threshold the engine uses lives here. Code MUST reference
these symbols rather than inlining magic numbers — changing a value
here changes the deterministic output of the calculator, so any change
must be paired with a bump of :data:`SIZER_VERSION`.

The status thresholds and label strings mirror the frontend's
``js/data/constants.js`` (``DCR_THRESHOLDS`` and ``dcrToStatus``). If
you adjust either side you must adjust the other in the same change
set — engineers rely on the visual band matching the API status seen
in audit logs.
"""

from __future__ import annotations

import math
from typing import Final

# ---------------------------------------------------------------------------
# Versioning
# ---------------------------------------------------------------------------
SIZER_VERSION: Final[str] = "1.0.0"

# ---------------------------------------------------------------------------
# Material properties (ASTM A992 — the standard W-shape steel)
# ---------------------------------------------------------------------------
DEFAULT_FY_KSI: Final[float] = 50.0
DEFAULT_E_KSI: Final[float] = 29000.0

# ---------------------------------------------------------------------------
# AISC LRFD resistance factors
# ---------------------------------------------------------------------------
PHI_FLEXURE: Final[float] = 0.90      # AISC 360 F1
PHI_SHEAR: Final[float] = 1.00        # AISC 360 G2.1 (rolled I-shapes)
PHI_COMPRESSION: Final[float] = 0.90  # AISC 360 E1

# ---------------------------------------------------------------------------
# Default gravity loads (psf). The engineer overrides via the
# project_assumptions table; these are the "no-input" baseline.
# ---------------------------------------------------------------------------
DEFAULT_DEAD_LOAD_PSF: Final[float] = 75.0
DEFAULT_LIVE_LOAD_PSF: Final[float] = 50.0
DEFAULT_ROOF_DEAD_LOAD_PSF: Final[float] = 30.0
DEFAULT_ROOF_LIVE_LOAD_PSF: Final[float] = 20.0
DEFAULT_BEAM_SELF_WEIGHT_PLF: Final[float] = 50.0  # initial estimate, iterated

# Threshold above which we assume "heavy live load" and skip reduction
# (ASCE 7-22 Section 4.7.3 — applies to assembly, storage, etc.).
HEAVY_LIVE_LOAD_PSF: Final[float] = 100.0

# Influence-area floor below which no LLR is allowed (ASCE 7-22 4.7.2).
LLR_AREA_THRESHOLD_SF: Final[float] = 400.0

# Minimum live load reduction factors (ASCE 7-22 4.7.2).
LLR_MIN_FACTOR_SINGLE_FLOOR: Final[float] = 0.50
LLR_MIN_FACTOR_MULTI_FLOOR: Final[float] = 0.40

# ---------------------------------------------------------------------------
# K_LL — Live load element factor (ASCE 7-22 Table 4.7-1).
# Source: ASCE/SEI 7-22 Chapter 4. The MVP grid generator does not
# distinguish "with cantilever" cases, so we conservatively pick the
# lower (more reduction) values where the table provides a range.
#
# NOTE: Earlier drafts used K_LL = 2 for all members. That is wrong for
# columns and is the single most common LLR mistake; columns require
# K_LL = 4 (interior), 3 (edge w/o cantilever), 2 (corner / edge with
# cantilever). Beams are 2 (interior, edge w/o cantilever) or 1
# (cantilever).
# ---------------------------------------------------------------------------
K_LL_INTERIOR_COLUMN: Final[float] = 4.0
K_LL_EDGE_COLUMN: Final[float] = 3.0
K_LL_CORNER_COLUMN: Final[float] = 2.0
K_LL_INTERIOR_BEAM: Final[float] = 2.0
K_LL_EDGE_BEAM: Final[float] = 2.0
K_LL_CANTILEVER_BEAM: Final[float] = 1.0

# ---------------------------------------------------------------------------
# Deflection limits — service load checks (ASCE 7-22 Table CC.1.1 /
# IBC §1604.3).
# ---------------------------------------------------------------------------
BEAM_LIVE_DEFLECTION_LIMIT: Final[str] = "L/360"
BEAM_TOTAL_DEFLECTION_LIMIT: Final[str] = "L/240"
ROOF_LIVE_DEFLECTION_LIMIT: Final[str] = "L/240"
ROOF_TOTAL_DEFLECTION_LIMIT: Final[str] = "L/180"

# ---------------------------------------------------------------------------
# Column effective length factor — pinned-pinned for gravity-only
# preliminary design. Lateral systems will override.
# ---------------------------------------------------------------------------
DEFAULT_K_FACTOR: Final[float] = 1.0
SLENDERNESS_WARN_THRESHOLD: Final[float] = 200.0

# Long-beam threshold above which we emit a "verify continuous bracing"
# warning. The MVP assumes Lb <= Lp (compression flange laterally
# braced), which is realistic for floor beams supporting a deck — but
# becomes increasingly suspect for spans > 25 ft, so we surface it.
LONG_BEAM_WARN_THRESHOLD_FT: Final[float] = 25.0

# ---------------------------------------------------------------------------
# LRFD load combinations — gravity only (ASCE 7-22 §2.3.1).
#
# IMPORTANT: 1.2D + 1.0L is intentionally OMITTED. For pure gravity
# loading on a member the demand is monotonically increasing in both
# D and L, so 1.2D + 1.6L always governs over 1.2D + 1.0L. Including
# it adds a redundant combination and an audit trail entry that
# confuses engineers ("why are you reporting both?"). It is reinstated
# only if a future agent introduces lateral or wind cases where the
# 1.0L coefficient may pair with a non-zero W.
# ---------------------------------------------------------------------------
LRFD_GRAVITY_COMBINATIONS: Final[tuple[dict, ...]] = (
    {"name": "1.4D", "D": 1.4, "L": 0.0},
    {"name": "1.2D + 1.6L", "D": 1.2, "L": 1.6},
)

LRFD_ROOF_COMBINATIONS: Final[tuple[dict, ...]] = (
    {"name": "1.4D", "D": 1.4, "Lr": 0.0},
    {"name": "1.2D + 1.6Lr", "D": 1.2, "Lr": 1.6},
)


# ---------------------------------------------------------------------------
# DCR status bands — must match js/data/constants.js DCR_THRESHOLDS
# and dcrToStatus(). Comparing with the frontend in lockstep is
# enforced by the contract test in tests/contract/test_sizing_api.py.
# ---------------------------------------------------------------------------
DCR_THRESHOLDS: Final[dict[str, float]] = {
    "PASS": 0.85,         # dcr < 0.85 → "pass"
    "EFFICIENT": 0.95,    # 0.85 <= dcr < 0.95 → "efficient"
    "NEAR_CAPACITY": 1.0, # 0.95 <= dcr <= 1.0 → "near-capacity"
                          # dcr > 1.0 → "fail"
}

STATUS_PASS: Final[str] = "pass"
STATUS_EFFICIENT: Final[str] = "efficient"
STATUS_NEAR_CAPACITY: Final[str] = "near-capacity"
STATUS_FAIL: Final[str] = "fail"
STATUS_UNSIZED: Final[str] = "unsized"


def dcr_to_status(dcr: float | None) -> str:
    """Mirror of ``dcrToStatus`` in ``js/data/constants.js``.

    Pure function; deterministic. Rounding behaviour matches the
    frontend (``<``, ``<``, ``<=``, ``>``).
    """
    if dcr is None or dcr <= 0 or math.isnan(dcr):
        return STATUS_UNSIZED
    if dcr < DCR_THRESHOLDS["PASS"]:
        return STATUS_PASS
    if dcr < DCR_THRESHOLDS["EFFICIENT"]:
        return STATUS_EFFICIENT
    if dcr <= DCR_THRESHOLDS["NEAR_CAPACITY"]:
        return STATUS_NEAR_CAPACITY
    return STATUS_FAIL


# ---------------------------------------------------------------------------
# Section-selection preferences. The column workhorse series (W14) is
# preferred for buildings; W12/W10 are fallbacks when the W14 family
# cannot meet capacity (rare for typical office/residential loads).
# ---------------------------------------------------------------------------
COLUMN_SERIES_PREFERENCE: Final[tuple[str, ...]] = ("W14", "W12", "W10")

# Beam selection: search the lightest section that passes all checks.
# We sort by weight ascending and walk until one passes. We cap the
# search at the deepest practical W-shape (W36) — beams larger than
# that are special engineered cases the MVP does not target.
BEAM_DEPTH_CEILING_IN: Final[float] = 36.5

# Self-weight iteration tolerance — re-run beam sizing if the actual
# self-weight differs from the assumed value by more than this fraction.
SELF_WEIGHT_RELATIVE_TOLERANCE: Final[float] = 0.05  # 5%

# ---------------------------------------------------------------------------
# Performance budgets (seconds). The orchestrator times the full
# calculate_scheme_sizing() and warns above target.
# ---------------------------------------------------------------------------
PERF_TARGET_S: Final[float] = 5.0
PERF_HARD_CAP_S: Final[float] = 30.0
