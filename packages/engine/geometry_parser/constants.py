"""Tunable parser constants.

Every numeric threshold lives here; the parser code MUST reference these
symbols rather than inlining magic numbers. Changing a value here changes
the deterministic output of the parser, so any change must be paired
with a bump of :data:`PARSER_VERSION`.
"""

from __future__ import annotations

from typing import Final

# ---------------------------------------------------------------------------
# Versioning
# ---------------------------------------------------------------------------
PARSER_VERSION: Final[str] = "1.0.0"
SCHEMA_VERSION: Final[str] = "parsed_geometry@1.0.0"

# ---------------------------------------------------------------------------
# Grid alignment (feet)
# ---------------------------------------------------------------------------
SNAP_TOLERANCE_FT: Final[float] = 0.5
FLAG_TOLERANCE_FT: Final[float] = 3.0
CLUSTER_WINDOW_FT: Final[float] = 1.0

# ---------------------------------------------------------------------------
# Core detection (feet)
# ---------------------------------------------------------------------------
CORE_GROUPING_RADIUS_FT: Final[float] = 15.0

# ---------------------------------------------------------------------------
# Confidence thresholds. Map directly to UI banner severity.
# ---------------------------------------------------------------------------
CONFIDENCE_INFO: Final[float] = 0.8
CONFIDENCE_WARNING: Final[float] = 0.6
CONFIDENCE_CRITICAL: Final[float] = 0.4

# ---------------------------------------------------------------------------
# Parse runtime
# ---------------------------------------------------------------------------
PARSE_TIMEOUT_SECONDS: Final[int] = 600

# Step ordering. Used as the canonical ordering for progress events.
PARSE_STEPS: Final[tuple[str, ...]] = (
    "download",
    "init",
    "levels",
    "grids",
    "cores",
    "openings",
    "floor_plates",
    "existing_elements",
    "no_column_zones",
    "validation",
    "complete",
)

# Progress weights — must sum to 1.0.
STEP_WEIGHTS: Final[dict[str, float]] = {
    "download": 0.05,
    "init": 0.05,
    "levels": 0.10,
    "grids": 0.10,
    "cores": 0.10,
    "openings": 0.10,
    "floor_plates": 0.20,
    "existing_elements": 0.10,
    "no_column_zones": 0.05,
    "validation": 0.10,
    "complete": 0.05,
}

# Sanity check at import time — catches silent drift.
_total = sum(STEP_WEIGHTS.values())
if abs(_total - 1.0) > 1e-9:
    raise RuntimeError(f"STEP_WEIGHTS must sum to 1.0, got {_total!r}")
del _total

# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------
SUPPORTED_FORMATS: Final[tuple[str, ...]] = ("ifc", "dxf", "dwg", "pdf")
PDF_VECTOR_PATH_THRESHOLD: Final[int] = 500

# ---------------------------------------------------------------------------
# DXF layer fuzzy matching
# ---------------------------------------------------------------------------
GRID_LAYER_PATTERNS: Final[tuple[str, ...]] = (
    "grid",
    "s-grid",
    "a-grid",
    "grids",
    "gridline",
    "grid-line",
    "structural grid",
    "column grid",
    "ref grid",
)

COLUMN_LAYER_PATTERNS: Final[tuple[str, ...]] = (
    "column",
    "col",
    "s-col",
    "s-column",
    "columns",
    "struct-col",
    "pillar",
    "pier",
    "post",
)

WALL_LAYER_PATTERNS: Final[tuple[str, ...]] = (
    "wall",
    "s-wall",
    "shear wall",
    "core wall",
    "sw",
    "struct-wall",
    "conc-wall",
)

LAYER_MATCH_THRESHOLD: Final[float] = 0.7

# ---------------------------------------------------------------------------
# Validation weights — used to compute overall confidence.
# Categories with 0 entities contribute their default weight at 1.0.
# ---------------------------------------------------------------------------
CONFIDENCE_WEIGHTS: Final[dict[str, float]] = {
    "levels": 0.20,
    "gridLines": 0.20,
    "cores": 0.15,
    "existingColumns": 0.15,
    "floorPlates": 0.20,
    "noColumnZones": 0.05,
    "openings": 0.05,
}

# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------
IDEMPOTENCY_NAMESPACE: Final[str] = "parse_geometry"
