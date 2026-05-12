"""Infer structural grids from column positions.

Used as a fallback when the source file does not contain explicit grid
metadata (i.e. an IFC without ``IfcGrid`` or any DXF / PDF). The
inferred grids carry ``source="inferred"`` and a downgraded
confidence — downstream consumers must surface that in the UI.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Iterable

from packages.engine.geometry_parser.constants import CLUSTER_WINDOW_FT
from packages.engine.geometry_parser.ids import grid_id
from packages.engine.geometry_parser.models import ExistingColumn, GridLine

log = logging.getLogger(__name__)


def _cluster_1d(values: list[float], window: float) -> list[float]:
    """Greedy 1-D clustering with a fixed window. Deterministic given
    the same input ordering — we sort before clustering."""
    if not values:
        return []
    sorted_vals = sorted(values)
    clusters: list[list[float]] = [[sorted_vals[0]]]
    for v in sorted_vals[1:]:
        if v - clusters[-1][-1] <= window:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    return [round(sum(c) / len(c), 4) for c in clusters]


def _label_for(axis: str, index: int) -> str:
    if axis == "x":
        return str(index + 1)
    out = ""
    n = index
    while True:
        out = chr(ord("A") + (n % 26)) + out
        n = n // 26 - 1
        if n < 0:
            break
    return out


def infer_grids_from_columns(
    columns: Iterable[ExistingColumn],
    *,
    cluster_window: float = CLUSTER_WINDOW_FT,
    confidence: float = 0.75,
) -> list[GridLine]:
    cols = list(columns)
    if len(cols) < 4:
        log.info("grid_inference.skip", extra={"reason": "too_few_columns", "count": len(cols)})
        return []
    xs = _cluster_1d([c.x for c in cols], window=cluster_window)
    ys = _cluster_1d([c.y for c in cols], window=cluster_window)

    out: list[GridLine] = []
    for i, x in enumerate(xs):
        out.append(
            GridLine(
                id=grid_id("x", _label_for("x", i), x),
                axis="x",
                label=_label_for("x", i),
                coordinate=x,
                confidence=confidence,
                source="inferred",
                rationale=f"Inferred from {len(cols)} column positions clustered on X axis.",
            )
        )
    for i, y in enumerate(ys):
        out.append(
            GridLine(
                id=grid_id("y", _label_for("y", i), y),
                axis="y",
                label=_label_for("y", i),
                coordinate=y,
                confidence=confidence,
                source="inferred",
                rationale=f"Inferred from {len(cols)} column positions clustered on Y axis.",
            )
        )
    log.info(
        "grid_inference.done",
        extra={"x_lines": len(xs), "y_lines": len(ys), "input_columns": len(cols)},
    )
    return out


def reconcile_columns_to_grid(
    columns: list[ExistingColumn],
    grids: list[GridLine],
    *,
    snap_tolerance: float,
    flag_tolerance: float,
) -> list[ExistingColumn]:
    """Annotate each column with grid-alignment status.

    * ``deviation <= snap_tolerance``: ``gridAligned=True``,
      ``gridDeviation=None``.
    * ``snap < deviation <= flag_tolerance``: ``gridAligned=True``,
      ``gridDeviation`` set; UI shows informational badge.
    * ``deviation > flag_tolerance``: ``gridAligned=False``,
      ``gridDeviation`` set; UI shows warning badge.
    """
    if not grids:
        return columns
    by_axis: dict[str, list[float]] = defaultdict(list)
    labels_by_axis: dict[str, list[tuple[float, str]]] = defaultdict(list)
    for g in grids:
        by_axis[g.axis].append(g.coordinate)
        labels_by_axis[g.axis].append((g.coordinate, g.label))
    for axis in by_axis:
        by_axis[axis].sort()
        labels_by_axis[axis].sort()

    out: list[ExistingColumn] = []
    for col in columns:
        dev_x, lbl_x = _nearest(by_axis["x"], labels_by_axis["x"], col.x)
        dev_y, lbl_y = _nearest(by_axis["y"], labels_by_axis["y"], col.y)
        deviation = max(dev_x, dev_y)
        if deviation <= snap_tolerance:
            updated = col.model_copy(
                update={
                    "gridAligned": True,
                    "gridDeviation": None,
                    "gridLabel": f"{lbl_x}-{lbl_y}" if lbl_x and lbl_y else col.gridLabel,
                }
            )
        elif deviation <= flag_tolerance:
            updated = col.model_copy(
                update={
                    "gridAligned": True,
                    "gridDeviation": round(deviation, 3),
                    "gridLabel": f"{lbl_x}-{lbl_y}" if lbl_x and lbl_y else col.gridLabel,
                    "rationale": (
                        f"Within snap-tolerance window ({deviation:.2f}ft from "
                        f"{lbl_x}-{lbl_y})."
                    ),
                }
            )
        else:
            updated = col.model_copy(
                update={
                    "gridAligned": False,
                    "gridDeviation": round(deviation, 3),
                    "gridLabel": f"{lbl_x}-{lbl_y}" if lbl_x and lbl_y else None,
                    "rationale": (
                        f"Off-grid by {deviation:.2f}ft (nearest "
                        f"{lbl_x}-{lbl_y}); requires engineer review."
                    ),
                }
            )
        out.append(updated)
    return out


def _nearest(
    sorted_coords: list[float], labels: list[tuple[float, str]], target: float
) -> tuple[float, str]:
    if not sorted_coords:
        return float("inf"), ""
    best = min(sorted_coords, key=lambda c: abs(c - target))
    label = next((lab for c, lab in labels if c == best), "")
    return abs(best - target), label
