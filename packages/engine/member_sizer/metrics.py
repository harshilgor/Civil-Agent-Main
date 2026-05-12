"""Scheme-level metrics aggregation (Agent 4 portion of SchemeMetrics).

Agent 3 fills the layout-only fields (column count, span statistics,
unique bay patterns). Agent 4 fills the sizing-derived ones:

* ``steel_tonnage`` — total steel weight in tons
* ``max_beam_depth`` — deepest beam in inches
* ``unique_sections`` — count of distinct W-shape sizes
* ``cost_index`` — normalised cost proxy (raw value here; the
  orchestrator normalises across schemes)
* ``concrete_volume`` — always None (steel-only v1)
* ``max_drift`` — always None (lateral analysis out of scope)
"""

from __future__ import annotations

from typing import Iterable

from packages.engine.member_sizer.aisc_database import get_section_depth
from packages.engine.member_sizer.models import (
    MemberSizingSummary,
    UpdatedSchemeMetrics,
)


def compute_scheme_metrics(
    beam_summaries: list[MemberSizingSummary],
    column_summaries: list[MemberSizingSummary],
) -> UpdatedSchemeMetrics:
    """Aggregate per-member results into the scheme metrics that
    Agent 3 left as ``None``.

    ``cost_index`` is left as the *raw* (un-normalised) cost — the
    orchestrator divides every scheme's raw value by the cheapest
    raw value in the project to produce the normalised "1.0 =
    cheapest" output the frontend expects. We do that at the
    orchestrator level because a single scheme can't normalise
    against itself.
    """
    total_weight_lb = 0.0
    for s in beam_summaries:
        total_weight_lb += s.weight_plf * s.length_ft
    for s in column_summaries:
        total_weight_lb += s.weight_plf * s.length_ft

    steel_tonnage = total_weight_lb / 2000.0  # tons

    max_depth_in = 0.0
    for s in beam_summaries:
        max_depth_in = max(max_depth_in, get_section_depth(s.selected_size))

    sizes: set[str] = set()
    for s in beam_summaries + column_summaries:
        if s.selected_size:
            sizes.add(s.selected_size)

    # Raw cost proxy — steel weight with a small premium for variety.
    # The orchestrator normalises this to the cheapest in the run.
    raw_cost = steel_tonnage * (1.0 + 0.02 * len(sizes))

    return UpdatedSchemeMetrics(
        steel_tonnage=round(steel_tonnage, 1),
        max_beam_depth=round(max_depth_in, 1) if max_depth_in else None,
        unique_sections=len(sizes) if sizes else None,
        cost_index=round(raw_cost, 3) if raw_cost > 0 else None,
        concrete_volume=None,
        max_drift=None,
    )


def normalise_cost_index_across_schemes(
    raw_costs: Iterable[float | None],
) -> list[float | None]:
    """Normalise an iterable of raw cost values so the cheapest = 1.0.

    Returns a list aligned with the input. Schemes whose raw cost is
    ``None`` (sizing failed / not yet run) pass through as ``None``.
    """
    values = list(raw_costs)
    valid = [v for v in values if v is not None and v > 0]
    if not valid:
        return [None] * len(values)
    cheapest = min(valid)
    return [
        round(v / cheapest, 3) if v is not None and v > 0 else None
        for v in values
    ]


__all__ = [
    "compute_scheme_metrics",
    "normalise_cost_index_across_schemes",
]
