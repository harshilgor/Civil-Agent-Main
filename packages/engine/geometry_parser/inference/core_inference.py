"""Infer cores by spatial grouping of stair / elevator / shaft entities.

The IFC extractor calls this for any building that lacks explicit core
metadata (or whose elements are scattered such that a single
``IfcSpace`` of type=core does not exist). The DXF / PDF paths use it
on closed polylines that the layer / vision step classified as core.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from packages.engine.geometry_parser.constants import CORE_GROUPING_RADIUS_FT
from packages.engine.geometry_parser.ids import core_id
from packages.engine.geometry_parser.models import Core, Point2D

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CoreCandidate:
    """A single elevator / stair / shaft / service space.

    The inference step groups candidates by proximity, then computes a
    bounding-box boundary per group.
    """

    x: float
    y: float
    type: str  # "elevator" | "stair" | "service"
    width: float
    depth: float
    level_ids: tuple[str, ...]


def _distance(a: CoreCandidate, b: CoreCandidate) -> float:
    return ((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5


def _group_by_proximity(
    candidates: list[CoreCandidate], *, radius: float
) -> list[list[CoreCandidate]]:
    """Single-link clustering. Deterministic if input is sorted."""
    items = sorted(
        candidates,
        key=lambda c: (round(c.x, 3), round(c.y, 3), c.type),
    )
    groups: list[list[CoreCandidate]] = []
    used: set[int] = set()
    for i, base in enumerate(items):
        if i in used:
            continue
        group = [base]
        used.add(i)
        # BFS over remaining
        changed = True
        while changed:
            changed = False
            for j, other in enumerate(items):
                if j in used:
                    continue
                if any(_distance(other, member) <= radius for member in group):
                    group.append(other)
                    used.add(j)
                    changed = True
        groups.append(group)
    return groups


def _infer_type(group: list[CoreCandidate]) -> str:
    types = {c.type for c in group}
    if types == {"elevator"}:
        return "elevator"
    if types == {"stair"}:
        return "stair"
    if types == {"service"}:
        return "service"
    return "mixed"


def _bounding_polygon(group: list[CoreCandidate]) -> list[Point2D]:
    min_x = min(c.x - c.width / 2 for c in group)
    max_x = max(c.x + c.width / 2 for c in group)
    min_y = min(c.y - c.depth / 2 for c in group)
    max_y = max(c.y + c.depth / 2 for c in group)
    return [
        Point2D(x=min_x, y=min_y),
        Point2D(x=max_x, y=min_y),
        Point2D(x=max_x, y=max_y),
        Point2D(x=min_x, y=max_y),
    ]


def infer_cores(
    candidates: list[CoreCandidate],
    *,
    radius: float = CORE_GROUPING_RADIUS_FT,
    confidence: float = 0.75,
    source: str = "inferred",
) -> list[Core]:
    if not candidates:
        return []
    groups = _group_by_proximity(candidates, radius=radius)
    out: list[Core] = []
    for group in groups:
        boundary = _bounding_polygon(group)
        cx = sum(p.x for p in boundary) / len(boundary)
        cy = sum(p.y for p in boundary) / len(boundary)
        ctype = _infer_type(group)
        level_ids = sorted({lvl for c in group for lvl in c.level_ids})
        out.append(
            Core(
                id=core_id(cx, cy, ctype),
                type=ctype,  # type: ignore[arg-type]
                boundary=boundary,
                levelIds=level_ids,
                confidence=confidence,
                source=source,
                groupingReason=(
                    f"Grouped {len(group)} {ctype} elements within "
                    f"{radius:.0f}ft proximity."
                ),
            )
        )
    log.info(
        "core_inference.done",
        extra={"input": len(candidates), "groups": len(groups)},
    )
    return out
