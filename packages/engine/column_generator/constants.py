"""Tunable column-layout generator constants.

Every numeric threshold lives here; the generator code MUST reference
these symbols rather than inlining magic numbers. Changing a value here
changes the deterministic output of the algorithm, so any change must
be paired with a bump of :data:`GENERATOR_VERSION`.
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Versioning
# ---------------------------------------------------------------------------
GENERATOR_VERSION: Final[str] = "1.0.0"

# ---------------------------------------------------------------------------
# Bay-size limits per material system (feet).
# Tuple is (min_bay, target_bay, max_bay).
# Sources: AISC Steel Construction Manual, ACI 318, NDS, industry rules
# of thumb. Change these with care — they govern the entire output.
# ---------------------------------------------------------------------------
MATERIAL_BAY_LIMITS: Final[dict[str, tuple[float, float, float]]] = {
    "steel_composite":     (25.0, 30.0, 45.0),
    "steel_moment_frame":  (25.0, 30.0, 40.0),
    "concrete_flat_plate": (20.0, 28.0, 35.0),
    "concrete_pan_joist":  (20.0, 30.0, 40.0),
    "timber":              (16.0, 24.0, 32.0),
}

DEFAULT_MATERIAL_SYSTEM: Final[str] = "steel_composite"

# ---------------------------------------------------------------------------
# Clearances and tolerances (feet)
# ---------------------------------------------------------------------------
CORE_BUFFER: Final[float] = 3.0
OPENING_BUFFER: Final[float] = 3.0
NCZ_BUFFER: Final[float] = 0.0          # hard boundary, no slack
STACK_TOLERANCE: Final[float] = 0.5     # column de-dup snapping
GRID_SNAP_TOLERANCE: Final[float] = 0.5 # snap to GridLine within this distance
EDGE_TOLERANCE: Final[float] = 0.25     # building-bound inclusion slop

# Beam adjacency: nearest neighbour must be within max_bay * factor.
BEAM_ADJACENCY_FACTOR: Final[float] = 1.2
BEAM_OVERLENGTH_WARN_FACTOR: Final[float] = 1.1

# ---------------------------------------------------------------------------
# Strategy definitions — exactly the five variants in the spec.
# Generated in this order; display labels A/B/C/D/E assigned by creation
# order, not by score.
# ---------------------------------------------------------------------------
STRATEGY_DEFINITIONS: Final[tuple[dict, ...]] = (
    {
        "key": "balanced",
        "name": "Balanced Strategy",
        "description": "Regular grid at target bay size, columns avoid all no-column zones.",
        "bay_factor": 1.00,
        "offset_fraction": 0.0,
        "reduce_interior": False,
    },
    {
        "key": "minimum_columns",
        "name": "Minimum Columns",
        "description": "Larger bays with alternate interior columns removed for fewer total columns.",
        "bay_factor": 1.20,
        "offset_fraction": 0.0,
        "reduce_interior": True,
    },
    {
        "key": "short_span",
        "name": "Short Span",
        "description": "Smaller bays for shallower beam depths and tighter framing.",
        "bay_factor": 0.85,
        "offset_fraction": 0.0,
        "reduce_interior": False,
    },
    {
        "key": "offset_grid",
        "name": "Offset Grid",
        "description": "Grid shifted half a bay to avoid exclusion-zone conflicts.",
        "bay_factor": 1.00,
        "offset_fraction": 0.5,
        "reduce_interior": False,
    },
    {
        "key": "long_span",
        "name": "Long Span",
        "description": "Maximised bays with interior reduction for column-light interiors.",
        "bay_factor": 1.35,
        "offset_fraction": 0.0,
        "reduce_interior": True,
    },
)

DISPLAY_LABELS: Final[tuple[str, ...]] = ("A", "B", "C", "D", "E", "F", "G", "H")

# ---------------------------------------------------------------------------
# Scoring weights — must sum to 1.0.
# ---------------------------------------------------------------------------
SCORING_WEIGHTS: Final[dict[str, float]] = {
    "regularity":      0.30,
    "span_efficiency": 0.25,
    "column_count":    0.20,
    "zone_clearance":  0.15,
    "bay_patterns":    0.10,
}

_score_total = sum(SCORING_WEIGHTS.values())
if abs(_score_total - 1.0) > 1e-9:
    raise RuntimeError(f"SCORING_WEIGHTS must sum to 1.0, got {_score_total!r}")
del _score_total

# Reasonable column-count bounds for the count score (per scheme, all levels).
# Linear interpolation: <= MIN gives 1.0, >= MAX gives 0.0.
COLUMN_COUNT_MIN: Final[int] = 16
COLUMN_COUNT_MAX: Final[int] = 200

# Zone-clearance score normalisation (feet). Average distance >= NORM
# saturates at 1.0.
ZONE_CLEARANCE_NORM_FT: Final[float] = 20.0

# ---------------------------------------------------------------------------
# Performance budgets (seconds)
# ---------------------------------------------------------------------------
PERF_TARGET_S: Final[float] = 2.0
PERF_HARD_CAP_S: Final[float] = 5.0
