"""Beam generation between adjacent columns.

Adjacency is **grid-based** (sort by x then by y, connect each column
to its nearest horizontal neighbour on the same row and nearest
vertical neighbour on the same column). We deliberately avoid scipy /
Delaunay — neither is in the project's dependency manifest, and
rectangular column layouts don't need a triangulation.

Beams that would pass through an exclusion zone are filtered out
(Shapely ``LineString.intersects(polygon)``). Beams whose span exceeds
``max_bay * BEAM_OVERLENGTH_WARN_FACTOR`` keep the beam but emit a
warning so Agent 4 (or the engineer reviewing the scheme) knows it
will need a heavier section than the typical bay.
"""

from __future__ import annotations

from shapely.geometry import LineString, Polygon

from packages.engine.column_generator.constants import (
    BEAM_ADJACENCY_FACTOR,
    BEAM_OVERLENGTH_WARN_FACTOR,
    EDGE_TOLERANCE,
)


def generate_beams(
    columns: list[dict],
    levels: list[dict],
    exclusion_zones: list[Polygon],
    max_bay: float,
    *,
    id_prefix: str = "",
) -> tuple[list[dict], list[str]]:
    """Generate beams at every level by grid-based neighbour adjacency.

    Parameters
    ----------
    columns : list of dict
        Columns with ``x``, ``y``, ``start_level``, ``end_level`` (level
        ids). Each column is assumed to span between the two named
        levels inclusive.
    levels : list of dict
        Ordered by elevation ascending. Each entry needs ``id`` and
        ``elevation``.
    exclusion_zones : list of Polygon
        Same buffered polygons used to filter columns.
    max_bay : float
        Used to set the adjacency cut-off
        (``max_bay * BEAM_ADJACENCY_FACTOR``) and the overlength
        warning threshold (``max_bay * BEAM_OVERLENGTH_WARN_FACTOR``).
    id_prefix : str
        Stable prefix for derived beam ids (typically the strategy
        key) so beam ids are deterministic and distinct across schemes.

    Returns
    -------
    (beams, warnings)
        ``beams`` is a list of dicts ready to wrap in :class:`Beam`.
        ``warnings`` lists span-overlength messages.
    """
    if not columns or not levels:
        return [], []

    adjacency_limit = max_bay * BEAM_ADJACENCY_FACTOR
    over_limit = max_bay * BEAM_OVERLENGTH_WARN_FACTOR

    levels_sorted = sorted(levels, key=lambda l: l.get("elevation", 0.0))
    level_index = {lvl["id"]: i for i, lvl in enumerate(levels_sorted)}

    beams: list[dict] = []
    warnings: list[str] = []
    seen: set[tuple[int, str]] = set()

    for level in levels_sorted:
        level_id = level["id"]
        active = _columns_present_at(columns, level_id, level_index)
        if len(active) < 2:
            continue

        edges = _grid_neighbour_edges(active, adjacency_limit)
        for (a, b) in edges:
            line = LineString([(a["x"], a["y"]), (b["x"], b["y"])])
            if any(line.crosses(z) or line.within(z) for z in exclusion_zones):
                continue
            # Stable ordering of endpoints so duplicate detection is
            # direction-insensitive.
            (sx, sy), (ex, ey) = sorted(
                ((a["x"], a["y"]), (b["x"], b["y"]))
            )
            key = (round(sx, 4), round(sy, 4), round(ex, 4), round(ey, 4), level_id)
            if key in seen:
                continue
            seen.add(key)

            span = ((ex - sx) ** 2 + (ey - sy) ** 2) ** 0.5
            if span < EDGE_TOLERANCE:
                continue

            beam_id = _stable_beam_id(id_prefix, level_id, sx, sy, ex, ey)
            beams.append(
                {
                    "id": beam_id,
                    "start": {"x": sx, "y": sy},
                    "end": {"x": ex, "y": ey},
                    "level_id": level_id,
                    "span": round(span, 3),
                }
            )
            if span > over_limit:
                warnings.append(
                    f"Beam {beam_id} on {level_id} spans {span:.1f} ft — "
                    f"exceeds typical max bay ({max_bay:.1f} ft)."
                )

    return beams, warnings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _columns_present_at(
    columns: list[dict],
    level_id: str,
    level_index: dict[str, int],
) -> list[dict]:
    """A column is present at a level if the level's index falls
    between its start and end (inclusive)."""
    target = level_index.get(level_id)
    if target is None:
        return []
    out: list[dict] = []
    for col in columns:
        s = level_index.get(col.get("start_level"))
        e = level_index.get(col.get("end_level"))
        if s is None or e is None:
            continue
        lo, hi = (s, e) if s <= e else (e, s)
        if lo <= target <= hi:
            out.append(col)
    return out


def _grid_neighbour_edges(
    columns: list[dict],
    adjacency_limit: float,
) -> list[tuple[dict, dict]]:
    """Connect each column to its nearest horizontal neighbour (same y)
    and nearest vertical neighbour (same x), within
    ``adjacency_limit``.

    "Same y" is fuzzy — we group columns into rows whose y-coordinates
    are within :data:`EDGE_TOLERANCE`. Same for columns/x.
    """
    edges: list[tuple[dict, dict]] = []
    if len(columns) < 2:
        return edges

    rows = _group_by_axis(columns, axis="y")
    for row in rows.values():
        row.sort(key=lambda c: c["x"])
        for i in range(len(row) - 1):
            a, b = row[i], row[i + 1]
            if abs(b["x"] - a["x"]) <= adjacency_limit + EDGE_TOLERANCE:
                edges.append((a, b))

    cols = _group_by_axis(columns, axis="x")
    for col_group in cols.values():
        col_group.sort(key=lambda c: c["y"])
        for i in range(len(col_group) - 1):
            a, b = col_group[i], col_group[i + 1]
            if abs(b["y"] - a["y"]) <= adjacency_limit + EDGE_TOLERANCE:
                edges.append((a, b))

    return edges


def _group_by_axis(columns: list[dict], axis: str) -> dict[float, list[dict]]:
    """Group columns by an axis coordinate, fuzzy-equating values within
    :data:`EDGE_TOLERANCE`. Returns ``{round_key: [cols]}``.
    """
    key = "y" if axis == "y" else "x"
    keys: list[float] = []
    groups: dict[float, list[dict]] = {}

    for col in columns:
        v = float(col[key])
        match = next(
            (k for k in keys if abs(k - v) <= EDGE_TOLERANCE),
            None,
        )
        if match is None:
            keys.append(v)
            groups[v] = [col]
        else:
            groups[match].append(col)
    return groups


def _stable_beam_id(prefix: str, level_id: str, sx: float, sy: float, ex: float, ey: float) -> str:
    """Deterministic beam id from endpoints + level + strategy prefix."""
    import hashlib

    raw = f"{prefix}|{level_id}|{sx:.3f},{sy:.3f}|{ex:.3f},{ey:.3f}"
    h = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    return f"B-{h}"


__all__ = ["generate_beams"]
