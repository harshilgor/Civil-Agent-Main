"""Variant scoring (0–100 scale).

Five weighted criteria — see :data:`SCORING_WEIGHTS`:

  * regularity        — how close the bay sizes are to uniform
  * span_efficiency   — how close the average span is to the target
  * column_count      — fewer columns = better, normalised
  * zone_clearance    — average distance to nearest exclusion zone
  * bay_patterns      — fewer unique bay sizes = simpler framing

Tie-breaking is done by the orchestrator (creation-order), not here.
"""

from __future__ import annotations

import math
from statistics import mean, pstdev

from shapely.geometry import Point, Polygon

from packages.engine.column_generator.constants import (
    COLUMN_COUNT_MAX,
    COLUMN_COUNT_MIN,
    SCORING_WEIGHTS,
    ZONE_CLEARANCE_NORM_FT,
)


def score_scheme(
    *,
    columns: list[dict],
    beams: list[dict],
    bay_sizes: list[float],
    target_bay: float,
    exclusion_zones: list[Polygon],
) -> tuple[float, dict[str, float]]:
    """Score a scheme variant.

    Returns ``(total_score, component_scores)``. ``total_score`` is on
    the 0–100 scale; ``component_scores`` is a debug-friendly dict of
    each criterion's contribution before weighting.
    """
    if not columns:
        # Empty schemes never score above zero — there is nothing to
        # evaluate. Return a flat zero so callers don't get misleading
        # credit from no-op components (e.g. zone_clearance=1.0 when
        # exclusion_zones is empty).
        return 0.0, {k: 0.0 for k in SCORING_WEIGHTS}
    components = {
        "regularity": _regularity(bay_sizes),
        "span_efficiency": _span_efficiency(beams, target_bay),
        "column_count": _column_count_score(len(columns)),
        "zone_clearance": _zone_clearance(columns, exclusion_zones),
        "bay_patterns": _bay_pattern_score(bay_sizes),
    }
    weighted = sum(SCORING_WEIGHTS[k] * v for k, v in components.items())
    return round(weighted * 100.0, 2), components


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------


def _regularity(bay_sizes: list[float]) -> float:
    """``1 - (std_dev / mean)``, clamped to ``[0, 1]``.

    Empty input → 0.0 (we can't score regularity with no spans).
    Mean of zero (degenerate) → 0.0.
    """
    if not bay_sizes:
        return 0.0
    bay_mean = mean(bay_sizes)
    if bay_mean <= 1e-6:
        return 0.0
    sigma = pstdev(bay_sizes) if len(bay_sizes) > 1 else 0.0
    return max(0.0, min(1.0, 1.0 - sigma / bay_mean))


def _span_efficiency(beams: list[dict], target_bay: float) -> float:
    """``1 - |avg_span - target| / target``, clamped to ``[0, 1]``."""
    if not beams or target_bay <= 0:
        return 0.0
    spans = [float(b.get("span", 0.0)) for b in beams if float(b.get("span", 0.0)) > 0]
    if not spans:
        return 0.0
    avg = mean(spans)
    return max(0.0, min(1.0, 1.0 - abs(avg - target_bay) / target_bay))


def _column_count_score(n: int) -> float:
    """Linear interpolation: ``COLUMN_COUNT_MIN`` → 1.0, ``COLUMN_COUNT_MAX`` → 0.0."""
    if n <= COLUMN_COUNT_MIN:
        return 1.0
    if n >= COLUMN_COUNT_MAX:
        return 0.0
    span = COLUMN_COUNT_MAX - COLUMN_COUNT_MIN
    return max(0.0, min(1.0, 1.0 - (n - COLUMN_COUNT_MIN) / span))


def _zone_clearance(columns: list[dict], exclusion_zones: list[Polygon]) -> float:
    """Average distance from each column to its nearest exclusion zone,
    normalised by :data:`ZONE_CLEARANCE_NORM_FT`. No exclusion zones →
    full credit (the building has no constraints).
    """
    if not columns:
        return 0.0
    if not exclusion_zones:
        return 1.0
    distances: list[float] = []
    for col in columns:
        pt = Point(col["x"], col["y"])
        d = min(zone.distance(pt) for zone in exclusion_zones)
        distances.append(d)
    avg = mean(distances)
    return max(0.0, min(1.0, avg / ZONE_CLEARANCE_NORM_FT))


def _bay_pattern_score(bay_sizes: list[float]) -> float:
    """``1 / unique_count``, normalised so 1 unique bay = 1.0, 4+ → 0.25."""
    if not bay_sizes:
        return 0.0
    unique = {round(b, 0) for b in bay_sizes}
    n = max(1, len(unique))
    return max(0.0, min(1.0, 1.0 / n))


# ---------------------------------------------------------------------------
# Helpers used by the orchestrator
# ---------------------------------------------------------------------------


def collect_bay_sizes(beams: list[dict]) -> list[float]:
    """Flatten beam spans into the bay-size list used by every score
    component. We use beam spans rather than raw ``bay_x``/``bay_y`` so
    edge bays and adjusted bays after exclusion shifting are captured.
    """
    spans = [float(b.get("span", 0.0)) for b in beams]
    return [s for s in spans if s > 0]


def unique_bay_patterns(bay_sizes: list[float]) -> int:
    """Count distinct bay sizes to the nearest foot."""
    if not bay_sizes:
        return 0
    return len({round(b, 0) for b in bay_sizes})


__all__ = [
    "collect_bay_sizes",
    "score_scheme",
    "unique_bay_patterns",
]
